import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import type { TestVerdict } from '../results/verdict.js';
import { buildProjectExport, EXPORT_SHEET, type ExportCase } from './project-export.js';

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const verdict = (status: TestVerdict['status'], actual: string, shot?: string, reason = ''): TestVerdict =>
  ({
    executionId: 'E1',
    testId: 'TC-1',
    title: 'Login',
    automationId: 'AUTO-1',
    status,
    reason,
    expected: '',
    actual,
    steps: [],
    checks: [],
    durationMs: 1,
    failedStep: status === 'FAIL' ? 'S2 Click Login' : undefined,
    evidence: { screenshots: shot ? [shot] : [] },
  }) as TestVerdict;

/** The number of a column of the sheet by its header, so a new column does not move what a test reads. */
const columnsOf = (ws: ExcelJS.Worksheet) => {
  const headers = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  return (name: string): number => {
    const at = headers.indexOf(name);
    assert.ok(at > 0, `no column "${name}"`);
    return at;
  };
};

describe('project results export', () => {
  it('lists every case with its actual result and the screenshot inside the sheet', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'export-'));
    const shot = path.join(dir, 'a.png');
    await writeFile(shot, PNG);
    const cases: ExportCase[] = [
      { extId: 'TC-1', title: 'Login', steps: '1. Open', expected: 'Dashboard', verdict: verdict('FAIL', 'Stayed on /login.', shot, 'Page was /login.') },
      { extId: 'TC-2', title: 'Never run', steps: '1. Open', expected: 'x' },
      { extId: 'TC-3', title: 'Gone', steps: '1. Open', expected: 'x', verdict: verdict('PASS', 'Worked.', path.join(dir, 'missing.png')) },
    ];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildProjectExport('Demo', cases)) as never);
    const ws = wb.getWorksheet(EXPORT_SHEET)!;
    const col = columnsOf(ws);
    assert.equal(ws.rowCount, 4);
    assert.equal(ws.getRow(2).getCell(col('Status')).value, 'FAIL');
    assert.match(String(ws.getRow(2).getCell(col('Actual Result')).value), /Stayed on \/login\.\nPage was \/login\./);
    assert.equal(ws.getRow(2).getCell(col('Failed Step')).value, 'S2 Click Login');
    assert.equal(ws.getRow(3).getCell(col('Status')).value, 'NOT RUN');
    assert.equal(ws.getRow(3).getCell(col('Actual Result')).value, 'Not run yet.');
    assert.match(String(ws.getRow(4).getCell(col('Screenshot')).value), /no longer on disk/);
    assert.equal(ws.getImages().length, 1);
  });
});

describe('E0.18 step 7: the export shows why a case needs review and what a person decided', () => {
  it('Review Reason and Decision beside the engine status, which the decision does not change; the summary counts decided cases', async () => {
    const needs = { ...verdict('NEEDS REVIEW', 'no menu item called "Profile"', undefined, 'E1 is unproven'), label: 'inconclusive' as const };
    const cases: ExportCase[] = [
      {
        extId: 'TC-1',
        title: 'First page',
        steps: '1. Open',
        expected: 'Profile is the default page',
        verdict: needs,
        decision: { decision: 'PASS', reviewer: 'Owner', decidedAt: '2026-11-07T10:00:00.000Z', note: 'Profile is right for this user' },
      },
      { extId: 'TC-2', title: 'Login', steps: '1. Open', expected: 'Dashboard', verdict: verdict('PASS', 'Worked.') },
    ];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildProjectExport('Demo', cases)) as never);
    const ws = wb.getWorksheet(EXPORT_SHEET)!;
    const col = columnsOf(ws);
    assert.equal(ws.getRow(2).getCell(col('Status')).value, 'NEEDS REVIEW', 'the engine status stays');
    assert.ok(String(ws.getRow(2).getCell(col('Review Reason')).value).startsWith('inconclusive: '));
    const decided = String(ws.getRow(2).getCell(col('Decision')).value);
    assert.ok(decided.startsWith('PASS by Owner, ') && decided.endsWith('(Profile is right for this user)'), decided);
    assert.equal(ws.getRow(3).getCell(col('Review Reason')).value ?? '', '');
    assert.equal(ws.getRow(3).getCell(col('Decision')).value ?? '', '');
    const summary = wb.getWorksheet('Summary')!;
    const row = (summary.getSheetValues() as unknown[][]).find((r) => Array.isArray(r) && r[1] === 'Decided by a person');
    assert.equal(row?.[2], 1);
  });
});
