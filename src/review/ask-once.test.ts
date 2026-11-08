import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '../db/store.js';
import { compileCase } from '../engine/pipeline/compile.js';
import { LearningService } from '../learning/service.js';
import { defaultParserConfig } from '../parser/index.js';
import { withReadings } from '../parser/rules.js';
import type { Status, TestVerdict } from '../results/verdict.js';
import { ReviewRefused, ReviewService } from './service.js';

/**
 * E0.19 step 3, ask once: a person says once what a sentence means, on its review card. It is kept as a project reading, and the new
 * engine reads every case of the project with that sentence by it, in every sheet, from the next run on.
 */

const rules = (step: Record<string, string>, check: Record<string, string> = {}) => ({ step, check });

describe('ask once per project (E0.19 step 3)', () => {
  it('a reading replaces the sentence of a numbered step line, an expected result and a step result, keeping the number', () => {
    const raw = {
      id: 'TC15',
      title: 'TC15',
      steps: '16. Click on Back Button\n17. Click on Employee Name.',
      expected: 'User should naviagte to Employment section',
      stepExpected: { '16': 'User should navigate to Employee Information page' },
    };
    const r = withReadings(
      raw,
      rules(
        { 'click on employee name': 'Click "Anita Kumari Rao" in the Employee Name column' },
        { 'user should naviagte to employment section': 'The Employment heading is shown' },
      ),
    );
    assert.equal(r.raw.steps, '16. Click on Back Button\n17. Click "Anita Kumari Rao" in the Employee Name column');
    assert.equal(r.raw.expected, 'The Employment heading is shown');
    assert.equal(r.raw.stepExpected?.['16'], 'User should navigate to Employee Information page');
    assert.equal(r.applied.length, 2);
    assert.equal(withReadings(raw, undefined).raw, raw, 'no readings: the case as written');
  });

  it('the new engine reads the case by the project readings it is given', async () => {
    const raw = { id: 'R1', title: 'R1', steps: '1. Open the Login page\n2. Press the magic thing', expected: 'The Dashboard heading is shown' };
    const config = { ...defaultParserConfig(), rules: { step: { 'press the magic thing': 'Click the Login button' }, check: {}, element: {} } };
    const plain = await compileCase(raw, { env: {}, cache: false });
    const read = await compileCase(raw, { env: {}, cache: false, config });
    const second = (c: typeof plain) => c.ir?.steps.find((s) => s.original.includes('Login button') || s.original.includes('magic'));
    assert.equal(second(read)?.action, 'CLICK');
    assert.ok(second(read)?.original.includes('Click the Login button'));
    assert.notEqual(JSON.stringify(second(plain)), JSON.stringify(second(read)));
    assert.ok(JSON.stringify(read.log).includes('sentence read as a person said it means'));
  });

  it('an answer on a wording card is kept for the project, shown on the card, and counted across its test cases', async () => {
    const store = await Store.open(path.join(await mkdtemp(path.join(tmpdir(), 'aq-ask-')), 'ask.db'));
    try {
      await store.createProject({
        id: 'p',
        name: 'p',
        baseUrl: 'http://127.0.0.1:1',
        testIdAttribute: 'data-testid',
        browser: 'chromium',
        workspace: path.join(tmpdir(), 'p'),
      });
      const learning = new LearningService(store);
      const service = new ReviewService(store, { read: (projectId, reading, source, who) => learning.saveReading(projectId, reading, source, who) });
      for (const id of ['TC15', 'TC16', 'TC20'])
        await store.upsertTestCase(
          'p',
          { id, title: id, steps: '1. Open the PIM page\n2. Click on Employee Name', expected: 'The Personal Details heading is shown' },
          { kind: 'form' },
          'test',
        );
      const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
      const verdict = (testId: string): TestVerdict =>
        ({
          executionId: 'E',
          testId,
          title: testId,
          automationId: testId,
          status: 'NEEDS REVIEW' as Status,
          reason: 'step 2 "Click on Employee Name": ambiguous wording: "Employee Name" names no employee',
          review: [{ id: 'step 2', raw: 'Click on Employee Name', headline: 'Not understood:', why: '"Employee Name" names no employee', todo: [] }],
          expected: 'The Personal Details heading is shown',
          actual: `page of ${testId}`,
          steps: [{ id: 'S1', raw: 'Open the PIM page', result: 'passed' }],
          checks: [],
          durationMs: 1,
          evidence: { screenshots: [] },
        }) as TestVerdict;
      await store.saveVerdicts(job.id, [
        { testId: 'TC15', status: 'NEEDS REVIEW', verdict: verdict('TC15') },
        { testId: 'TC16', status: 'NEEDS REVIEW', verdict: verdict('TC16') },
      ]);
      const [card] = await service.cards(job.id);
      assert.deepEqual(card?.asks, { sentence: 'Click on Employee Name', kind: 'step' });

      await assert.rejects(service.answer(job.id, card?.id as string, { means: 'Click on Employee Name' }), ReviewRefused);
      const kept = await service.answer(job.id, card?.id as string, { means: 'Click "Anita Kumari Rao" in the Employee Name column', who: 'Asha' });
      assert.equal(kept.kind, 'step');
      assert.equal(kept.casesOnCard, 2);
      assert.equal(kept.casesInProject, 3, 'TC20 is in another sheet of the project and has the same sentence');

      const [after] = await service.cards(job.id);
      assert.equal(after?.meaning?.to, 'Click "Anita Kumari Rao" in the Employee Name column');
      assert.equal(after?.meaning?.by, 'Asha');
      const active = await store.learnedEntries('p', { kind: 'reading', status: 'active' });
      assert.equal(active.length, 1);
    } finally {
      await store.close();
    }
  });

  it('a card about what the page showed is decided with PASS or FAIL, not answered with a sentence', async () => {
    const store = await Store.open(path.join(await mkdtemp(path.join(tmpdir(), 'aq-ask-')), 'ask.db'));
    try {
      await store.createProject({
        id: 'p',
        name: 'p',
        baseUrl: 'http://127.0.0.1:1',
        testIdAttribute: 'data-testid',
        browser: 'chromium',
        workspace: path.join(tmpdir(), 'p'),
      });
      const service = new ReviewService(store, { read: async () => ({ id: 'never' }) });
      const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
      const v = {
        executionId: 'E',
        testId: 'TC01',
        title: 'TC01',
        automationId: 'TC01',
        status: 'NEEDS REVIEW',
        reason: 'E2 "Login section should be middle of the page" is unproven',
        review: [{ id: 'E2', raw: 'Login section should be middle of the page', headline: 'Not proven:', why: 'not in the same place', todo: [] }],
        expected: 'Login section should be middle of the page',
        actual: 'off by 296 px',
        steps: [{ id: 'S1', raw: 'Open the login page', result: 'passed' }],
        checks: [{ id: 'E2', raw: 'Login section should be middle of the page', expected: 'middle', actual: 'off by 296 px', result: 'not verified' }],
        durationMs: 1,
        evidence: { screenshots: ['a.png'] },
      };
      await store.saveVerdicts(job.id, [{ testId: 'TC01', status: 'NEEDS REVIEW', verdict: v }]);
      const [card] = await service.cards(job.id);
      assert.equal(card?.asks, undefined);
      await assert.rejects(service.answer(job.id, card?.id as string, { means: 'The login box is centred' }), /PASS or FAIL/);
    } finally {
      await store.close();
    }
  });
});
