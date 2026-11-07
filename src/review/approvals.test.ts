import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '../db/store.js';
import { learnedForRun } from '../learning/adapter.js';
import { LearningService } from '../learning/service.js';
import type { TestVerdict } from '../results/verdict.js';
import { ReviewService } from './service.js';

/**
 * E0.18 step 5: a person's decision on a review card is what the next run reads for the same checks (`Store.decidedChecks`), with who
 * and when; the latest decision wins; and changing a PASS to FAIL takes back what the PASS kept for its screen.
 */

const PICK = { step: 'S7', word: 'Edit', means: 'Edit', screen: '/emp', element: '|/edit-1', why: '2 buttons called "Edit" are alike' };
const open = (testId: string, fingerprint: string, picks = false): TestVerdict => ({
  executionId: '',
  testId,
  title: testId,
  automationId: testId,
  status: 'NEEDS REVIEW',
  label: 'inconclusive',
  reason: 'E1 is unproven: nothing on the page shows which page this is',
  expected: 'Profile is the default page',
  actual: 'no menu item called "Profile" on the page',
  steps: [{ id: 'S4', raw: 'Click Login', result: 'passed' }],
  checks: [{ id: 'E1', raw: 'Profile is the default page', expected: 'x', actual: 'no menu item called "Profile"', result: 'not verified' }],
  durationMs: 10,
  evidence: { screenshots: ['/runs/after.png'] },
  approvals: [{ check: 'E1', clause: 'Profile is the default page', fingerprint }],
  ...(picks ? { picks: [PICK] } : {}),
});

async function setup(verdict: TestVerdict) {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-approvals-')), 'a.db');
  const store = await Store.open(file);
  await store.createProject({
    id: 'p',
    name: 'p',
    baseUrl: 'http://127.0.0.1:1',
    testIdAttribute: 'data-testid',
    browser: 'chromium',
    workspace: path.join(tmpdir(), 'p'),
  });
  const learning = new LearningService(store);
  const service = new ReviewService(store, {
    remember: (projectId, pick, source, who) =>
      learning.saveLabel(projectId, { label: pick.word, means: pick.means, screen: pick.screen, element: pick.element }, source, who, { seenOnScreen: true }),
    forget: async (projectId, source, who) => {
      for (const e of await store.learnedEntries(projectId, { kind: 'label', status: 'active' }))
        if (e.source.startsWith(source)) await learning.disable(projectId, e.id, who, 'the PASS that kept it was changed to FAIL');
    },
  });
  const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
  await store.saveVerdicts(job.id, [{ testId: verdict.testId, row: 2, status: verdict.status, verdict }]);
  const card = (await service.cards(job.id))[0];
  assert.ok(card);
  return { store, service, jobId: job.id, cardId: card.id };
}

describe('E0.18 step 5: decisions the next run reads', () => {
  it('a PASS on the card is the decision of each check fingerprint of the case, with who and when', async () => {
    const { store, service, jobId, cardId } = await setup(open('TC-1', 'fp-1'));
    await service.decide(jobId, cardId, { decision: 'PASS', who: 'Owner' });
    const decided = await store.decidedChecks('p');
    assert.equal(decided.length, 1);
    assert.equal(decided[0]?.fingerprint, 'fp-1');
    assert.equal(decided[0]?.decision, 'PASS');
    assert.equal(decided[0]?.who, 'Owner');
  });

  it('changed to FAIL: the FAIL is what the next run reads, and what the PASS kept for its screen is switched off', async () => {
    const { store, service, jobId, cardId } = await setup(open('TC-2', 'fp-2', true));
    await service.decide(jobId, cardId, { decision: 'PASS', who: 'Owner' });
    assert.equal((await learnedForRun(store, 'p')).screenLabels.length, 1, 'the PASS kept the chosen Edit button');
    const changed = await service.decide(jobId, cardId, { decision: 'FAIL', who: 'Owner', note: 'it was the wrong Edit button' });
    assert.equal(changed.results[0]?.outcome, 'replaced');
    assert.deepEqual(
      (await store.decidedChecks('p')).map((d) => d.decision),
      ['FAIL'],
    );
    assert.equal((await learnedForRun(store, 'p')).screenLabels.length, 0, 'the kept element was taken back');
  });

  it('a case without fingerprints (from before E0.18) gives the next run nothing to read', async () => {
    const { approvals: _none, ...old } = open('TC-3', 'unused');
    const { store, service, jobId, cardId } = await setup(old);
    await service.decide(jobId, cardId, { decision: 'PASS', who: 'Owner' });
    assert.deepEqual(await store.decidedChecks('p'), []);
  });
});

describe('E0.18 step 7: the review card says why, and that a decision is remembered', () => {
  it('the card carries the label with its meaning, and how many checks a decision covers for the next run', async () => {
    const { service, jobId } = await setup(open('TC-4', 'fp-4'));
    const card = (await service.cards(jobId))[0];
    assert.equal(card?.label?.name, 'inconclusive');
    assert.ok(card?.label?.meaning.includes('could not be proven'), card?.label?.meaning);
    assert.equal(card?.remembers, 1);
  });
});
