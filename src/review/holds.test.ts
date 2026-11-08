import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '../db/store.js';
import type { Status, TestVerdict } from '../results/verdict.js';
import { HoldRefused, HoldService, inForce, isOverdue } from './holds.js';
import { runKpiOf } from './kpi.js';
import { ReviewService } from './service.js';

/**
 * E0.19 step 7, the holding area: only a flaky case is held, by an owner, for 1 to 30 days. A held case still runs and is listed, is not
 * a question while held, and comes back by itself, marked overdue, when its day passes.
 */

const verdict = (testId: string, status: string, label?: 'flaky'): TestVerdict =>
  ({
    executionId: 'E',
    testId,
    title: testId,
    automationId: testId,
    status: status as Status,
    ...(label ? { label } : {}),
    reason: label ? 'passed only on retry' : 'E1 "Saved is shown" is unproven',
    review: [
      {
        id: 'E1',
        raw: label ? 'Saved is shown (passed only on retry)' : 'Saved is shown',
        headline: '',
        why: label ? 'it passed only on retry' : 'unproven',
        todo: [],
      },
    ],
    expected: 'Saved is shown',
    actual: 'Saved',
    steps: [{ id: 'S1', raw: 'Click Save', result: 'passed' }],
    checks: [],
    durationMs: 1,
    evidence: { screenshots: ['a.png'] },
  }) as TestVerdict;

async function setup() {
  const store = await Store.open(path.join(await mkdtemp(path.join(tmpdir(), 'aq-hold-')), 'hold.db'));
  await store.createProject({
    id: 'p',
    name: 'p',
    baseUrl: 'http://127.0.0.1:1',
    testIdAttribute: 'data-testid',
    browser: 'chromium',
    workspace: path.join(tmpdir(), 'p'),
  });
  const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
  await store.saveVerdicts(job.id, [
    { testId: 'TC1', status: 'NEEDS REVIEW', verdict: verdict('TC1', 'NEEDS REVIEW', 'flaky') },
    { testId: 'TC2', status: 'NEEDS REVIEW', verdict: verdict('TC2', 'NEEDS REVIEW') },
    { testId: 'TC3', status: 'FAIL', verdict: verdict('TC3', 'FAIL') },
  ]);
  return { store, jobId: job.id, holds: new HoldService(store) };
}

describe('the holding area for flaky cases (E0.19 step 7)', () => {
  it('only a flaky case is held, by an owner, with a reason, for 1 to 30 days', async () => {
    const { store, jobId, holds } = await setup();
    try {
      await assert.rejects(holds.hold(jobId, 'TC2', { owner: 'Asha', reason: 'slow save' }), HoldRefused, 'not flaky');
      await assert.rejects(holds.hold(jobId, 'TC3', { owner: 'Asha', reason: 'slow save' }), HoldRefused, 'a FAIL is not held');
      await assert.rejects(holds.hold(jobId, 'TC1', { owner: '', reason: 'slow save' }), HoldRefused);
      await assert.rejects(holds.hold(jobId, 'TC1', { owner: 'Asha', reason: 'x' }), HoldRefused);
      await assert.rejects(holds.hold(jobId, 'TC1', { owner: 'Asha', reason: 'slow save', days: 31 }), HoldRefused);
      const at = new Date('2026-11-08T10:00:00Z');
      const h = await holds.hold(jobId, 'TC1', { owner: 'Asha', reason: 'slow save', days: 7, who: 'Ravi' }, at);
      assert.equal(h.until, '2026-11-15T10:00:00.000Z');
      assert.equal(h.heldBy, 'Ravi');
      assert.equal((await holds.list('p')).length, 1);
    } finally {
      await store.close();
    }
  });

  it('a held case is shown apart and is not a question; when its day passes it is a question again, marked overdue', async () => {
    const { store, jobId, holds } = await setup();
    try {
      const h = await holds.hold(jobId, 'TC1', { owner: 'Asha', reason: 'slow save', days: 7 });
      const review = new ReviewService(store);
      const cards = await review.cards(jobId);
      const held = cards.find((c) => c.cases.some((x) => x.testId === 'TC1'));
      assert.equal(held?.held, true);
      assert.equal(held?.cases[0]?.held?.owner, 'Asha');
      assert.equal(cards[cards.length - 1], held, 'held cards come last');

      const rows = (await store.verdicts(jobId)).map((r) => ({ ...r, verdict: r.verdict as TestVerdict }));
      const now = runKpiOf({ run: 'r', rows, held: new Map([...inForce([h])].map(([id, x]) => [id, { owner: x.owner, until: x.until }])) });
      assert.equal(now.questions, 1);
      assert.equal(now.setAside, 1);
      assert.deepEqual(
        now.held?.map((x) => x.testId),
        ['TC1'],
      );
      assert.equal(now.statuses['NEEDS REVIEW'], 2, 'a held case still ran and is counted in the statuses');

      const later = new Date(Date.parse(h.until) + 1000);
      assert.equal(isOverdue(h, later), true);
      assert.equal(inForce([h], later).size, 0);
      assert.equal(runKpiOf({ run: 'r', rows, held: inForce([h], later) }).questions, 2);
    } finally {
      await store.close();
    }
  });

  it('releasing keeps the hold with who and why; holding again replaces the current hold', async () => {
    const { store, jobId, holds } = await setup();
    try {
      await holds.hold(jobId, 'TC1', { owner: 'Asha', reason: 'slow save' });
      await holds.hold(jobId, 'TC1', { owner: 'Ravi', reason: 'still slow' });
      assert.deepEqual(
        (await holds.list('p')).map((h) => h.owner),
        ['Ravi'],
      );
      const released = await holds.release('p', 'TC1', { note: 'fixed the wait', who: 'Ravi' });
      assert.equal(released.status, 'released');
      assert.equal(released.releaseNote, 'fixed the wait');
      assert.deepEqual(await holds.list('p'), []);
      assert.equal((await holds.list('p', true)).length, 2);
      await assert.rejects(holds.release('p', 'TC1', {}), HoldRefused);
    } finally {
      await store.close();
    }
  });
});
