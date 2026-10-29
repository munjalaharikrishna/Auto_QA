import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '../db/store.js';
import { learnedForRun } from '../learning/adapter.js';
import { LearningService } from '../learning/service.js';
import type { CheckVerdict, StepVerdict, TestVerdict } from '../results/verdict.js';
import { buildReviewCards, eligibility, evidenceHash, evidenceOf } from './cards.js';
import { ReviewRefused, ReviewService } from './service.js';

/**
 * VD-11, DEC-05: a person's PASS or FAIL on a case the engine could not decide. It is stored with who and when and the evidence the
 * person was shown; it never changes the engine's verdict; the same click twice is one decision; a different one replaces it, with a
 * reason, and the first stays as history; and a PASS needs a finished run with something to look at.
 */

const step = (id: string, result: StepVerdict['result'] = 'passed'): StepVerdict => ({ id, raw: `step ${id}`, result });
const check = (id: string, result: CheckVerdict['result'], actual = 'the page showed "Account locked"'): CheckVerdict => ({
  id,
  raw: 'Error "Invalid credentials" is shown',
  expected: 'Error "Invalid credentials" is shown',
  actual,
  result,
});

/** A case the engine could not prove: its steps ran, one check is not verified, and there are two pictures. */
const unproven = (testId: string, over: Partial<TestVerdict> = {}): TestVerdict => ({
  executionId: '',
  testId,
  title: testId,
  automationId: testId,
  status: 'NEEDS REVIEW',
  reason: 'The page showed a message, but not the one expected.',
  review: [
    {
      id: 'A1',
      raw: 'Error "Invalid credentials" is shown',
      headline: 'I cannot verify the check.',
      why: 'The page showed different text.',
      todo: ['Decide on the card.'],
    },
  ],
  expected: 'Error "Invalid credentials" is shown',
  actual: 'the page showed "Account locked"',
  steps: [step('S1'), step('S2')],
  checks: [check('A1', 'not verified')],
  durationMs: 10,
  evidence: { screenshots: ['/runs/before.png', '/runs/after.png'] },
  ...over,
});

async function setup(): Promise<{ store: Store; service: ReviewService; jobId: string; reopen: () => Promise<Store>; file: string }> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-review-')), 'review.db');
  const store = await Store.open(file);
  await store.createProject({
    id: 'p',
    name: 'p',
    baseUrl: 'http://127.0.0.1:1',
    testIdAttribute: 'data-testid',
    browser: 'chromium',
    workspace: path.join(tmpdir(), 'p'),
  });
  const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
  return { store, service: new ReviewService(store), jobId: job.id, reopen: () => Store.open(file), file };
}

const seed = async (store: Store, jobId: string, rows: Array<{ testId: string; status?: string; verdict?: TestVerdict }>): Promise<void> => {
  await store.saveVerdicts(
    jobId,
    rows.map((r, i) => ({ testId: r.testId, row: i + 2, status: r.status ?? 'NEEDS REVIEW', verdict: r.verdict ?? unproven(r.testId) })),
  );
};

const refuses = (text: string) => (e: unknown) => e instanceof ReviewRefused && e.message.includes(text);

describe('the review cards of a job', () => {
  it("puts the cases that share one cause on one card, and the others on their own; the engine's own verdicts have none", async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [
      { testId: 'TC-1' },
      { testId: 'TC-2' },
      { testId: 'TC-3', verdict: unproven('TC-3', { actual: 'something else', checks: [check('A1', 'not verified', 'something else')] }) },
      { testId: 'TC-4', status: 'PASS', verdict: unproven('TC-4', { status: 'PASS' }) },
      { testId: 'TC-5', status: 'FAIL', verdict: unproven('TC-5', { status: 'FAIL' }) },
      { testId: 'TC-6', status: 'BLOCKED', verdict: unproven('TC-6', { status: 'BLOCKED' }) },
    ]);
    const cards = await service.cards(jobId);
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards[0]?.cases.map((c) => c.testId),
      ['TC-1', 'TC-2'],
    );
    assert.deepEqual(
      cards[1]?.cases.map((c) => c.testId),
      ['TC-3'],
    );
    assert.ok(cards.every((c) => c.cases.every((x) => x.decision === undefined)) && cards.every((c) => !c.decided));
    assert.equal(cards[0]?.before, '/runs/before.png');
    assert.equal(cards[0]?.after, '/runs/after.png');
    assert.equal(cards[0]?.expected, 'Error "Invalid credentials" is shown');
    assert.equal(cards[0]?.actual, 'the page showed "Account locked"');
    await store.close();
  });

  it('a case with unfinished steps, a failed check, or nothing to look at cannot be passed by a click; a FAIL always can be given', () => {
    assert.deepEqual(eligibility('NEEDS REVIEW', unproven('T')), { decidable: true, canPass: true });
    const stopped = eligibility('NEEDS REVIEW', unproven('T', { steps: [step('S1'), step('S2', 'failed'), step('S3', 'not run')] }));
    assert.equal(stopped.decidable, true);
    assert.equal(stopped.canPass, false);
    assert.ok(stopped.passRefusal?.includes('did not finish') && stopped.passRefusal.includes('S2'));
    const wrong = eligibility('NOT VERIFIED', unproven('T', { checks: [check('A1', 'failed'), check('A2', 'not verified')] }));
    assert.equal(wrong.canPass, false);
    assert.ok(wrong.passRefusal?.includes('A1'));
    const nothing = eligibility('NEEDS REVIEW', unproven('T', { evidence: { screenshots: [] }, checks: [check('A1', 'not verified', '')], actual: '' }));
    assert.equal(nothing.canPass, false);
    assert.ok(nothing.passRefusal?.includes('no picture'));
    for (const status of ['PASS', 'FAIL', 'BLOCKED']) assert.equal(eligibility(status, unproven('T')).decidable, false, status);
  });

  it('what a person is shown is a hash that changes when any of it does', () => {
    const e = evidenceOf('NEEDS REVIEW', unproven('T'));
    assert.equal(evidenceHash(e), evidenceHash(evidenceOf('NEEDS REVIEW', unproven('T'))));
    assert.notEqual(evidenceHash(e), evidenceHash({ ...e, actual: 'another page' }));
    assert.deepEqual(buildReviewCards([], new Map()), []);
  });
});

describe('deciding a card', () => {
  it("stores a decision for every case of the card, with the reviewer, the time of the server, the engine's status and the evidence shown", async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }, { testId: 'TC-2' }]);
    const card = (await service.cards(jobId))[0];
    assert.ok(card);
    const before = Date.now();
    const done = await service.decide(jobId, card.id, {
      decision: 'PASS',
      who: '  Asha Rao  ',
      note: 'I looked at the page: it is the locked-account message, which is right for this account',
    });
    assert.deepEqual(
      done.results.map((r) => [r.testId, r.outcome]),
      [
        ['TC-1', 'recorded'],
        ['TC-2', 'recorded'],
      ],
    );
    const stored = await store.reviewDecisions(jobId);
    assert.equal(stored.length, 2);
    for (const d of stored) {
      assert.equal(d.reviewer, 'Asha Rao', 'the name is trimmed');
      assert.equal(d.decision, 'PASS');
      assert.equal(d.engineStatus, 'NEEDS REVIEW');
      assert.equal(d.evidenceSha256, evidenceHash(card.cases[0]?.evidence as never), 'the hash is of what the person was shown');
      assert.ok(Date.parse(d.decidedAt) >= before - 1000 && Date.parse(d.decidedAt) <= Date.now() + 1000, `decided at ${d.decidedAt}`);
    }
    assert.equal((await service.cards(jobId))[0]?.decided, true);
    await store.close();
  });

  it("never changes the result the decision is about: the engine's status, reason and evidence stay as they were", async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }]);
    const before = JSON.stringify(await store.verdicts(jobId));
    const card = (await service.cards(jobId))[0];
    await service.decide(jobId, card?.id as string, { decision: 'PASS', note: 'looked' });
    await service.decide(jobId, card?.id as string, { decision: 'FAIL', note: 'looked again: it is a bug' });
    assert.equal(JSON.stringify(await store.verdicts(jobId)), before);
    const [row] = await store.verdicts(jobId);
    assert.equal(row?.status, 'NEEDS REVIEW', "a decision by a person is not the engine's PASS");
    await store.close();
  });

  it('is not an approval and not a learned rule: it makes nothing the engine reads on a later run', async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }]);
    const card = (await service.cards(jobId))[0];
    await service.decide(jobId, card?.id as string, { decision: 'PASS', note: 'fine' });
    assert.deepEqual(await store.learnedEntries('p'), []);
    const run = await learnedForRun(store, 'p');
    assert.equal(run.approvedAssumptions.size, 0);
    assert.deepEqual(run.rules, { step: {}, check: {}, element: {} });
    await store.close();
  });

  it('refuses a PASS for a case that did not finish, and gives the others of the card their decision', async () => {
    const { store, service, jobId } = await setup();
    const stopped = unproven('TC-2', { steps: [step('S1'), step('S2', 'failed')] });
    await seed(store, jobId, [{ testId: 'TC-1' }, { testId: 'TC-2', verdict: stopped }]);
    const cards = await service.cards(jobId);
    const card = cards.find((c) => c.cases.some((x) => x.testId === 'TC-2'));
    assert.ok(card);
    const result = await service.decide(jobId, card.id, { decision: 'PASS', note: 'ok' });
    const byCase = Object.fromEntries(result.results.map((r) => [r.testId, r]));
    assert.equal(byCase['TC-2']?.outcome, 'refused');
    assert.ok(byCase['TC-2']?.reason?.includes('did not finish'));
    assert.equal(
      (await store.reviewDecisions(jobId)).some((d) => d.testId === 'TC-2'),
      false,
      'nothing is stored for the refused case',
    );
    const failed = await service.decide(jobId, card.id, { decision: 'FAIL', note: 'it did not finish' });
    assert.ok(
      failed.results.every((r) => r.outcome === 'recorded' || r.outcome === 'duplicate' || r.outcome === 'replaced'),
      'a FAIL is always allowed',
    );
    await store.close();
  });

  it('checks the card, the decision and the reviewer', async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }]);
    const id = (await service.cards(jobId))[0]?.id as string;
    await assert.rejects(() => service.decide(jobId, 'no-such-card', { decision: 'PASS' }), refuses('no such card'));
    await assert.rejects(() => service.decide('no-such-job', id, { decision: 'PASS' }), refuses('no such job'));
    for (const bad of ['pass', 'MAYBE', '', undefined, 1, null])
      await assert.rejects(() => service.decide(jobId, id, { decision: bad }), refuses('PASS or FAIL'));
    for (const who of ['   ', 'x'.repeat(81), 'bad\u0000name', 'line\nbreak', 7, {}])
      await assert.rejects(
        () => service.decide(jobId, id, { decision: 'FAIL', who }),
        (e: unknown) => e instanceof ReviewRefused,
      );
    await assert.rejects(() => service.decide(jobId, id, { decision: 'FAIL', note: 'x'.repeat(1001) }), refuses('note'));
    await assert.rejects(() => service.decide(jobId, id, { decision: 'FAIL', note: 5 }), refuses('note'));
    assert.equal((await store.reviewDecisions(jobId)).length, 0, 'nothing was stored by any of them');
    const done = await service.decide(jobId, id, { decision: 'FAIL' });
    assert.equal((await store.reviewDecisions(jobId))[0]?.reviewer, 'Owner', 'without a name, the user of the platform');
    assert.equal(done.results[0]?.outcome, 'recorded');
    await store.close();
  });
});

describe('the same decision twice, and a changed decision', () => {
  it('the same decision again is one decision: nothing is added and who and when stay with the first', async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }]);
    const id = (await service.cards(jobId))[0]?.id as string;
    const first = await service.decide(jobId, id, { decision: 'PASS', who: 'Asha', note: 'first' });
    const [stored] = await store.reviewDecisions(jobId);
    const second = await service.decide(jobId, id, { decision: 'PASS', who: 'Ben', note: 'second' });
    assert.equal(second.results[0]?.outcome, 'duplicate');
    assert.equal(second.results[0]?.id, first.results[0]?.id);
    const all = await store.reviewDecisions(jobId, { history: true });
    assert.equal(all.length, 1);
    assert.deepEqual([all[0]?.reviewer, all[0]?.note, all[0]?.decidedAt], [stored?.reviewer, stored?.note, stored?.decidedAt]);
    await store.close();
  });

  it('a different decision needs a reason, replaces the current one, and keeps the first as history', async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }]);
    const id = (await service.cards(jobId))[0]?.id as string;
    await service.decide(jobId, id, { decision: 'PASS', who: 'Asha', note: 'looks right' });
    const refused = await service.decide(jobId, id, { decision: 'FAIL', who: 'Ben' });
    assert.equal(refused.results[0]?.outcome, 'refused');
    assert.ok(refused.results[0]?.reason?.includes('reason'));
    assert.equal((await store.reviewDecisions(jobId))[0]?.decision, 'PASS', 'still the first');
    const changed = await service.decide(jobId, id, { decision: 'FAIL', who: 'Ben', note: 'on the second look the message is wrong' });
    assert.equal(changed.results[0]?.outcome, 'replaced');
    const current = await store.reviewDecisions(jobId);
    assert.deepEqual(
      current.map((d) => [d.decision, d.reviewer]),
      [['FAIL', 'Ben']],
    );
    const history = await service.history(jobId);
    assert.deepEqual(
      history.map((d) => [d.decision, d.reviewer, d.status]),
      [
        ['PASS', 'Asha', 'superseded'],
        ['FAIL', 'Ben', 'current'],
      ],
    );
    assert.equal(history[1]?.supersedes, history[0]?.id, 'the new decision says which one it replaced');
    const audit = (await store.auditLog('p')).map((a) => a.action);
    assert.ok(audit.includes('review.decide') && audit.includes('review.replace'));
    await store.close();
  });

  it('two identical clicks at once make one decision; a PASS and a FAIL at once leave exactly one current', async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }, { testId: 'TC-2' }]);
    const id = (await service.cards(jobId))[0]?.id as string;
    const twice = await Promise.all([
      service.decide(jobId, id, { decision: 'PASS', who: 'A', note: 'x' }),
      service.decide(jobId, id, { decision: 'PASS', who: 'B', note: 'y' }),
    ]);
    const outcomes = twice.flatMap((t) => t.results.map((r) => r.outcome)).sort();
    assert.deepEqual(outcomes, ['duplicate', 'duplicate', 'recorded', 'recorded'], 'one decision per case, and one of the clicks is the duplicate for each');
    assert.equal((await store.reviewDecisions(jobId)).length, 2);

    const other = await setup();
    await seed(other.store, other.jobId, [{ testId: 'TC-1' }]);
    const otherId = (await other.service.cards(other.jobId))[0]?.id as string;
    const split = await Promise.all([
      other.service.decide(other.jobId, otherId, { decision: 'PASS' }),
      other.service.decide(other.jobId, otherId, { decision: 'FAIL' }),
    ]);
    const kinds = split.map((s) => s.results[0]?.outcome).sort();
    assert.deepEqual(kinds, ['recorded', 'refused'], 'the second to arrive cannot change the first without a reason');
    assert.equal((await other.store.reviewDecisions(other.jobId)).length, 1);
    await store.close();
    await other.store.close();
  });
});

describe('persistence and the platform around it', () => {
  it('decisions are there when the database is opened again, with the same ids and times', async () => {
    const { store, service, jobId, reopen } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }]);
    const id = (await service.cards(jobId))[0]?.id as string;
    await service.decide(jobId, id, { decision: 'FAIL', who: 'Asha', note: 'a bug' });
    const before = await store.reviewDecisions(jobId, { history: true });
    await store.close();
    const again = await reopen();
    assert.deepEqual(await again.reviewDecisions(jobId, { history: true }), before);
    const cards = await new ReviewService(again).cards(jobId);
    assert.equal(cards[0]?.cases[0]?.decision?.decision, 'FAIL');
    assert.equal(cards[0]?.decided, true);
    await again.close();
  });

  it('a project with learned entries and decisions can be deleted, and none is left (a foreign key stopped it before)', async () => {
    const { store, service, jobId } = await setup();
    await seed(store, jobId, [{ testId: 'TC-1' }]);
    await service.decide(jobId, (await service.cards(jobId))[0]?.id as string, { decision: 'PASS', note: 'fine' });
    await new LearningService(store).approve('p', 'the error message "X" was learned from the application.', 'test', 'tester');
    const deleted = await store.deleteProject('p');
    assert.ok(deleted, 'the project was there');
    assert.ok(
      deleted.counts.review_decisions === 1 && deleted.counts.learned_entries === 1 && deleted.counts.learned_entry_history === 1,
      JSON.stringify(deleted.counts),
    );
    await store.close();
  });
});
