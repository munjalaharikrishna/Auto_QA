import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { type Browser, chromium, type Page } from 'playwright';
import { buildDemoWorkbook } from '../../examples/demo-app/make-workbook.js';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import { defaultParserConfig } from '../parser/index.js';
import { buildApp } from './app.js';
import { JobRunner } from './jobs.js';
import { Store } from './store.js';

/**
 * The web UI (M7b) driven like a tester would: create a project, run a workbook, and take one test case
 * through a question, pick-element on the screenshot, review and approval. Needs the built UI
 * (npm run web:build) and Google Chrome. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webDir = path.join(root, 'web', 'dist');
const skip = !!process.env.AUTO_QA_SKIP_BROWSER || (!existsSync(path.join(webDir, 'index.html')) && 'run npm run web:build first');

describe('web UI (M7b)', { skip, concurrency: false }, () => {
  let dir: string;
  let demo: Awaited<ReturnType<typeof startDemoApp>>;
  let app: FastifyInstance;
  let url: string;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  before(async () => {
    dir = await mkdtemp(path.join(root, '.auto-qa', 'test-ui-'));
    demo = await startDemoApp();
    const store = await Store.open(':memory:');
    const runner = new JobRunner({ store, config: defaultParserConfig(), dataDir: path.join(dir, 'data') });
    app = await buildApp({ store, runner, dataDir: path.join(dir, 'data'), workspacesDir: path.join(dir, 'workspaces'), webDir });
    url = await app.listen({ port: 0, host: '127.0.0.1' });
    browser = await chromium.launch({ channel: 'chrome' });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
  });
  after(async () => {
    await browser?.close();
    await app?.close();
    await demo?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a project with its run settings, without showing the password again', async () => {
    await page.goto(url);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('Demo app');
    await page.getByLabel('Application URL').fill(demo.url);
    await page.getByLabel('Username').fill(DEMO_USER.username);
    await page.getByLabel('Password', { exact: true }).fill(DEMO_USER.password);
    await page.getByRole('button', { name: 'Add a value' }).click();
    await page.getByLabel('Variable name').fill('TEST_WRONG_PASSWORD');
    await page.getByLabel('TEST_WRONG_PASSWORD value').fill('nope');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('heading', { name: 'Demo app' }).waitFor();
    await page.getByRole('tab', { name: 'Settings' }).click();
    const password = page.getByLabel('Password', { exact: true });
    assert.equal(await password.inputValue(), '');
    assert.equal(await password.getAttribute('placeholder'), 'Saved — leave blank to keep it');
    assert.ok(!(await page.content()).includes(DEMO_USER.password));
  });

  it('uploads a workbook, maps its columns, runs it and shows the results', async () => {
    const file = path.join(dir, 'suite.xlsx');
    await buildDemoWorkbook(file, 12);
    await page.getByRole('tab', { name: 'Run a workbook' }).click();
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByText('12 test case(s).', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('Steps *').inputValue(), 'Test Steps');
    assert.equal(await page.getByLabel('Title *').inputValue(), 'Test Case Name');
    await page.getByText('Row 14 has no Steps.').waitFor();
    await page.getByRole('button', { name: 'Run all 12 test cases' }).click();
    await page.getByRole('heading', { name: /^Results/ }).waitFor({ timeout: 600_000 });
    const tiles = await page.locator('.tile').allInnerTexts();
    assert.deepEqual(
      tiles.map((t) => t.replace(/\s+/g, ' ').trim()),
      ['8 pass', '2 fail', '0 blocked', '3 needs review'],
    );
    await page.getByText('"Changes saved" was not shown', { exact: false }).waitFor();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download results workbook' }).click();
    assert.equal((await download).suggestedFilename(), 'suite.results.xlsx');
  });

  it('asks about an ambiguous step, lets the tester pick it on the screenshot, then reviews and runs it', async () => {
    await page.getByRole('link', { name: 'demo-app' }).click();
    await page.getByRole('tab', { name: 'Single test case' }).click();
    await page.getByLabel('Title').fill('Security details open');
    await page.getByLabel('Steps').fill('1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login\n5. Click Details');
    await page.getByLabel('Expected result').fill('Message "Security details" is shown');
    await page.getByRole('button', { name: 'Generate' }).click();

    await page.getByText('Needs an answer').waitFor({ timeout: 180_000 });
    const boxes = page.locator('.shot .box[title=\'button "Details"\']');
    assert.equal(await boxes.count(), 2);
    await boxes.nth(1).click();
    await page.getByText('Picked: button "Details"').waitFor();
    await page.getByRole('button', { name: 'Use this element' }).click();

    await page.getByRole('button', { name: 'Approve & Execute' }).waitFor({ timeout: 180_000 });
    await page.getByText('picked by you').waitFor();
    await page.getByText('tests/', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: 'Approve & Execute' }).click();
    await page.getByRole('heading', { name: /^Results/ }).waitFor({ timeout: 180_000 });
    await page.getByText('PASS', { exact: true }).waitFor();
    await page.getByText('"Security details" was shown', { exact: false }).waitFor();
  });

  it('had no errors in the page', () => {
    assert.deepEqual(errors, []);
  });
});
