import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '../db/store.js';
import type { Status, TestVerdict } from '../results/verdict.js';
import { removeStep } from './remove-step.js';
import { ReviewRefused, ReviewService } from './service.js';

/**
 * U1 step 5: one review for a whole project (each case from its latest run), and "Remove this step", which takes a step line that asks
 * nothing out of every case on its card as a new version, numbering the steps again and moving the expected results with them.
 */

const wording = (testId: string, sentence = 'Verify Broswer should be Opened'): TestVerdict =>
  ({
    executionId: 'E',
    testId,
    title: testId,
    automationId: testId,
    status: 'NEEDS REVIEW' as Status,
    reason: `step 2 "${sentence}": not understood`,
    review: [{ id: 'step 2', raw: sentence, headline: '', why: 'no check could be read', todo: [] }],
    expected: 'x',
    actual: `page ${testId}`,
    steps: [{ id: 'S1', raw: 'Open', result: 'passed' }],
    checks: [],
    durationMs: 1,
    evidence: { screenshots: [] },
  }) as TestVerdict;

async function setup() {
  const store = await Store.open(path.join(await mkdtemp(path.join(tmpdir(), 'aq-preview-')), 'p.db'));
  await store.createProject({
    id: 'p',
    name: 'p',
    baseUrl: 'http://127.0.0.1:1',
    testIdAttribute: 'data-testid',
    browser: 'chromium',
    workspace: path.join(tmpdir(), 'p'),
  });
  return { store, review: new ReviewService(store) };
}
const run = async (store: Store, rows: Array<[string, TestVerdict]>) => {
  const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
  await store.saveVerdicts(
    job.id,
    rows.map(([testId, verdict]) => ({ testId, status: verdict.status, verdict })),
  );
  await store.updateJob(job.id, { status: 'done', finishedAt: new Date().toISOString() });
  return job.id;
};

describe('removing a step line (U1 step 5)', () => {
  const raw = {
    id: 'TC02',
    title: 'TC02',
    steps: '1. Open the BookMarket URL\n2. Verify Broswer should be Opened\n3. Enter the email\n4. Click Sign in',
    stepExpected: { '2': 'The browser is open', '3': 'The email is accepted', '4': 'The Home page is shown' },
    expected: 'The Home page is shown',
  };

  it('takes the line out, numbers the lines after it again, and moves the expected results with their steps', () => {
    const next = removeStep(raw, 'Verify  broswer should be opened.');
    assert.equal(next?.steps, '1. Open the BookMarket URL\n2. Enter the email\n3. Click Sign in');
    assert.deepEqual(next?.stepExpected, { '2': 'The email is accepted', '3': 'The Home page is shown' });
  });

  it('changes nothing when the case has no such line', () => {
    assert.equal(removeStep(raw, 'Click the logo'), undefined);
  });
});

describe('the review of a whole project (U1 step 5)', () => {
  it('shows each case from its latest run only, and says which run a card is from', async () => {
    const { store, review } = await setup();
    try {
      const older = await run(store, [
        ['TC02', wording('TC02')],
        ['TC03', wording('TC03')],
      ]);
      const passed = { ...wording('TC03'), status: 'PASS' as Status, review: [], checks: [] };
      const newer = await run(store, [['TC03', passed]]);
      const cards = await review.projectCards('p');
      assert.equal(cards.length, 1);
      assert.deepEqual(
        cards[0]?.cases.map((c) => c.testId),
        ['TC02'],
        'TC03 passed in the newer run',
      );
      assert.equal(cards[0]?.jobId, older);
      assert.notEqual(cards[0]?.jobId, newer);
    } finally {
      await store.close();
    }
  });

  it('removes the step from every case on a step card as a new version, and refuses a card about what the page showed', async () => {
    const { store, review } = await setup();
    try {
      for (const id of ['TC02', 'TC03'])
        await store.upsertTestCase(
          'p',
          { id, title: id, steps: '1. Open the URL\n2. Verify Broswer should be Opened\n3. Click Sign in', expected: 'The Home page is shown' },
          { kind: 'workbook', row: 2 },
          'imported',
        );
      const jobId = await run(store, [
        ['TC02', wording('TC02')],
        ['TC03', wording('TC03')],
      ]);
      const [card] = await review.cards(jobId);
      const done = await review.removeStep(jobId, card?.id as string, { who: 'Asha' });
      assert.deepEqual(done.changed.sort(), ['TC02', 'TC03']);
      const tc02 = await store.testCase('p', 'TC02');
      assert.equal(tc02?.raw.steps, '1. Open the URL\n2. Click Sign in');
      assert.equal(tc02?.version, 2);

      const checkJob = await run(store, [
        [
          'TC09',
          {
            ...wording('TC09'),
            review: [{ id: 'E1', raw: 'The Home page is shown', headline: '', why: 'unproven', todo: [] }],
            checks: [{ id: 'E1', raw: 'The Home page is shown', expected: 'x', actual: 'y', result: 'not verified' }],
          },
        ],
      ]);
      const [check] = await review.cards(checkJob);
      await assert.rejects(review.removeStep(checkJob, check?.id as string, {}), ReviewRefused);
    } finally {
      await store.close();
    }
  });
});

describe('the Ripple map (U1 step 6)', () => {
  it('an answer about a sentence settles every test case of the project with it, in every sheet; all cases come by sheet', async () => {
    const { store, review } = await setup();
    try {
      for (const id of ['TC02', 'TC03', 'TC20'])
        await store.upsertTestCase(
          'p',
          { id, title: id, steps: '1. Open the URL\n2. Verify Broswer should be Opened', expected: 'x' },
          { kind: 'form' },
          'test',
        );
      await store.upsertTestCase('p', { id: 'TC09', title: 'TC09', steps: '1. Open the URL', expected: 'x' }, { kind: 'form' }, 'test');
      const jobId = await run(store, [
        ['TC02', wording('TC02')],
        ['TC03', wording('TC03')],
      ]);
      const [card] = await review.cards(jobId);
      const r = await review.ripple(jobId, card?.id as string);
      assert.deepEqual(r.settles.sort(), ['TC02', 'TC03', 'TC20'], 'TC20 is not on the card but has the sentence');
      assert.deepEqual(r.sheets.flatMap((x) => x.cases.map((c) => c.id)).sort(), ['TC02', 'TC03', 'TC09', 'TC20']);
      await assert.rejects(review.ripple(jobId, 'no-such-card'), ReviewRefused);
    } finally {
      await store.close();
    }
  });
});
