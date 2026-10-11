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
    assert.equal(ws.rowCount, 4);
    assert.equal(ws.getRow(2).getCell(8).value, 'FAIL');
    assert.match(String(ws.getRow(2).getCell(9).value), /Stayed on \/login\.\nPage was \/login\./);
    assert.equal(ws.getRow(2).getCell(10).value, 'S2 Click Login');
    assert.equal(ws.getRow(3).getCell(8).value, 'NOT RUN');
    assert.equal(ws.getRow(3).getCell(9).value, 'Not run yet.');
    assert.match(String(ws.getRow(4).getCell(13).value), /no longer on disk/);
    assert.equal(ws.getImages().length, 1);
  });
});
