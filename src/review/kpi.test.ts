import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../db/store.js';
import type { AnswerKey } from '../engine/governance/index.js';
import type { Status, TestVerdict } from '../results/verdict.js';
import type { StoredVerdict } from './cards.js';
import { activeReviewTime, compareWithKey, type KpiBaseline, KpiBaselineSchema, kpiText, kpiTotal, matchModule, runKpiOf } from './kpi.js';

/**
 * E0.19 step 1: the review KPIs of a run, at run time, against one frozen baseline with fixed denominators. A person's work is what is
 * counted: cases set aside, questions (one per card), reviews per 100 written steps, flaky cases, wrong PASS / FAIL, review time.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const verdict = (testId: string, status: Status, over: Partial<TestVerdict> = {}): StoredVerdict => ({
  testId,
  status,
  verdict: {
    executionId: 'EXEC-1',
    testId,
    title: testId,
    automationId: testId,
    status,
    reason: status === 'NEEDS REVIEW' ? 'E1 "Saved message is shown" is unproven' : '',
    expected: 'Saved message is shown',
    actual: 'the page showed nothing',
    steps: [
      { id: 'S1', raw: 'Click Save', result: 'passed' },
      { id: 'S2', raw: 'Click Close', result: 'passed' },
    ],
    checks: [
      {
        id: 'E1',
        raw: 'Saved message is shown',
        expected: 'Saved message is shown',
        actual: 'the page showed nothing',
        result: status === 'PASS' ? 'passed' : 'not verified',
      },
    ],
    durationMs: 10,
    evidence: { screenshots: ['a.png'] },
    ...over,
  },
});

const baseline: KpiBaseline = {
  version: 'test',
  frozenOn: '2026-11-08',
  modules: {
    shop: {
      label: 'Shop',
      workbook: 'shop.xlsx',
      engine: 'legacy',
      testCases: 4,
      steps: 20,
      caseIds: ['T1', 'T2', 'T3', 'T4'],
      setAside: 4,
      questions: 4,
      statuses: {},
    },
  },
};

describe('review KPIs at run time (E0.19 step 1)', () => {
  it('the frozen baseline file is valid and holds the legacy numbers', () => {
    const b = KpiBaselineSchema.parse(JSON.parse(readFileSync(path.join(root, 'test/baseline/kpi-baseline.json'), 'utf8')));
    assert.equal(b.modules['orangehrm-add-employee']?.setAside, 19);
    assert.equal(b.modules['orangehrm-add-employee']?.steps, 181);
    assert.equal(b.modules['orangehrm-login']?.testCases, 10);
  });

  it('cases with one cause are one question; a run is matched to its baseline by its test case ids', () => {
    const rows = [verdict('T1', 'NEEDS REVIEW'), verdict('T2', 'NEEDS REVIEW'), verdict('T3', 'PASS'), verdict('T4', 'FAIL')];
    const k = runKpiOf({ run: 'r1', rows, baseline });
    assert.equal(k.module, 'shop');
    assert.equal(k.setAside, 2);
    assert.equal(k.questions, 1);
    assert.deepEqual(k.vsBaseline?.questions, { before: 4, after: 1, reduction: 0.75 });
  });

  it('the rate uses the steps as written (fixed), not the steps that happened to run', () => {
    const rows = [verdict('T1', 'NEEDS REVIEW', { steps: [] }), verdict('T2', 'PASS', { steps: [] })];
    const k = runKpiOf({ run: 'r', rows, baseline });
    assert.equal(k.stepsRun, 0);
    assert.deepEqual(k.denominator, { testCases: 4, steps: 20, fixed: true });
    assert.equal(k.reviewsPer100Steps, 5);
  });

  it('a BLOCKED case is set aside for a person; a flaky case is counted and is not a PASS', () => {
    const rows = [verdict('T1', 'BLOCKED'), verdict('T2', 'NEEDS REVIEW', { label: 'flaky', reason: 'passed only on retry' })];
    const k = runKpiOf({ run: 'r', rows, baseline });
    assert.equal(k.setAside, 2);
    assert.equal(k.flaky, 1);
    assert.equal(k.flakeRate, 0.25);
    assert.equal(k.statuses.PASS, 0);
  });

  it('a run that is mostly not in the baseline is shown without a comparison', () => {
    const k = runKpiOf({ run: 'r', rows: [verdict('X1', 'NEEDS REVIEW'), verdict('X2', 'PASS'), verdict('T1', 'PASS')], baseline });
    assert.equal(k.module, undefined);
    assert.equal(k.vsBaseline, undefined);
    assert.equal(k.denominator.fixed, false);
    assert.equal(matchModule(baseline, ['T1', 'X1']), 'shop');
  });

  it('wrong PASS is a PASS the key says is anything else; wrong FAIL is a FAIL the key says is PASS', () => {
    const key: AnswerKey = {
      checkedBy: 'test',
      checkedOn: '2026-11-08',
      signedOff: false,
      cases: [
        { id: 'T1', module: 'shop', expected: 'NEEDS_REVIEW' },
        { id: 'T2', module: 'shop', expected: 'PASS' },
        { id: 'T3', module: 'shop', expected: 'NEEDS_REVIEW' },
      ],
    };
    const r = compareWithKey(key, [verdict('T1', 'PASS'), verdict('T2', 'FAIL'), verdict('T3', 'NEEDS REVIEW'), verdict('T9', 'PASS')]);
    assert.deepEqual(r.wrongPass, ['T1']);
    assert.deepEqual(r.wrongFail, ['T2']);
    assert.equal(r.matched, 1);
    assert.deepEqual(r.notInKey, ['T9']);
  });

  it('review time counts the time to each decision, and a long pause is time away', () => {
    const t = (min: number) => new Date(Date.UTC(2026, 10, 8, 10, min)).toISOString();
    const r = activeReviewTime({ views: [t(0), t(30)], decisions: [t(1), t(3), t(25), t(32)] });
    // 0→1 (1 min), 1→3 (2 min), 3→25 is a pause, 30 (view)→32 (2 min).
    assert.equal(r.decisions, 4);
    assert.equal(r.activeMs, 5 * 60_000);
    assert.equal(r.perDecisionMs, 75_000);
  });

  it('the store gives the times a person opened a review and decided', async () => {
    const store = await Store.open(path.join(await mkdtemp(path.join(tmpdir(), 'aq-kpi-')), 'kpi.db'));
    try {
      await store.audit('review.view', 'job', 'JOB-1', undefined, { cards: 2 });
      await store.audit('review.view', 'job', 'JOB-2', undefined, { cards: 1 });
      const a = await store.reviewActivity('JOB-1');
      assert.equal(a.views.length, 1);
      assert.deepEqual(a.decisions, []);
    } finally {
      await store.close();
    }
  });

  it('the total adds up the matched runs, and the report says whether the owner’s bar is met', () => {
    const k = runKpiOf({ run: 'r', rows: [verdict('T1', 'NEEDS REVIEW'), verdict('T2', 'PASS'), verdict('T3', 'PASS'), verdict('T4', 'PASS')], baseline });
    assert.deepEqual(kpiTotal([k])?.questions, { before: 4, after: 1, reduction: 0.75 });
    const text = kpiText([k], baseline);
    assert.ok(text.includes('Questions to answer:    1   (baseline 4, −75%)'));
    assert.ok(text.includes('not met yet'));
    assert.ok(text.includes('wrong PASS not measured'));
  });
});
