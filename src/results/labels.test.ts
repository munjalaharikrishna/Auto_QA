import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ManifestTest } from '../generator/plan.js';
import { labelCounts, labelOf, REVIEW_LABELS, withLabels } from './labels.js';
import { formatVerdict, summaryLine } from './report.js';
import { type ReportedTest, type TestVerdict, verdictFor } from './verdict.js';

/**
 * E0.18 step 4: every NEEDS REVIEW says why in one word (owner, 7 Nov 2026: the five statuses stay; the reason is a label inside
 * NEEDS REVIEW). A test that passes only on a retry is flaky, never PASS.
 */

const review = (reason: string, over: Partial<TestVerdict> = {}): TestVerdict => ({
  executionId: 'EXEC-1',
  testId: 'T',
  title: 'T',
  automationId: 'T',
  status: 'NEEDS REVIEW',
  reason,
  expected: '',
  actual: '',
  steps: [],
  checks: [],
  durationMs: 1,
  evidence: { screenshots: [] },
  ...over,
});

describe('E0.18 step 4: the reason label of a NEEDS REVIEW', () => {
  it('is read from the stop when the run did not set one', () => {
    const cases: Array<[string, string]> = [
      ['LOCATE_NOT_FOUND at S5: nothing on the page is called "Save"', 'not-found'],
      ['PAGE_UNKNOWN at S1: no address is known for the page "Reports"', 'not-found'],
      ['LOCATE_INACTIVE at S3: found by role, but it cannot be used: disabled', 'hidden'],
      ['LOCATE_AMBIGUOUS at S2: 2 equal candidates found by role', 'ambiguous'],
      ['ROW_AMBIGUOUS at S2: 2 rows hold "anita rao"', 'ambiguous'],
      ['step 2 "Do the needful": not understood: the sentence fits none of the grammar models', 'wording'],
      ['E2 "Login section should be middle of the page" is unproven: the box and the panel are not in the same place', 'inconclusive'],
      ['S7 "Click Edit": 4 buttons called "Edit" are alike: the first on the page was used', 'chosen'],
    ];
    for (const [reason, label] of cases) assert.equal(labelOf(review(reason)), label, reason);
  });

  it('the one the run set wins; a status other than NEEDS REVIEW has none', () => {
    assert.equal(labelOf(review('LOCATE_NOT_FOUND …', { label: 'healed' })), 'healed');
    assert.equal(labelOf(review('anything', { status: 'FAIL' })), undefined);
    assert.equal(labelOf(review('anything', { status: 'PASS', label: 'flaky' })), undefined);
  });

  it('withLabels sets every NEEDS REVIEW and clears the others; the counts follow the fixed order', () => {
    const out = withLabels([review('LOCATE_NOT_FOUND x'), review('ok', { status: 'PASS', label: 'flaky' }), review('x', { label: 'flaky' })]);
    assert.deepEqual(
      out.map((v) => v.label),
      ['not-found', undefined, 'flaky'],
    );
    assert.deepEqual(labelCounts(out), [
      ['flaky', 1],
      ['not-found', 1],
    ]);
    assert.ok(REVIEW_LABELS.indexOf('flaky') < REVIEW_LABELS.indexOf('not-found'));
  });

  it('the report shows the label after NEEDS REVIEW and counts them in the summary', () => {
    const v = review('LOCATE_NOT_FOUND at S5', { label: 'not-found' });
    assert.ok(formatVerdict(v).includes('? NEEDS REVIEW (not-found)'), formatVerdict(v));
    assert.ok(summaryLine([v, review('x', { label: 'flaky' })]).includes('2 need review (1 flaky, 1 not-found)'));
  });
});

describe('E0.18 step 4: a test that passes only on a retry is flaky, never PASS', () => {
  const test: ManifestTest = {
    testId: 'TC-1',
    title: 'Status',
    automationId: 'AUTO-1',
    file: 'tests/tc-1.spec.ts',
    steps: [{ id: 'S1', raw: 'Open the application', action: 'navigate' }],
    checks: [{ id: 'A1', raw: 'Message "Ready" is shown', type: 'text', expected: 'Ready', negated: false }],
    unparsed: [],
  };
  const reported = (over: Partial<ReportedTest>): ReportedTest => ({
    testId: 'TC-1',
    title: 'TC-1: Status',
    status: 'passed',
    expectedStatus: 'passed',
    duration: 10,
    startedAt: '2026-11-07T10:00:00.000Z',
    steps: [
      { title: 'S1: Open the application', status: 'passed', duration: 5 },
      { title: 'A1: Message "Ready" is shown', status: 'passed', duration: 5 },
    ],
    errors: [],
    screenshots: [],
    ...over,
  });

  it('a pass on the first attempt is a PASS; a pass on a retry is NEEDS REVIEW, flaky', () => {
    assert.equal(verdictFor(test, reported({ retry: 0, flaky: false }), { executionId: 'E' }).status, 'PASS');
    const v = verdictFor(test, reported({ retry: 1, flaky: true }), { executionId: 'E' });
    assert.equal(v.status, 'NEEDS REVIEW');
    assert.equal(v.label, 'flaky');
    assert.ok(v.reason.includes('passed only on retry'), v.reason);
  });

  it('results of runs from before retries (no retry field) are read as before', () => {
    assert.equal(verdictFor(test, reported({}), { executionId: 'E' }).status, 'PASS');
  });
});
