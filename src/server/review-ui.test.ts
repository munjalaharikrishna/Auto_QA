import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { type Browser, chromium, type Page } from 'playwright';
import { defaultParserConfig } from '../parser/index.js';
import { buildApp } from './app.js';
import { JobRunner } from './jobs.js';
import { Store } from './store.js';

/**
 * The review card on the results page (VD-11, DEC-05), driven like a tester would: a case the engine could not decide is a card with
 * what was expected and what the page showed; PASS and FAIL are recorded with a name; the same click again changes nothing; a change
 * needs a reason; and a case whose run did not finish cannot be passed. Needs the built UI (npm run web:build) and Google Chrome.
 * AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webDir = path.join(root, 'web', 'dist');
const skip = !!process.env.AUTO_QA_SKIP_BROWSER || (!existsSync(path.join(webDir, 'index.html')) && 'run npm run web:build first');

const verdict = (testId: string, over: Record<string, unknown> = {}) => ({
  testId,
  title: testId,
  status: 'NEEDS REVIEW',
  reason: 'The page showed a message, but not the one expected.',
  expected: 'Error "Invalid credentials" is shown',
  actual: 'the page showed "Account locked"',
  steps: [{ id: 'S1', raw: 'Click Login', result: 'passed' }],
  checks: [
    {
      id: 'A1',
      raw: 'Error "Invalid credentials" is shown',
      expected: 'Error "Invalid credentials" is shown',
      actual: 'the page showed "Account locked"',
      result: 'not verified',
    },
  ],
  durationMs: 10,
  evidence: { screenshots: [] },
  ...over,
});

describe('the review card in the web UI', { skip, concurrency: false }, () => {
  let app: FastifyInstance;
  let url: string;
  let browser: Browser;
  let page: Page;
  let jobId: string;
  const errors: string[] = [];

  before(async () => {
    const store = await Store.open(':memory:');
    await store.createProject({
      id: 'demo',
      name: 'Demo',
      baseUrl: 'http://127.0.0.1:1',
      testIdAttribute: 'data-testid',
      browser: 'chromium',
      workspace: path.join(root, '.auto-qa', 'test-review-ui'),
    });
    const job = await store.createJob({ projectId: 'demo', kind: 'workbook', input: {} });
    jobId = job.id;
    await store.saveVerdicts(jobId, [
      { testId: 'TC-1', row: 2, status: 'NEEDS REVIEW', verdict: verdict('TC-1') },
      { testId: 'TC-2', row: 3, status: 'NEEDS REVIEW', verdict: verdict('TC-2') },
      {
        testId: 'TC-9',
        row: 4,
        status: 'NEEDS REVIEW',
        verdict: verdict('TC-9', {
          reason: 'The run stopped before the page could be read.',
          actual: '',
          steps: [{ id: 'S1', raw: 'Click Login', result: 'failed', error: 'the button was not there' }],
          checks: [{ id: 'A1', raw: 'The Dashboard heading is shown', expected: 'The Dashboard heading is shown', actual: '', result: 'not run' }],
        }),
      },
      { testId: 'TC-3', row: 5, status: 'PASS', verdict: verdict('TC-3', { status: 'PASS' }) },
    ]);
    await store.updateJob(jobId, { status: 'done' });
    const runner = new JobRunner({ store, config: defaultParserConfig(), dataDir: path.join(root, '.auto-qa', 'test-review-ui', 'data') });
    app = await buildApp({
      store,
      runner,
      dataDir: path.join(root, '.auto-qa', 'test-review-ui', 'data'),
      workspacesDir: path.join(root, '.auto-qa', 'test-review-ui', 'ws'),
      webDir,
    });
    url = await app.listen({ port: 0, host: '127.0.0.1' });
    browser = await chromium.launch({ channel: 'chrome' });
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
  });
  after(async () => {
    await browser?.close();
    await app?.close();
    await rm(path.join(root, '.auto-qa', 'test-review-ui'), { recursive: true, force: true });
  });

  it('shows one card for the two cases that share a cause, with what was expected and what the page showed, and one for the case that did not finish', async () => {
    await page.goto(`${url}/jobs/${jobId}`);
    await page.getByRole('heading', { name: 'Needs your decision' }).waitFor();
    const card = page.getByRole('article', { name: 'Review card: Error "Invalid credentials" is shown' });
    await card.waitFor();
    assert.ok((await card.innerText()).includes('covers TC-1, TC-2'));
    assert.ok((await card.innerText()).includes('Account locked'));
    const stopped = page.getByRole('article', { name: 'Review card: The Dashboard heading is shown' });
    await stopped.waitFor();
    assert.equal(await stopped.getByRole('button', { name: 'PASS', exact: true }).isDisabled(), true, 'a run that did not finish cannot be passed');
    assert.ok((await stopped.innerText()).includes('PASS is not offered: A step did not finish (S1)'));
    assert.equal(await stopped.getByRole('button', { name: 'FAIL', exact: true }).isEnabled(), true);
  });

  it("records a PASS with a name, shows it beside the engine's verdict, and does not change the verdict", async () => {
    const card = page.getByRole('article', { name: 'Review card: Error "Invalid credentials" is shown' });
    await card.getByLabel('Your name').fill('Asha Rao');
    await card.getByRole('button', { name: 'PASS', exact: true }).click();
    await card.getByLabel('What was recorded').waitFor();
    const recorded = await card.getByLabel('What was recorded').innerText();
    assert.ok(recorded.includes('TC-1: recorded') && recorded.includes('TC-2: recorded'), recorded);
    await page.getByText('decided by Asha Rao: PASS').first().waitFor();
    assert.equal(await page.getByText('decided by Asha Rao: PASS').count(), 2, 'one for each case of the card');
    assert.ok((await card.innerText()).includes("The engine's verdict was NEEDS REVIEW"));
    const rows = await page.locator('tr', { hasText: 'TC-1' }).first().innerText();
    assert.ok(rows.includes('NEEDS REVIEW'), "the engine's status is still shown");
  });

  it('the same click again is not a second decision; a change needs a reason, and is kept with the first as history', async () => {
    const card = page.getByRole('article', { name: 'Review card: Error "Invalid credentials" is shown' });
    await card.getByRole('button', { name: 'PASS', exact: true }).click();
    await card.getByText('already decided the same way').first().waitFor();
    await card.getByRole('button', { name: 'FAIL', exact: true }).click();
    await card.getByText('not recorded: A change of decision needs a reason in the note.').first().waitFor();
    await card.getByLabel('Why (needed to change a decision)').fill('on the second look the message is wrong');
    await card.getByRole('button', { name: 'FAIL', exact: true }).click();
    await page.getByText('decided by Asha Rao: FAIL').first().waitFor();
    assert.equal(await page.getByText('decided by Asha Rao: PASS').count(), 0);
    const history = (await (await page.request.get(`${url}/api/jobs/${jobId}/review-queue/history`)).json()) as {
      decisions: Array<{ decision: string; status: string }>;
    };
    assert.deepEqual(history.decisions.map((d) => [d.decision, d.status]).sort(), [
      ['FAIL', 'current'],
      ['FAIL', 'current'],
      ['PASS', 'superseded'],
      ['PASS', 'superseded'],
    ]);
  });

  it('had no errors in the page', () => {
    assert.deepEqual(errors, []);
  });
});
