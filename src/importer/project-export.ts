import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { Status, TestVerdict } from '../results/verdict.js';
import { COLORS, localTime } from './results.js';

/**
 * The whole project as one results workbook: every test case with what was written, how its last run ended,
 * the actual result and the screenshot itself inside the cell, so the sheet can be handed on as it is.
 */

export interface ExportCase {
  extId: string;
  title: string;
  type?: string;
  preconditions?: string;
  steps: string;
  testData?: string;
  expected: string;
  /** The last run's result; absent when the case has not been run. */
  verdict?: TestVerdict;
  /** Status when there is no verdict (e.g. the job was cancelled). */
  lastStatus?: string;
  lastRunAt?: string;
}

export const EXPORT_SHEET = 'Test Results';
const SHOT_WIDTH = 360;

const HEADERS = [
  ['Test Case ID', 14],
  ['Title', 30],
  ['Type', 12],
  ['Preconditions', 24],
  ['Steps', 44],
  ['Test Data', 24],
  ['Expected Result', 40],
  ['Status', 15],
  ['Actual Result', 60],
  ['Failed Step', 28],
  ['Executed At', 18],
  ['Automation ID', 16],
  ['Screenshot', 52],
] as const;

/** Width and height of a PNG from its header; undefined for anything else. */
function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** What the sheet says happened: the actual result and, when it did not pass, why. */
export function actualResult(c: ExportCase): string {
  const v = c.verdict;
  if (!v) return c.lastStatus ? `Not run to a result (${c.lastStatus}).` : 'Not run yet.';
  if (v.status === 'PASS') return v.actual;
  return `${v.actual}${v.reason && !v.actual.includes(v.reason) ? `\n${v.reason}` : ''}`;
}

export async function buildProjectExport(projectName: string, cases: ExportCase[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet(EXPORT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = HEADERS.map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  const totals: Record<string, number> = {};
  for (const [i, c] of cases.entries()) {
    const v = c.verdict;
    const status: Status | 'NOT RUN' = v?.status ?? 'NOT RUN';
    totals[status] = (totals[status] ?? 0) + 1;
    const row = ws.addRow([
      c.extId,
      c.title,
      c.type ?? '',
      c.preconditions ?? '',
      c.steps,
      c.testData ?? '',
      c.expected,
      status,
      actualResult(c),
      v?.failedStep ?? '',
      v?.startedAt ? localTime(v.startedAt) : c.lastRunAt ? localTime(c.lastRunAt) : '',
      v?.automationId ?? '',
      '',
    ]);
    row.alignment = { wrapText: true, vertical: 'top' };
    row.height = 60;
    if (status !== 'NOT RUN') {
      const cell = row.getCell(8);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS[status].fill } };
      cell.font = { bold: true, color: { argb: COLORS[status].font } };
    }

    // The screenshot goes into its cell, so the sheet carries the evidence and not a link that breaks when it is moved.
    const shot = v?.evidence.screenshots[0];
    const cell = row.getCell(13);
    if (!shot) {
      cell.value = v ? 'No screenshot was taken.' : '';
      continue;
    }
    const file = path.resolve(shot);
    if (!existsSync(file)) {
      cell.value = 'The screenshot file is no longer on disk.';
      continue;
    }
    const buffer = await readFile(file);
    const size = pngSize(buffer);
    const width = Math.min(SHOT_WIDTH, size?.width ?? SHOT_WIDTH);
    const height = size ? Math.round((size.height * width) / size.width) : Math.round(SHOT_WIDTH * 0.6);
    const imageId = workbook.addImage({ buffer: buffer as unknown as ExcelJS.Buffer, extension: 'png' });
    ws.addImage(imageId, { tl: { col: 12.05, row: i + 1.05 }, ext: { width, height }, editAs: 'oneCell' });
    row.height = Math.max(60, Math.round(height * 0.75) + 6);
  }

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 18 }, { width: 10 }];
  summary.addRow([`${projectName} results`]).font = { bold: true, size: 14 };
  summary.addRow(['Exported', localTime(new Date().toISOString())]);
  summary.addRow(['Test cases', cases.length]);
  for (const status of [...(Object.keys(COLORS) as Status[]), 'NOT RUN'] as const) {
    const r = summary.addRow([status, totals[status] ?? 0]);
    if (status !== 'NOT RUN') {
      r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS[status].fill } };
      r.getCell(1).font = { bold: true, color: { argb: COLORS[status].font } };
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
