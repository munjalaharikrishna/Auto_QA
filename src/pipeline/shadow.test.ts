import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import type { Resolver } from '../explorer/controller.js';
import type { RawTestCase } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import type { TestVerdict } from '../results/verdict.js';
import { runCases } from './run-cases.js';
import { reconcile } from './shadow.js';

/** Shadow mode (S6): a legacy PASS stands only when the new engine, running the case itself, agrees. */

const verdict = (status: TestVerdict['status'], over: Partial<TestVerdict> = {}): TestVerdict => ({
  executionId: 'EXEC-1',
  testId: 'T',
  title: 'T',
  automationId: 'T',
  status,
  reason: `it was ${status}`,
  expected: '',
  actual: 'what was seen',
  steps: [],
  checks: [],
  durationMs: 0,
  evidence: { screenshots: [] },
  ...over,
});

describe('reconcile: one engine passed, what does the other say?', () => {
  it('keeps the PASS when the new engine passes it too', () => {
    const legacy = verdict('PASS');
    assert.equal(reconcile(legacy, verdict('PASS')), legacy);
  });
  it('sets a PASS aside when the new engine fails it, with both answers', () => {
    const v = reconcile(verdict('PASS'), verdict('FAIL', { actual: 'Dashboard is not on the page' }));
    assert.equal(v.status, 'NEEDS REVIEW');
    assert.match(v.reason, /disagree/);
    assert.match(v.review?.[0]?.why ?? '', /Dashboard is not on the page/);
  });
  it('sets a PASS aside when the new engine cannot confirm it', () => {
    for (const s of ['NEEDS REVIEW', 'NOT VERIFIED', 'BLOCKED'] as const) {
      const v = reconcile(verdict('PASS'), verdict(s));
      assert.equal(v.status, 'NEEDS REVIEW', s);
      assert.match(v.reason, /could not confirm/);
    }
  });
  it('does not touch anything that is not a PASS, nor a case the new engine does not judge', () => {
    for (const s of ['FAIL', 'NEEDS REVIEW', 'BLOCKED'] as const) {
      const legacy = verdict(s);
      assert.equal(reconcile(legacy, verdict('PASS')), legacy);
      assert.equal(reconcile(legacy, verdict('FAIL')), legacy);
    }
    const pass = verdict('PASS');
    assert.equal(reconcile(pass, undefined), pass);
  });
});

const unattended: Resolver = { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false };
const config = defaultParserConfig();
const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

describe('a legacy PASS is re-judged by a run of the new engine', { skip }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let dir: string;
  before(async () => {
    app = await startDemoApp();
    dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-shadow-'));
  });
  after(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const login = (id: string, expected: string): RawTestCase => ({
    id,
    title: id,
    steps: ['Navigate to the login page', 'Enter valid username in the Login Name text box', 'Enter valid password in the Password text box', 'Click the Login button']
      .map((x, i) => `${i + 1}. ${x}`)
      .join('\n'),
    expected,
  });
  const run = (raws: RawTestCase[], engine: 'legacy' | 'semantic') =>
    runCases(
      raws.map((r) => parseTestCase(r, config)),
      {
        config,
        baseUrl: `${app.url}/legacy`,
        env: { TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: DEMO_USER.password },
        resolver: unattended,
        engine,
        approvedAssumptions: new Set(),
        exploreDir: path.join(dir, engine, 'explore'),
        runsDir: path.join(dir, engine, 'runs'),
        workspace: path.join(dir, engine, 'workspace'),
      },
    );

  it('confirms a PASS that the new engine also proves, and never lets a check nobody could fail pass', async () => {
    const good = login('T-GOOD', 'User is successfully redirected to the home/dashboard page');
    const vacuous = login('T-VACUOUS', 'The Frobnicate Settings button is not displayed');
    const legacy = await run([good, vacuous], 'legacy');
    const both = await run([good, vacuous], 'semantic');
    const status = (r: Awaited<ReturnType<typeof run>>, id: string) => r.verdicts.find((v) => v.testId === id)?.status;
    // Whatever the legacy route said, the combined run says PASS only where both engines do.
    for (const id of ['T-GOOD', 'T-VACUOUS']) {
      if (status(legacy, id) !== 'PASS') continue;
      const shadowed = status(both, id);
      assert.ok(shadowed === 'PASS' || shadowed === 'NEEDS REVIEW', `${id}: ${shadowed}`);
    }
    assert.notEqual(status(both, 'T-VACUOUS'), 'PASS', JSON.stringify(both.verdicts.find((v) => v.testId === 'T-VACUOUS')?.reason));
  });
});
