import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { buildDemoWorkbook } from '../../examples/demo-app/make-workbook.js';
import { normKey } from '../parser/config.js';
import type { TestVerdict } from '../results/verdict.js';
import { findHeaderRow, HEADER_NAMES, matchColumns } from './columns.js';
import { type BatchSummary, defaultResultsFile, RESULT_COLUMNS, SUMMARY_SHEET, writeResults } from './results.js';
import { readWorkbook } from './workbook.js';

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-import-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('column matching (FR-IN-09)', () => {
  it('knows the usual header names', () => {
    const r = matchColumns([
      'S.No',
      'Test Case ID',
      'Test Case Name',
      'Pre-Conditions',
      'Steps to Reproduce',
      'Input Data',
      'Expected Results',
      'Priority',
      'Req ID',
    ]);
    assert.deepEqual(r.map, { id: 2, title: 3, preconditions: 4, steps: 5, testData: 6, expected: 7, requirementId: 9 });
    assert.deepEqual(r.unmatched, ['S.No', 'Priority']);
    assert.deepEqual(r.missing, []);
  });

  it('never gives two fields the same header name', () => {
    const owner = new Map<string, string>();
    for (const [field, names] of Object.entries(HEADER_NAMES)) {
      for (const n of names) {
        const key = normKey(n);
        assert.ok(!owner.has(key) || owner.get(key) === field, `"${n}" is both ${owner.get(key)} and ${field}`);
        owner.set(key, field);
      }
    }
  });

  it('lets a mapping name an unusual header, and says what is missing', () => {
    const r = matchColumns(['Scenario', 'What to do', 'Outcome'], { steps: 'What to do', expected: 'outcome' });
    assert.deepEqual(r.map, { title: 1, steps: 2, expected: 3 });
    assert.deepEqual(matchColumns(['Title', 'Notes']).missing, ['steps', 'expected']);
    assert.throws(() => matchColumns(['Title'], { steps: 'Nope' }), /no such column/);
  });

  it('finds the header row under a title row', () => {
    assert.equal(findHeaderRow([['Regression suite'], [], ['Title', 'Steps', 'Expected Result']]), 2);
    assert.equal(findHeaderRow([['Notes only']]), undefined);
  });
});

describe('workbook import (FR-IN-01)', () => {
  it("reads a tester's sheet: rows, problems and duplicate IDs", async () => {
    const file = path.join(dir, 'suite.xlsx');
    const written = await buildDemoWorkbook(file, 12);
    const r = await readWorkbook(file);
    assert.equal(r.sheet, 'Regression');
    assert.equal(r.headerRow, 2);
    assert.deepEqual(r.unmatched, ['S.No', 'Priority']);
    assert.equal(r.cases.length + r.problems.length, written.length);
    assert.deepEqual(
      r.problems.map((p) => p.text),
      [`Row ${written.find((w) => w.kind === 'incomplete')?.row} has no Steps.`],
    );
    assert.match(r.warnings[0], /^TC-DEMO-005 is on rows 7 and 8; the second is TC-DEMO-005-R8\.$/);
    const first = r.cases[0];
    assert.equal(first.row, 3);
    assert.match(first.raw.steps, /^1\. Open Login page\n2\. /);
  });

  it('reads a CSV with semicolons and multi-line cells', async () => {
    const file = path.join(dir, 'suite.csv');
    await writeFile(file, '﻿Test Case;Test Steps;Expected Result\r\nLogin;"1. Open Login page\n2. Click Login";User is redirected to Dashboard page\r\n');
    const r = await readWorkbook(file);
    assert.equal(r.format, 'csv');
    assert.deepEqual(
      r.cases.map((c) => [c.raw.title, c.raw.steps]),
      [['Login', '1. Open Login page\n2. Click Login']],
    );
  });

  it('explains a sheet it cannot use', async () => {
    const file = path.join(dir, 'bad.xlsx');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(['Name', 'Notes']);
    await wb.xlsx.writeFile(file);
    await assert.rejects(readWorkbook(file), /no sheet has a header row/);
    await assert.rejects(readWorkbook(path.join(dir, 'old.xls')), /save as \.xlsx/);
  });
});

describe('results written back (FR-HI-06, D23)', () => {
  const verdict = (testId: string, status: TestVerdict['status'], actual: string, screenshot?: string): TestVerdict => ({
    executionId: 'EXEC-2026-00001',
    testId,
    title: testId,
    automationId: `AUTO-${testId}`,
    status,
    reason: status === 'PASS' ? 'Every check passed.' : 'A check failed at A1: the application did not do what the test case expects.',
    failedStep: status === 'FAIL' ? 'A1: Error is shown' : undefined,
    expected: 'x',
    actual,
    steps: [],
    checks: [],
    durationMs: 1,
    startedAt: '2026-09-30T10:00:00.000Z',
    evidence: { screenshots: screenshot ? [screenshot] : [] },
  });
  const summary: BatchSummary = {
    executionId: 'EXEC-2026-00001',
    finishedAt: '2026-09-30T10:05:00.000Z',
    totals: { PASS: 1, FAIL: 1, BLOCKED: 0, 'NEEDS REVIEW': 1, 'NOT VERIFIED': 0 },
    review: [{ row: 5, testId: 'TC-3', title: 'Vague', question: 'S2 could not be read.' }],
  };
  const hash = (f: string) => createHash('sha1').update(readFileSync(f)).digest('hex');

  it('adds result columns to a copy, keeps the original and its formatting', async () => {
    const file = path.join(dir, 'results-src.xlsx');
    await buildDemoWorkbook(file, 12);
    const before = hash(file);
    const imported = await readWorkbook(file);
    const shot = path.join(dir, 'shot.png');
    await writeFile(shot, 'png');
    const [a, b, c] = imported.cases;
    const out = defaultResultsFile(file);
    await writeResults(
      imported,
      [
        { row: a.row, verdict: verdict('TC-1', 'PASS', 'Went to Dashboard page.') },
        { row: b.row, verdict: verdict('TC-2', 'FAIL', 'Page was /.', shot) },
        { row: c.row, problem: 'Row has no Steps.' },
      ],
      summary,
      out,
    );
    assert.equal(hash(file), before, 'the original is never changed');
    assert.equal(out, path.join(dir, 'results-src.results.xlsx'));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const ws = wb.getWorksheet('Regression')!;
    const header = (ws.getRow(2).values as string[]).slice(1);
    assert.deepEqual(header.slice(-RESULT_COLUMNS.length), [...RESULT_COLUMNS]);
    const col = (name: string) => header.indexOf(name) + 1;
    assert.equal(ws.getCell('A1').text, 'Demo app regression suite');
    assert.equal(ws.getRow(a.row).getCell(col('Status')).text, 'PASS');
    assert.equal((ws.getRow(b.row).getCell(col('Status')).fill as ExcelJS.FillPattern).fgColor?.argb, 'FFFFC7CE');
    assert.match(ws.getRow(b.row).getCell(col('Actual Result')).text, /^Page was \/\.\nA check failed at A1/);
    assert.equal(ws.getRow(b.row).getCell(col('Failed Step')).text, 'A1: Error is shown');
    assert.deepEqual(ws.getRow(b.row).getCell(col('Evidence')).value, { text: 'Screenshot', hyperlink: 'shot.png' });
    assert.equal(ws.getRow(c.row).getCell(col('Status')).text, 'NEEDS REVIEW');
    assert.equal(ws.getRow(c.row).getCell(col('Actual Result')).text, 'Not run: Row has no Steps.');
    const s = wb.getWorksheet(SUMMARY_SHEET)!;
    assert.equal(s.getCell('B2').text, 'EXEC-2026-00001');
    assert.equal(s.getRow(12).getCell(1).text, 'TC-3');

    // Running again on the results copy reuses its columns instead of adding more.
    const again = await readWorkbook(out);
    await writeResults(again, [{ row: a.row, verdict: verdict('TC-1', 'FAIL', 'Page was /.') }], summary, path.join(dir, 'again.xlsx'));
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(path.join(dir, 'again.xlsx'));
    const header2 = (wb2.getWorksheet('Regression')!.getRow(2).values as string[]).slice(1);
    assert.equal(header2.filter((h) => h === 'Status').length, 1);
    assert.equal(wb2.worksheets.filter((w) => w.name === SUMMARY_SHEET).length, 1);
  });

  it('never writes over the workbook it read', async () => {
    const file = path.join(dir, 'self.xlsx');
    await buildDemoWorkbook(file, 12);
    await assert.rejects(writeResults(await readWorkbook(file), [], summary, file), /must go to a copy/);
  });
});
