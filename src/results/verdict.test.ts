import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskVerdict } from '../executor/runner.js';
import { masker } from '../explorer/values.js';
import type { ManifestTest } from '../generator/plan.js';
import { type PageFacts, type ReportedTest, verdictFor } from './verdict.js';

const test: ManifestTest = {
  testId: 'TC-1',
  title: 'Login works',
  automationId: 'AUTO-1',
  file: 'tests/tc-1.spec.ts',
  steps: [
    { id: 'S1', raw: 'Open Login page', action: 'navigate' },
    { id: 'S2', raw: 'Enter valid username', action: 'fill' },
    { id: 'S3', raw: 'Click Login', action: 'click' },
  ],
  checks: [
    { id: 'A1', raw: 'User is redirected to Dashboard page', type: 'url', expected: 'Dashboard', negated: false },
    { id: 'A2', raw: 'Dashboard heading is displayed', type: 'visible', target: 'Dashboard', negated: false },
    { id: 'A3', raw: '', type: 'health', negated: false },
  ],
  unparsed: [],
};

const facts: PageFacts = {
  url: 'http://app/',
  path: '/',
  title: 'Login',
  headings: ['Sign in'],
  messages: ['Invalid username or password'],
  invalid: [],
  problems: [],
};

const ok = (title: string) => ({ title, status: 'passed' as const, duration: 10 });
const bad = (title: string, error: string) => ({ title, status: 'failed' as const, duration: 10, error });
const reported = (over: Partial<ReportedTest>): ReportedTest => ({
  testId: 'TC-1',
  title: 'TC-1: Login works',
  status: 'passed',
  expectedStatus: 'passed',
  duration: 1234,
  startedAt: '2026-09-30T10:00:00.000Z',
  steps: [ok('S1: Open Login page'), ok('S2, S3: Enter valid username; Click Login'), ok('A1: …'), ok('A2: …')],
  errors: [],
  facts: { ...facts, path: '/dashboard', headings: ['Dashboard'], messages: [] },
  screenshots: [],
  ...over,
});
const ctx = { executionId: 'EXEC-2026-00001' };

describe('verdicts (FR-VAL-01…05)', () => {
  it('passes when every check passed, with an actual for each', () => {
    const v = verdictFor(test, reported({}), ctx);
    assert.equal(v.status, 'PASS');
    assert.deepEqual(
      v.checks.map((c) => [c.id, c.result, c.actual]),
      [
        ['A1', 'passed', 'Went to Dashboard page'],
        ['A2', 'passed', '"Dashboard" was visible'],
        ['A3', 'passed', 'No errors on the page'],
      ],
    );
    assert.deepEqual(
      v.steps.map((s) => s.result),
      ['passed', 'passed', 'passed'],
    );
    assert.equal(v.executionId, 'EXEC-2026-00001');
  });

  it('fails a check with what the page actually showed', () => {
    const v = verdictFor(
      test,
      reported({
        status: 'failed',
        steps: [
          ok('S1: Open'),
          ok('S2, S3: Enter; Click'),
          bad('A1: User is redirected', 'Error: page path is /dashboard\n\nExpected: "/dashboard"\nReceived: "/"'),
        ],
        errors: ['Error: page path is /dashboard'],
        facts,
      }),
      ctx,
    );
    assert.equal(v.status, 'FAIL');
    assert.equal(v.category, 'Assertion');
    assert.equal(v.failedStep, 'A1: User is redirected');
    assert.equal(v.actual, 'Page was /. The page showed heading "Sign in"; message "Invalid username or password".');
    assert.deepEqual(
      v.checks.map((c) => c.result),
      ['failed', 'not run', 'passed'],
    );
  });

  it('says an element was not found', () => {
    const v = verdictFor(
      test,
      reported({
        status: 'failed',
        steps: [
          ok('S1: Open'),
          ok('S2, S3: x'),
          ok('A1: x'),
          bad(
            'A2: Dashboard heading',
            'Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole(...)\nExpected: visible\nError: element(s) not found',
          ),
        ],
        facts,
      }),
      ctx,
    );
    assert.match(v.actual, /^"Dashboard" was not found\. The page showed page \/;/);
  });

  it('labels a missing element in a step as a locator failure', () => {
    const v = verdictFor(
      test,
      reported({
        status: 'failed',
        steps: [
          ok('S1: Open'),
          bad('S2, S3: Enter; Click', "TimeoutError: locator.fill: Timeout 30000ms exceeded.\nwaiting for getByRole('textbox', { name: 'Username' })"),
        ],
      }),
      ctx,
    );
    assert.equal(v.status, 'FAIL');
    assert.equal(v.category, 'Locator');
    assert.deepEqual(
      v.steps.map((s) => s.result),
      ['passed', 'failed', 'failed'],
    );
    assert.match(v.reason, /re-discover/);
  });

  it('fails a test whose page had errors, even when every step passed (FR-VAL-04)', () => {
    const v = verdictFor(test, reported({ status: 'failed', errors: ['Error: Health check failed: 500 from GET /api/x; uncaught error: boom'] }), ctx);
    assert.equal(v.status, 'FAIL');
    assert.equal(v.category, 'Application');
    assert.deepEqual(v.checks[2], {
      id: 'A3',
      raw: 'No crash',
      expected: 'No errors on the page',
      actual: '500 from GET /api/x; uncaught error: boom',
      result: 'failed',
    });
  });

  it('blocks a test the environment stopped', () => {
    const net = verdictFor(
      test,
      reported({ status: 'failed', steps: [bad('S1: Open', 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4999/')] }),
      ctx,
    );
    assert.deepEqual([net.status, net.category], ['BLOCKED', 'Network']);
    const missing = verdictFor(test, undefined, { ...ctx, missingEnv: ['TEST_PASSWORD'] });
    assert.deepEqual(
      [missing.status, missing.category, missing.reason],
      ['BLOCKED', 'Test Data', "Set TEST_PASSWORD in the environment or the workspace's .env."],
    );
    assert.deepEqual([verdictFor(test, undefined, ctx).status], ['BLOCKED']);
  });

  it('blocks, not fails, when the login of a precondition fails', () => {
    const v = verdictFor(
      test,
      reported({ status: 'failed', steps: [bad('Precondition · S2, S3, S4: Enter …; Click Login', 'Error: page path is /dashboard')] }),
      ctx,
    );
    assert.deepEqual([v.status, v.category], ['BLOCKED', 'Authentication']);
  });

  it('never blames the application for an error in the generated test', () => {
    const v = verdictFor(
      test,
      reported({ status: 'failed', steps: [ok('S1: x'), ok('S2, S3: x'), bad('A1: x', 'ReferenceError: DashboardPage is not defined')] }),
      ctx,
    );
    assert.deepEqual([v.status, v.category], ['BLOCKED', 'Environment']);
    assert.match(v.reason, /a problem in Auto QA, not in the application/);
    assert.doesNotMatch(v.actual, /Page was/);
    for (const error of ['SyntaxError: Unexpected token )', "TypeError: Cannot read properties of undefined (reading 'click')"]) {
      const w = verdictFor(test, reported({ status: 'failed', steps: [ok('S1: x'), bad('S2, S3: x', error)] }), ctx);
      assert.deepEqual([w.status, w.category], ['BLOCKED', 'Environment'], error);
    }
  });

  it('needs review when a check could not be read, even if the test passed', () => {
    const v = verdictFor({ ...test, unparsed: ['A2'] }, reported({}), ctx);
    assert.equal(v.status, 'NEEDS REVIEW');
    assert.equal(v.checks[1].result, 'not checked');
    assert.match(v.reason, /A2 could not be read/);
  });

  it("masks secrets in what the run produced, not in the tester's words (FR-EV-03)", () => {
    const titled = { ...test, title: 'Wrong password is rejected' };
    const v = verdictFor(
      titled,
      reported({
        status: 'failed',
        steps: [ok('S1: x'), bad('S2, S3: Enter wrong password', 'Error: value was "wrong"')],
        screenshots: ['reports/tc-wrong/shot.png'],
      }),
      ctx,
    );
    const m = maskVerdict(v, masker(['wrong']));
    assert.equal(m.title, 'Wrong password is rejected');
    assert.equal(m.steps[1].raw, 'Enter valid username');
    assert.equal(m.error, 'Error: value was "••••"');
    assert.doesNotMatch(m.actual, /"wrong"/);
    assert.deepEqual(m.evidence.screenshots, ['reports/tc-wrong/shot.png']);
  });

  it('counts a timeout as its own category', () => {
    const v = verdictFor(test, reported({ status: 'timedOut', steps: [ok('S1: x'), bad('S2, S3: x', 'Test timeout of 30000ms exceeded.')] }), ctx);
    assert.deepEqual([v.status, v.category], ['FAIL', 'Timeout']);
  });
});
