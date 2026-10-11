import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import type { Resolver } from '../explorer/controller.js';
import type { RawTestCase } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import type { TestVerdict } from '../results/verdict.js';
import { runCases } from './run-cases.js';

/**
 * M6 end to end on the demo app: parse → explore → generate → run → verdict, for passing, failing,
 * broken and unreadable test cases. Needs Google Chrome, no internet. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const config = defaultParserConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const demoCases: RawTestCase[] = JSON.parse(readFileSync(path.join(root, 'examples/demo-app/test-cases.json'), 'utf8'));
const demo = (id: string) => parseTestCase(demoCases.find((c) => c.id === id)!, config);
const extra = (id: string, steps: string, expected: string) => parseTestCase({ id, title: id, steps, expected }, config);
const login = '1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login';

// Batch behaviour (D22): never wait; skip what needs the tester.
const unattended: Resolver = { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false };

describe('whole flow: test case → verdict (M6)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  // Inside the repo so the generated project finds @playwright/test in the platform's node_modules.
  const base = path.join(root, '.auto-qa', 'test-pipeline');
  const dirs = { exploreDir: path.join(base, 'explore'), runsDir: path.join(base, 'runs'), workspace: path.join(base, 'workspace') };
  const env = { TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: DEMO_USER.password, TEST_WRONG_PASSWORD: 'nope' };
  const models = [
    demo('TC-DEMO-001'),
    demo('TC-DEMO-002'),
    demo('TC-DEMO-004'),
    extra('TC-X-WRONG', `${login}\n5. Click Profile\n6. Click Save changes`, 'Message "Changes saved" is shown'),
    extra('TC-X-VAGUE', '1. Open Login page\n2. Do the needful', 'System works correctly'),
    extra('TC-X-MISSING', '1. Open Login page\n2. Click Forgot password', 'User stays on the Login page'),
  ];
  let first: { verdicts: TestVerdict[]; executionId?: string };
  const byId = (verdicts: TestVerdict[], id: string) => verdicts.find((v) => v.testId === id)!;
  const run = (over: Partial<Parameters<typeof runCases>[1]> = {}, list = models) =>
    runCases(list, { config, baseUrl: app.url, env, resolver: unattended, ...dirs, ...over });

  before(async () => {
    app = await startDemoApp();
    await rm(base, { recursive: true, force: true });
    first = await run();
  });
  after(async () => {
    await app?.close();
  });

  it('passes the tests the application satisfies', () => {
    for (const id of ['TC-DEMO-001', 'TC-DEMO-002']) assert.equal(byId(first.verdicts, id).status, 'PASS', JSON.stringify(byId(first.verdicts, id)));
  });

  it('fails a wrong expectation, with the actual result from the page', () => {
    const v = byId(first.verdicts, 'TC-X-WRONG');
    assert.deepEqual([v.status, v.category], ['FAIL', 'Assertion']);
    assert.match(v.actual, /"Changes saved" was not shown\. The page showed page \/profile; heading "Profile"; message "Profile saved"\./);
    assert.ok(v.evidence.screenshots.length && v.evidence.screenshots.every((f) => existsSync(f)), 'screenshot kept (FR-EV-01)');
  });

  it('fails a page with errors, although every step passed (FR-VAL-04)', () => {
    const v = byId(first.verdicts, 'TC-DEMO-004');
    assert.deepEqual([v.status, v.category], ['FAIL', 'Application']);
    assert.ok(v.steps.every((s) => s.result === 'passed'));
    assert.match(
      v.checks.find((c) => c.expected === 'No errors on the page')?.actual ?? '',
      /500 from GET \/api\/reports; uncaught error: Reports widget crashed/,
    );
  });

  it('sets aside what needs the tester, without guessing (D6, D22)', () => {
    const vague = byId(first.verdicts, 'TC-X-VAGUE');
    assert.equal(vague.status, 'NEEDS REVIEW');
    assert.match(vague.reason, /S2 "Do the needful"/);
    const missing = byId(first.verdicts, 'TC-X-MISSING');
    assert.equal(missing.status, 'NEEDS REVIEW');
    assert.match(missing.reason, /S2 "Click Forgot password": I could not find "Forgot password" on the page/);
    assert.doesNotMatch(missing.reason, /NO_MATCH/, 'no internal code in what the tester reads');
    assert.equal(missing.review?.[0]?.id, 'S2');
    assert.ok(missing.review?.[0]?.todo.length, 'it says what to do');
  });

  it("gives every verdict the run's execution ID (FR-EN-06)", () => {
    assert.match(first.executionId ?? '', /^EXEC-\d{4}-\d{5}$/);
    assert.ok(first.verdicts.every((v) => v.executionId === first.executionId));
  });

  it('never saves a secret', async () => {
    const saved = await readFile(path.join(dirs.runsDir, first.executionId!, 'result.json'), 'utf8');
    assert.ok(!saved.includes(DEMO_USER.password));
  });

  it('reuses explorations, and fails or blocks when the credentials change', async () => {
    const started = Date.now();
    const wrong = await run({ env: { ...env, TEST_PASSWORD: 'wrong' } }, [demo('TC-DEMO-001')]);
    const v = wrong.verdicts[0];
    assert.deepEqual([v.status, v.category], ['FAIL', 'Assertion']);
    assert.match(v.actual, /Page was \/\. The page showed heading "Sign in to Demo"; message "Invalid username or password"\./);
    assert.ok(Date.now() - started < 30_000, 'no second exploration');

    const blocked = await run({ env: { TEST_USERNAME: 'demo' } }, [demo('TC-DEMO-001')]);
    assert.deepEqual([blocked.verdicts[0].status, blocked.verdicts[0].category], ['BLOCKED', 'Test Data']);
    assert.notEqual(blocked.executionId, wrong.executionId);
  });
});

describe('assist extension point (FR-AI-01)', () => {
  const vague = () =>
    parseTestCase({ id: 'TC-V', title: 'v', steps: '1. Open Login page\n2. Do the needful', expected: 'User stays on the same page' }, config);
  const options = (assist?: Parameters<typeof runCases>[1]['assist']) => ({
    config,
    baseUrl: 'http://127.0.0.1:1',
    env: {},
    resolver: unattended,
    assist,
    exploreDir: path.join(root, '.auto-qa', 'test-assist'),
  });

  it("works with no helper: the reason is the parser's", async () => {
    const r = await runCases([vague()], options());
    assert.equal(r.verdicts[0].status, 'NEEDS REVIEW');
    assert.doesNotMatch(r.verdicts[0].reason, /Try: "/);
  });

  it("shows a helper's rewrite as a suggestion only; the case still needs review", async () => {
    const asked: string[] = [];
    const r = await runCases(
      [vague()],
      options({
        async suggestRewrite(i) {
          asked.push(`${i.kind}: ${i.raw}`);
          return 'Click Login';
        },
      }),
    );
    assert.deepEqual(asked, ['step: Do the needful']);
    assert.equal(r.verdicts[0].status, 'NEEDS REVIEW');
    assert.match(r.verdicts[0].reason, /S2 "Do the needful": I cannot tell what to do .*Try: "Click Login"/);
  });
});
