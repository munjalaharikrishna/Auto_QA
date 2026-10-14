import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../examples/demo-app/server.js';
import type { RunTrace, StepRecord } from '../engine/execute/executor.js';
import type { Observation } from '../engine/execute/observe.js';
import { type CompileResult, compileCase } from '../engine/index.js';
import type { Evaluation } from '../engine/verdict/evaluate.js';
import { VERDICTS, type Verdict, type VerdictName } from '../engine/verdict/verdict.js';
import type { Resolver } from '../explorer/controller.js';
import type { RawTestCase } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import type { TestVerdict } from '../results/verdict.js';
import { executeCases, type Prepared, prepareCases } from './run-cases.js';
import { runSemanticJobs, type SemanticJob, semanticSupport, toTestVerdict } from './semantic-run.js';

/**
 * Fallback-only semantic execution: a case the legacy route cannot complete is run through the E0.8 path (plan, MCP,
 * judge) when every check of it is one the judge decides. Legacy runs are unchanged, a PASS only ever comes from the judge,
 * and anything unsupported or ambiguous stays NEEDS REVIEW.
 */

const config = defaultParserConfig();
const skip = !!process.env.AUTO_QA_SKIP_BROWSER;
const SECRET = 'hunter2-not-for-reports';

const raw = (id: string, steps: string[], expected: string, extra: Partial<RawTestCase> = {}): RawTestCase => ({
  id,
  title: id,
  steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
  expected,
  ...extra,
});
const REJECTED = 'Login is rejected and an appropriate invalid username/password error message is displayed.';

async function compiled(r: RawTestCase, env: Record<string, string> = {}): Promise<CompileResult> {
  return compileCase(r, { env });
}

const obs = (messages: string[]): Observation => ({ url: 'http://x/', title: 'x', lines: [], elements: [], messages, fieldErrors: [], tabs: 1 });
const stepRecord = (before: string[], after: string[]): StepRecord => ({
  step: 'S4',
  action: 'CLICK',
  original: "Click the 'Login' button",
  status: 'done',
  calls: [],
  changes: [],
  dialogs: [],
  checksAfter: ['E1', 'E2'],
  notes: [],
  before: obs(before),
  after: obs(after),
});
const traceOf = (before: string[], after: string[]): RunTrace => ({
  testId: 'T',
  status: 'completed',
  capabilities: [],
  steps: [stepRecord(before, after)],
});
const evaluation = (over: Partial<Evaluation>): Evaluation => ({
  expectation: 'E2',
  clause: 'an appropriate invalid username/password error message is displayed',
  result: 'disproven',
  expected: 'shown: "invalid username/password"',
  actual: 'messages on the page: nothing',
  why: 'no message of that meaning appeared',
  step: 'S4',
  fresh: true,
  ...over,
});
const verdictOf = (name: VerdictName, evaluations: Evaluation[] = []): Verdict => ({
  testId: 'T',
  verdict: name,
  reason: `the engine said ${name}`,
  evaluations,
  verification: [],
});

describe('which cases the semantic run may take', () => {
  it('takes a rejected login with an error message', async () => {
    const c = await compiled(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED));
    assert.deepEqual(semanticSupport(c), { ok: true });
  });
  it('does not take a vague expected result', async () => {
    const c = await compiled(raw('T', ['Open the login page', 'Do the needful'], 'System works correctly'));
    const s = semanticSupport(c);
    assert.equal(s.ok, false);
    assert.ok(!s.ok && s.why.length > 0);
  });
  it('does not take a check the judge has no rule for', async () => {
    const c = await compiled(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED));
    assert.ok(c.ir);
    const odd = {
      ...c,
      ir: { ...c.ir, expectations: c.ir.expectations.map((e, i) => (i === 0 ? { ...e, condition: { ...e.condition, type: 'LAYOUT' as const } } : e)) },
    };
    const s = semanticSupport(odd as CompileResult);
    assert.equal(s.ok, false);
    assert.ok(!s.ok && /LAYOUT/.test(s.why), JSON.stringify(s));
  });
  it('does not take a case that did not compile', async () => {
    const c = await compiled(raw('T', ['Open the login page'], REJECTED));
    assert.equal(semanticSupport({ ...c, status: 'error' }).ok, false);
    assert.equal(semanticSupport({ ...c, ir: undefined }).ok, false);
  });
});

describe('the verdict of a semantic run, in the five statuses of the results sheet', () => {
  const model = parseTestCase(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED), config);

  it('keeps PASS and FAIL as the judge said them, and maps the rest without ever creating a PASS', async () => {
    const c = await compiled(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED));
    const expected: Record<VerdictName, string> = {
      PASS: 'PASS',
      FAIL: 'FAIL',
      NEEDS_REVIEW: 'NEEDS REVIEW',
      NOT_VERIFIED: 'NOT VERIFIED',
      BLOCKED: 'BLOCKED',
      UNSUPPORTED: 'NEEDS REVIEW',
      AUTOMATION_ERROR: 'NEEDS REVIEW',
      ENVIRONMENT_ERROR: 'BLOCKED',
      TEST_DATA_ERROR: 'BLOCKED',
    };
    for (const name of VERDICTS) {
      // A FAIL needs a disproven check to stand; give it one that is a plain failure (nothing was shown).
      const evals = name === 'FAIL' ? [evaluation({})] : [];
      const v = toTestVerdict(model, verdictOf(name, evals), traceOf([], []), c);
      assert.equal(v.status, expected[name], `${name} -> ${v.status}`);
      assert.equal(v.status === 'PASS', name === 'PASS', `only the judge's PASS is a PASS (${name})`);
    }
  });
  it('gives every NEEDS REVIEW a reason a tester can act on', async () => {
    const c = await compiled(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED));
    for (const name of ['NEEDS_REVIEW', 'UNSUPPORTED', 'AUTOMATION_ERROR'] as const) {
      const v = toTestVerdict(model, verdictOf(name), traceOf([], []), c);
      assert.equal(v.status, 'NEEDS REVIEW');
      assert.ok(v.reason.includes(`the engine said ${name}`));
      assert.ok(v.review && v.review.length > 0, 'a review reason');
    }
  });
  it('keeps a FAIL when the page showed no message at all', async () => {
    const c = await compiled(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED));
    const v = toTestVerdict(model, verdictOf('FAIL', [evaluation({})]), traceOf([], []), c);
    assert.equal(v.status, 'FAIL');
    assert.equal(v.category, 'Assertion');
  });
  it('sets a FAIL aside when a message was shown but in other words: the tester must say whether it is the appropriate one', async () => {
    const c = await compiled(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED));
    const v = toTestVerdict(model, verdictOf('FAIL', [evaluation({ actual: 'messages on the page: "Invalid Login"' })]), traceOf([], ['Invalid Login']), c);
    assert.equal(v.status, 'NEEDS REVIEW');
    assert.ok(JSON.stringify(v.review).includes('Invalid Login'), 'the message that was shown is in the reason');
  });
  it('still fails when the only message shown was already there before the step', async () => {
    const c = await compiled(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED));
    const v = toTestVerdict(model, verdictOf('FAIL', [evaluation({})]), traceOf(['Old banner'], ['Old banner']), c);
    assert.equal(v.status, 'FAIL');
  });
  it('writes a secret into no verdict', async () => {
    const c = await compiled(raw('T', ['Open the login page', "Click the 'Login' button"], REJECTED, { testData: `Password: ${SECRET}` }), {
      TEST_PASSWORD: SECRET,
    });
    for (const name of VERDICTS) {
      const v = toTestVerdict(model, verdictOf(name, name === 'FAIL' ? [evaluation({})] : []), traceOf([], []), c);
      assert.ok(!JSON.stringify(v).includes(SECRET), name);
    }
  });
});

const unattended: Resolver = { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false };
async function prepare(r: RawTestCase, engine: 'semantic' | 'legacy'): Promise<Prepared> {
  const dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-fallback-'));
  try {
    return await prepareCases([parseTestCase(r, config)], {
      config,
      baseUrl: 'http://127.0.0.1:1',
      env: { TEST_PASSWORD: 'x' },
      resolver: unattended,
      exploreDir: path.join(dir, 'explore'),
      engine,
      workspace: path.join(dir, 'ws'),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('where the semantic run is offered', () => {
  // The legacy parser cannot read "Fill in the password with …"; the new engine can.
  const legacyCannotRead = raw(
    'T-FB',
    ['Go to the login page', 'Fill in the username with admin', 'Fill in the password with abc', 'Hit Login'],
    'An error message is displayed',
  );
  const understoodNowhere = raw('T-NO', ['Open Login page', 'Do the needful'], 'System works correctly');

  it('offers it for a case the legacy parser cannot read, and keeps the legacy answer until it has run', async () => {
    const p = await prepare(legacyCannotRead, 'semantic');
    assert.equal(p.early.get('T-FB')?.status, 'NEEDS REVIEW', 'the legacy stop is still the answer until the run');
    assert.ok(p.semantic?.has('T-FB'), 'offered');
  });
  it('does not offer a case the new engine does not understand', async () => {
    const p = await prepare(understoodNowhere, 'semantic');
    assert.equal(p.early.get('T-NO')?.status, 'NEEDS REVIEW');
    assert.ok(!p.semantic?.has('T-NO'));
  });
  it('never offers anything in legacy mode, and the legacy answer is as before', async () => {
    const p = await prepare(legacyCannotRead, 'legacy');
    assert.equal(p.early.get('T-FB')?.status, 'NEEDS REVIEW');
    assert.ok(!p.semantic || p.semantic.size === 0);
  });
});

const legacyStop = (id: string): TestVerdict => ({
  executionId: '',
  testId: id,
  title: id,
  automationId: id,
  status: 'NEEDS REVIEW',
  reason: 'legacy stop',
  expected: '',
  actual: '',
  steps: [],
  checks: [],
  durationMs: 0,
  evidence: { screenshots: [] },
});

describe('semantic runs on the demo app', { skip }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  const login = (user: string, extra: string[] = []): string[] => [
    `Open ${'URL'}/`,
    `Enter '${user}' in the Username field`,
    'Enter password in the Password field',
    "Click the 'Login' button",
    ...extra,
  ];
  before(async () => {
    app = await startDemoApp();
  });
  after(async () => {
    await app?.close();
  });

  async function run(steps: string[], expected: string, password: string): Promise<Awaited<ReturnType<typeof runSemanticJobs>>> {
    const r = raw(
      'T-SEM',
      steps.map((s) => s.replace('URL', app.url)),
      expected,
      { testData: `Password: ${password}` },
    );
    const c = await compiled(r, {});
    assert.ok(semanticSupport(c).ok, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
    const job: SemanticJob = { model: parseTestCase(r, config), compiled: c, baseUrl: app.url, headless: true };
    return runSemanticJobs([job], {});
  }

  it('PASS: a wrong password is rejected with the error this click produced', async () => {
    const out = await run(login('demo'), REJECTED, 'nope');
    const v = out.get('T-SEM');
    assert.equal(v?.status, 'PASS', JSON.stringify(v?.review ?? v?.reason));
    assert.ok(v?.checks.every((c) => c.result === 'passed'));
    assert.ok(!JSON.stringify(v).includes('nope'), 'the password is not in the verdict');
  });
  it('FAIL: a good login is not a rejection, and nothing was shown', async () => {
    const out = await run(login('demo'), REJECTED, 'demo123');
    const v = out.get('T-SEM');
    assert.equal(v?.status, 'FAIL', JSON.stringify(v?.review ?? v?.reason));
    assert.ok(!JSON.stringify(v).includes('demo123'));
  });
  it('NEEDS REVIEW: an error was shown, but not the one the check names', async () => {
    const out = await run(login('demo'), 'Login is rejected and an error message "Account locked for 30 minutes" is displayed.', 'nope');
    const v = out.get('T-SEM');
    assert.equal(v?.status, 'NEEDS REVIEW', JSON.stringify(v));
    assert.ok(JSON.stringify(v?.review).includes('Invalid username or password'), 'the message that was shown is in the reason');
  });
  it('NEEDS REVIEW: an error that was already on the page proves nothing', async () => {
    const out = await run(login('demo', ["Click the 'Login' button"]), 'Error message "Invalid username or password" is displayed', 'nope');
    const v = out.get('T-SEM');
    assert.equal(v?.status, 'NEEDS REVIEW', JSON.stringify(v));
  });
  it('gives no verdict for a job whose case did not compile, so the legacy answer stays', async () => {
    const r = raw('T-BAD', ['Open the login page'], REJECTED);
    const c = await compiled(r);
    const out = await runSemanticJobs([{ model: parseTestCase(r, config), compiled: { ...c, ir: undefined }, baseUrl: app.url }], {});
    assert.equal(out.size, 0);
  });

  it('executeCases puts the semantic verdict where the legacy review was, and leaves other cases alone', async () => {
    const r = raw(
      'T-SEM',
      login('demo').map((s) => s.replace('URL', app.url)),
      REJECTED,
      { testData: 'Password: nope' },
    );
    const c = await compiled(r, {});
    const model = parseTestCase(r, config);
    const other = parseTestCase(raw('T-OTHER', ['Open the login page'], 'x'), config);
    const prepared: Prepared = {
      explored: [],
      early: new Map([
        ['T-SEM', legacyStop('T-SEM')],
        ['T-OTHER', legacyStop('T-OTHER')],
      ]),
      changes: [],
      semantic: new Map([['T-SEM', { model, compiled: c, baseUrl: app.url }]]),
    };
    const result = await executeCases([model, other], prepared, { env: {} });
    assert.equal(result.verdicts.find((v) => v.testId === 'T-SEM')?.status, 'PASS');
    assert.equal(result.verdicts.find((v) => v.testId === 'T-OTHER')?.reason, 'legacy stop');
  });
  it('executeCases without semantic jobs returns exactly the legacy verdicts', async () => {
    const model = parseTestCase(raw('T-L', ['Open the login page'], 'x'), config);
    const result = await executeCases([model], { explored: [], early: new Map([['T-L', legacyStop('T-L')]]), changes: [] }, { env: {} });
    assert.deepEqual(result.verdicts, [legacyStop('T-L')]);
  });
});
