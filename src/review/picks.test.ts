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
 * E0.17 item 3: the engine used the first of alike controls, so the case waits for a person. A PASS approves the choice: it is kept as
 * what the word means on that screen (a screen label, as a walkthrough pick is), so the next run uses that element and does not ask.
 * A FAIL keeps nothing.
 */

const PICK = {
  step: 'S7',
  word: 'Edit',
  means: 'Edit',
  screen: '/orangehrm-2.5.0.2/lib/controllers/CentralController.php?capturemode=updatemode&reqcode=EMP',
  element: "rightMenu|//*[@id='btnEditJob']",
  why: '4 buttons called "Edit" are alike in role, name, handler and container: the first on the page was used',
};

const chosen = (testId: string): TestVerdict => ({
  executionId: '',
  testId,
  title: testId,
  automationId: testId,
  status: 'NEEDS REVIEW',
  reason: `S7 "Click Edit": ${PICK.why}; a person approves the choice before the case can PASS`,
  expected: 'The Save button is displayed',
  actual: 'Button "Save" is on the page',
  steps: [{ id: 'S7', raw: 'Click Edit', result: 'passed' }],
  checks: [{ id: 'E1', raw: 'The Save button is displayed', expected: 'Button "Save" is shown', actual: 'Button "Save" is on the page', result: 'passed' }],
  durationMs: 10,
  evidence: { screenshots: ['/runs/S7-after.png'] },
  picks: [PICK],
});

async function setup() {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-picks-')), 'picks.db');
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
  });
  const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
  await store.saveVerdicts(job.id, [{ testId: 'TC-JOB', row: 2, status: 'NEEDS REVIEW', verdict: chosen('TC-JOB') }]);
  return { store, service, jobId: job.id };
}

describe('E0.17 item 3: a PASS on a case keeps the control the engine chose among alike ones', () => {
  it('PASS: the word means that element on that screen, for the next run', async () => {
    const { store, service, jobId } = await setup();
    const card = (await service.cards(jobId))[0];
    assert.ok(card);
    const out = await service.decide(jobId, card.id, { decision: 'PASS', who: 'Owner' });
    assert.equal(out.results[0]?.outcome, 'recorded');
    const run = await learnedForRun(store, 'p');
    assert.deepEqual(run.screenLabels, [{ word: 'edit', means: 'Edit', screen: PICK.screen, element: PICK.element }]);
  });

  it('FAIL: nothing is kept', async () => {
    const { store, service, jobId } = await setup();
    const card = (await service.cards(jobId))[0];
    assert.ok(card);
    await service.decide(jobId, card.id, { decision: 'FAIL', who: 'Owner' });
    assert.deepEqual((await learnedForRun(store, 'p')).screenLabels, []);
  });
});
