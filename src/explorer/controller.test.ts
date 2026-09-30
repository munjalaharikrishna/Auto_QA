import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import { openSession, type Session } from '../locators/session.js';
import type { RawTestCase, TestModel } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { type ExplorationResult, type ExploreOptions, explore, type Resolver, type ReviewRequest } from './controller.js';

/**
 * Exploration of whole test cases (FR-EX-02…09) against the local demo app.
 * Needs Google Chrome, no internet. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;
const config = defaultParserConfig();
const demoCases: RawTestCase[] = JSON.parse(readFileSync(new URL('../../examples/demo-app/test-cases.json', import.meta.url), 'utf8'));
const demo = (id: string) => parseTestCase(demoCases.find((c) => c.id === id)!, config);
const inline = (steps: string, expected = 'User stays on the same page', more: Partial<RawTestCase> = {}) =>
  parseTestCase({ id: 'TC-X', title: 'x', steps, expected, ...more }, config);

/** Scripted answers; records what was asked. */
function scripted(answers: { choose?: number | 'skip' | 'abort'; pageUrl?: string; confirm?: boolean } = {}) {
  const asked: string[] = [];
  const resolver: Resolver = {
    async choose(r) {
      asked.push(`choose ${r.item} ${r.code}`);
      return answers.choose ?? 'skip';
    },
    async pageUrl(r) {
      asked.push(`pageUrl ${r.item} ${r.page}`);
      return answers.pageUrl ?? 'abort';
    },
    async confirm(r) {
      asked.push(`confirm ${r.item} ${r.code}`);
      return answers.confirm ?? false;
    },
  };
  return { resolver, asked };
}

describe('exploration controller on the demo app', { skip, concurrency: 3 }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let outDir: string;
  const env = { TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: DEMO_USER.password, TEST_WRONG_PASSWORD: 'nope' };

  before(async () => {
    app = await startDemoApp();
    outDir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-explore-'));
  });
  after(async () => {
    await app?.close();
    await rm(outDir, { recursive: true, force: true });
  });

  async function run(model: TestModel, resolver: Resolver, more: Partial<ExploreOptions> = {}): Promise<ExplorationResult> {
    const session: Session = await openSession({});
    try {
      return await explore(model, session, { config, baseUrl: app.url, env, resolver, outDir, timeouts: { settle: 5000 }, ...more });
    } finally {
      await session.close();
    }
  }
  const byId = (r: ExplorationResult, id: string) => r.items.find((i) => i.id === id)!;

  it('logs in, follows the redirect and locates the check target', async () => {
    const { resolver, asked } = scripted();
    const r = await run(demo('TC-DEMO-001'), resolver);
    assert.equal(r.status, 'complete', JSON.stringify(r.items.map((i) => [i.id, i.status, i.error, i.warnings])));
    assert.deepEqual(asked, []);
    assert.equal(byId(r, 'S1').effect, 'url /');
    assert.equal(byId(r, 'S2').effect, 'value set');
    assert.equal(byId(r, 'S4').locator?.code, "getByTestId('login')");
    assert.equal(byId(r, 'S4').effect, 'url /dashboard');
    assert.equal(byId(r, 'A2').locator?.code, "getByRole('heading', { name: 'Dashboard', exact: true })");
    assert.deepEqual(r.pages, { LoginPage: { path: '/', title: 'Login · Demo' }, DashboardPage: { path: '/dashboard', title: 'Dashboard · Demo' } });
    // D19: the first page is the base URL; the redirect target is learned from the check.
    // Stored as paths, so they work in any environment of the same app.
    assert.deepEqual(r.learnedPageUrls, { Login: '/', Dashboard: '/dashboard' });
    assert.equal(byId(r, 'S2').fingerprint?.label, 'Username');
    assert.ok(r.items.every((i) => i.screenshot));
  });

  it('never saves a secret value', async () => {
    const r = await run(demo('TC-DEMO-002'), scripted().resolver);
    assert.equal(r.status, 'complete');
    const json = JSON.stringify(r);
    assert.ok(!json.includes(DEMO_USER.password) && !json.includes('nope'));
    assert.equal(byId(r, 'A1').observed?.textFound, true);
  });

  it('explores a flow across three pages, with delayed messages', async () => {
    const r = await run(demo('TC-DEMO-003'), scripted().resolver);
    assert.equal(r.status, 'complete', JSON.stringify(r.items.map((i) => [i.id, i.status, i.error])));
    assert.deepEqual(
      r.items.map((i) => i.effect ?? ''),
      ['url /', 'value set', 'value set', 'url /dashboard', 'url /profile', 'value set', 'option selected', 'checked', 'page changed', '', '', ''],
    );
    assert.deepEqual(Object.keys(r.pages), ['LoginPage', 'DashboardPage', 'ProfilePage']);
  });

  it('asks for the URL of a page it does not know (D19)', async () => {
    const { resolver, asked } = scripted({ pageUrl: '/profile' });
    const r = await run(inline('1. Open Login page\n2. Open Profile page\n3. Enter "Asha" in Full name'), resolver);
    assert.deepEqual(asked, ['pageUrl S2 Profile']);
    assert.equal(r.status, 'complete');
    assert.equal(r.learnedPageUrls.Profile, '/profile');
    // A known page is not asked again.
    const again = await run(inline('1. Open Login page\n2. Open Profile page'), scripted().resolver, { pageUrls: r.learnedPageUrls });
    assert.equal(again.status, 'complete');
  });

  it('stops at a step it cannot do, and explains why', async () => {
    const { resolver } = scripted({ choose: 0 });
    const r = await run(demo('TC-DEMO-001'), resolver, { env: { TEST_USERNAME: 'demo' } });
    assert.equal(r.status, 'incomplete');
    assert.equal(byId(r, 'S3').status, 'failed');
    assert.match(byId(r, 'S3').error ?? '', /Set TEST_PASSWORD/);
    assert.equal(r.items.length, 3, 'later steps are not explored');
  });

  it('never stores a locator for an element the action cannot use', async () => {
    const { resolver, asked } = scripted({ choose: 0 });
    const r = await run(inline('1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login\n5. Click Delete account'), resolver);
    assert.equal(byId(r, 'S5').status, 'failed');
    assert.equal(byId(r, 'S5').locator, undefined);
    assert.ok(asked.includes('choose S5 NO_VALID_LOCATOR'));
  });

  it('skips a step the tester skips, and keeps going', async () => {
    const r = await run(inline('1. Open Login page\n2. Click Forgot password\n3. Enter valid username'), scripted({ choose: 'skip' }).resolver);
    assert.equal(byId(r, 'S2').status, 'skipped');
    assert.equal(byId(r, 'S3').status, 'done');
    assert.equal(r.status, 'incomplete');
  });

  it('lets the tester pick the element on the screenshot (FR-RV-02)', async () => {
    let view: ReviewRequest['view'];
    const resolver: Resolver = {
      ...scripted().resolver,
      async choose(r) {
        view = r.view;
        // Like a click in the UI: the second "Details" box on the screenshot.
        const boxes = r.view?.elements.filter((e) => e.name === 'Details') ?? [];
        return boxes[1] ? { ref: boxes[1].ref } : 'skip';
      },
    };
    const r = await run(
      inline('1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login\n5. Click Details', 'Message "Security details" is shown'),
      resolver,
    );
    assert.equal(r.status, 'complete', JSON.stringify(r.items.map((i) => [i.id, i.status, i.error, i.warnings])));
    assert.ok(view && readFileSync(view.screenshot).length > 0, 'the question has a screenshot');
    assert.equal(view?.elements.filter((e) => e.name === 'Details').length, 2);
    assert.ok(view?.elements.every((e) => e.box.width > 0 && e.box.height > 0));
    const s5 = byId(r, 'S5');
    assert.equal(s5.resolvedBy, 'tester');
    assert.equal(byId(r, 'A1').observed?.textFound, true, 'the picked button, not the first one, was clicked');
  });

  it('does not learn a page the test never reached, e.g. after a failed login', async () => {
    const { resolver, asked } = scripted({ confirm: false });
    const r = await run(demo('TC-DEMO-001'), resolver, { env: { ...env, TEST_PASSWORD: 'wrong' } });
    assert.ok(asked.includes('confirm A1 NOT_ON_PAGE'), asked.join());
    const a1 = byId(r, 'A1');
    assert.equal(a1.status, 'failed');
    assert.match(a1.error ?? '', /Not on the Dashboard page: still on LoginPage, which shows "Invalid username or password"/);
    assert.equal(r.learnedPageUrls.Dashboard, undefined);
    assert.equal(r.status, 'incomplete');
  });

  it('asks before exploring Production (FR-EX-08)', async () => {
    const { resolver, asked } = scripted({ confirm: false });
    const r = await run(demo('TC-DEMO-001'), resolver, { production: true });
    assert.equal(r.status, 'aborted');
    assert.deepEqual(asked, ['confirm start PRODUCTION']);
    assert.equal(r.items.length, 0);
  });

  it('runs the login test first for a "Logged in" precondition (FR-PF-01)', async () => {
    const model = inline('1. Click Profile\n2. Enter "Asha" in Full name', 'User stays on the same page', { preconditions: 'Logged in' });
    const r = await run(model, scripted().resolver, { login: demo('TC-DEMO-001') });
    assert.equal(r.status, 'complete', JSON.stringify(r.items.map((i) => [i.phase, i.id, i.status, i.error])));
    assert.deepEqual(
      r.items.filter((i) => i.phase === 'setup').map((i) => i.id),
      ['S1', 'S2', 'S3', 'S4'],
    );
    assert.equal(byId(r, 'S2').phase, 'setup');
  });
});
