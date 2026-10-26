import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Status, TestVerdict } from '../results/verdict.js';
import { agreementOf, compareRow, compareTable } from './compare.js';

const verdict = (status: Status, reason = 'because'): TestVerdict =>
  ({
    executionId: '',
    testId: 'T',
    title: 't',
    automationId: 'T',
    status,
    reason,
    expected: '',
    actual: '',
    steps: [],
    checks: [],
    durationMs: 0,
    evidence: { screenshots: [] },
  }) as TestVerdict;

describe('compare mode', () => {
  it('says whether two engines agree', () => {
    assert.equal(agreementOf('PASS', 'PASS'), 'same');
    assert.equal(agreementOf('NEEDS REVIEW', 'NEEDS REVIEW'), 'same');
    assert.equal(agreementOf('PASS', 'FAIL'), 'conflict');
    assert.equal(agreementOf('FAIL', 'NOT VERIFIED'), 'conflict');
    assert.equal(agreementOf('NEEDS REVIEW', 'PASS'), 'new decides');
    assert.equal(agreementOf('PASS', 'NEEDS REVIEW'), 'legacy decides');
    assert.equal(agreementOf('PASS', 'NOT RUN'), 'new not run');
    assert.equal(agreementOf('NEEDS REVIEW', 'NOT RUN'), 'new not run');
  });

  it('a case the new engine did not run keeps its reason, and the legacy answer stands', () => {
    const row = compareRow({ testId: 'TC01', title: 'Browse', legacy: verdict('PASS'), next: undefined, notRun: 'E2 is a LAYOUT check', compile: 'compiled' });
    assert.equal(row.next.status, 'NOT RUN');
    assert.equal(row.next.reason, 'E2 is a LAYOUT check');
    assert.equal(row.agreement, 'new not run');
    assert.equal(row.legacy.status, 'PASS');
  });

  it('a case the legacy engine gave no verdict for counts as set aside', () => {
    const row = compareRow({ testId: 'TC01', title: 'Browse', legacy: undefined, next: verdict('PASS'), compile: 'compiled' });
    assert.equal(row.legacy.status, 'NEEDS REVIEW');
    assert.equal(row.agreement, 'new decides');
  });

  it('writes a table with one row per case, the totals of each engine and the agreement', () => {
    const rows = [
      compareRow({ testId: 'TC01', title: 'First', legacy: verdict('PASS', 'Every check passed.'), next: verdict('PASS', 'all proven'), compile: 'compiled' }),
      compareRow({
        testId: 'TC02',
        title: 'Second | with a pipe',
        legacy: verdict('NEEDS REVIEW', 'S2 asked'),
        next: verdict('FAIL', 'disproven'),
        compile: 'compiled',
      }),
      compareRow({ testId: 'TC03', title: 'Third', legacy: verdict('PASS'), next: undefined, notRun: 'not understood', compile: 'needs-review' }),
    ];
    rows[1].legacyIssues.push('S2 "Enter x": asked');
    rows[1].newIssues.push('E1 "y": not understood');
    const text = compareTable(rows);
    assert.ok(text.includes('## TC02: Second / with a pipe'), 'a case with issues gets a detail section');
    assert.ok(text.includes('- S2 "Enter x": asked') && text.includes('- E1 "y": not understood'));
    assert.ok(!text.includes('## TC01'), 'a case with nothing to report has none');
    const body = text.split('\n').filter((l) => l.startsWith('| TC'));
    assert.equal(body.length, 3);
    assert.ok(body[1].includes('Second / with a pipe'), 'a pipe in a title cannot break the table');
    assert.ok(text.includes('Legacy: 2 PASS · 1 NEEDS REVIEW'));
    assert.ok(text.includes('New engine: 1 PASS · 1 FAIL · 1 NOT RUN'));
    assert.ok(text.includes('Agreement: 1 same · 1 new decides · 1 new not run'));
  });
});
