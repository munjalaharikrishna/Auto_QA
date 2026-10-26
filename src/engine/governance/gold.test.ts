import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { understandCase } from '../language/index.js';
import { type CaseReading, cohenKappa, type GoldSet, GoldSetSchema, goldText, labelAgreement, readingOfLanguage, scoreGold } from './gold.js';

/** The gold interpretation set: its schema, its scorer, and the agreement figure between two labellers. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = (p: string): unknown => JSON.parse(readFileSync(path.join(root, p), 'utf8'));
const set = GoldSetSchema.parse(file('test/gold/demo-login.gold.json'));

async function irsOf(): Promise<Map<string, CaseReading | undefined>> {
  const cases = file('examples/demo-app/test-cases.json') as Array<Record<string, string>>;
  const out = new Map<string, CaseReading | undefined>();
  for (const c of set.cases) {
    const raw = cases.find((x) => x.id === c.id);
    out.set(`${c.module}/${c.id}`, readingOfLanguage(understandCase(raw as never)));
  }
  return out;
}

describe('gold set schema', () => {
  it('needs an action or abstain on every step, and two people for an agreed case', () => {
    const bad = structuredClone(set) as GoldSet;
    delete bad.cases[0]?.gold.steps[0]?.action;
    assert.equal(GoldSetSchema.safeParse(bad).success, false);
    const agreed = structuredClone(set) as GoldSet;
    (agreed.cases[0] as { status: string }).status = 'agreed';
    assert.equal(GoldSetSchema.safeParse(agreed).success, false);
  });
  it('refuses the same case twice', () => {
    assert.equal(GoldSetSchema.safeParse({ ...set, cases: [set.cases[0], set.cases[0]] }).success, false);
  });
});

describe('gold set scoring', () => {
  it('will not score a set nobody checked, unless it is asked for as a draft', async () => {
    assert.throws(
      () => scoreGold(set, new Map()),
      (e: Error) => e.message.includes('nobody checked'),
    );
    assert.doesNotThrow(() => scoreGold(set, new Map(), { allowDraft: true }));
  });
  it('lists a case the engine did not run, and counts a case it produced nothing for as missed', () => {
    const r = scoreGold(set, new Map([['demo-app/TC-DEMO-001', undefined]]), { allowDraft: true });
    assert.deepEqual(r.notRun, ['demo-app/TC-DEMO-002']);
    assert.equal(r.steps.missed, 4);
    assert.equal(r.confidentMistakes, 0);
  });
  it('scores the real engine on the draft set (printed, so a reviewer can see where it stands)', async () => {
    const r = scoreGold(set, await irsOf(), { allowDraft: true });
    console.log(goldText(r));
    assert.equal(r.clauses.length, 12);
  });
  it('a clause the person marked abstain counts against an engine that answers it', async () => {
    const irs = await irsOf();
    const g = structuredClone(set) as GoldSet;
    const step = g.cases[0]?.gold.steps[1];
    assert.ok(step);
    delete step.action;
    step.abstain = true;
    const r = scoreGold(g, irs, { allowDraft: true });
    assert.equal(r.clauses.find((c) => c.original === 'Enter valid username')?.outcome, 'should-abstain-but-answered');
    assert.ok(r.confidentMistakes > 0);
  });
});

describe('agreement between labellers', () => {
  it('kappa is 1 for the same labels, 0 for chance, and refuses different lengths', () => {
    assert.equal(cohenKappa(['a', 'b', 'a'], ['a', 'b', 'a']), 1);
    assert.equal(cohenKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b']), 0);
    assert.throws(() => cohenKappa(['a'], []));
  });
  it('lists the clauses two people labelled differently', () => {
    const c = structuredClone(set.cases[0]) as GoldSet['cases'][number];
    const other = structuredClone(c.gold);
    const s = other.steps[3];
    assert.ok(s);
    s.action = 'SUBMIT';
    c.status = 'reconciled';
    c.labels = { ana: c.gold, ben: other };
    const a = labelAgreement({ ...set, cases: [c] });
    assert.equal(a.disagreements.length, 1);
    assert.deepEqual(a.disagreements[0], { caseId: 'TC-DEMO-001', original: 'Click the Login button', a: 'CLICK', b: 'SUBMIT' });
    assert.ok(a.kappa.action < 1 && a.kappa.expectationType === 1);
  });
});
