import path from 'node:path';
import type ExcelJS from 'exceljs';
import type { Status, TestVerdict } from '../results/verdict.js';
import { type ImportResult, loadWorkbook } from './workbook.js';

/**
 * Results written back to the workbook (FR-HI-06, D23): a copy of the tester's file with result columns
 * next to each test case, and an "Auto QA" sheet with the summary and the review queue (FR-HI-07).
 * The original is never changed. Running again updates the same columns.
 */

export const RESULT_COLUMNS = ['Status', 'Actual Result', 'Failed Step', 'Executed At', 'Automation ID', 'Evidence'] as const;
export const SUMMARY_SHEET = 'Auto QA';

/** Row result: a verdict, or a row that could not be read as a test case. */
export interface RowResult {
  row: number;
  verdict?: TestVerdict;
  problem?: string;
  /** For a row that is not a complete test case: its ID and title as written, if any. */
  id?: string;
  title?: string;
}

export interface BatchSummary {
  executionId?: string;
  finishedAt: string;
  totals: Record<Status, number>;
  /** Cases the tester must look at: what was asked or what could not be read. */
  review: Array<{ row: number; testId: string; title: string; step?: string; question: string }>;
}

const COLORS: Record<Status, { fill: string; font: string }> = {
  PASS: { fill: 'FFC6EFCE', font: 'FF006100' },
  FAIL: { fill: 'FFFFC7CE', font: 'FF9C0006' },
  BLOCKED: { fill: 'FFD9D9D9', font: 'FF3F3F3F' },
  'NEEDS REVIEW': { fill: 'FFFFEB9C', font: 'FF9C5700' },
  'NOT VERIFIED': { fill: 'FFDDEBF7', font: 'FF1F4E78' },
};

export function defaultResultsFile(file: string): string {
  const ext = path.extname(file);
  const base = file.slice(0, -ext.length).replace(/\.results$/, '');
  return `${base}.results${ext}`;
}

export async function writeResults(imported: ImportResult, results: RowResult[], summary: BatchSummary, out: string): Promise<void> {
  if (path.resolve(out) === path.resolve(imported.file)) throw new Error(`Results must go to a copy, not ${imported.file} itself (D23). Choose another --out.`);
  const { workbook } = await loadWorkbook(imported.file);
  const sheet = workbook.getWorksheet(imported.sheet) ?? workbook.worksheets[0];
  const header = sheet.getRow(imported.headerRow);

  // Existing result columns (a results file used as input) are reused; new ones go after the last header.
  const cols: Record<(typeof RESULT_COLUMNS)[number], number> = {} as never;
  let next = imported.headers.length + 1;
  const style = header.getCell(Math.max(1, imported.headers.length)).style;
  for (const name of RESULT_COLUMNS) {
    const found = imported.headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
    cols[name] = found >= 0 ? found + 1 : next++;
    const cell = header.getCell(cols[name]);
    cell.value = name;
    cell.style = { ...style, font: { ...(style.font ?? {}), bold: true } };
  }
  sheet.getColumn(cols['Actual Result']).width = 60;
  sheet.getColumn(cols['Failed Step']).width = 30;
  sheet.getColumn(cols.Status).width = 15;
  sheet.getColumn(cols['Executed At']).width = 18;
  sheet.getColumn(cols['Automation ID']).width = 16;

  const outDir = path.dirname(path.resolve(out));
  for (const r of results) {
    const row = sheet.getRow(r.row);
    const v = r.verdict;
    const status: Status = v?.status ?? 'NEEDS REVIEW';
    const statusCell = row.getCell(cols.Status);
    statusCell.value = status;
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS[status].fill } };
    statusCell.font = { bold: true, color: { argb: COLORS[status].font } };
    const actual = row.getCell(cols['Actual Result']);
    actual.value = v
      ? v.status === 'PASS'
        ? v.actual
        : `${v.actual}${v.reason && !v.actual.includes(v.reason) ? `\n${v.reason}` : ''}`
      : `Not run: ${r.problem}`;
    actual.alignment = { wrapText: true, vertical: 'top' };
    row.getCell(cols['Failed Step']).value = v?.failedStep ?? null;
    row.getCell(cols['Executed At']).value = v?.startedAt ? localTime(v.startedAt) : localTime(summary.finishedAt);
    row.getCell(cols['Automation ID']).value = v?.automationId ?? null;
    const shot = v?.evidence.screenshots[0];
    const evidence = row.getCell(cols.Evidence);
    evidence.value = shot ? { text: 'Screenshot', hyperlink: path.relative(outDir, path.resolve(shot)).replace(/\\/g, '/') } : null;
    if (shot) evidence.font = { color: { argb: 'FF0563C1' }, underline: true };
    row.commit();
  }

  if (imported.format === 'xlsx') {
    addSummarySheet(workbook, summary);
    await workbook.xlsx.writeFile(out);
  } else {
    await workbook.csv.writeFile(out, { sheetName: sheet.name });
  }
}

function addSummarySheet(workbook: ExcelJS.Workbook, summary: BatchSummary): void {
  const old = workbook.getWorksheet(SUMMARY_SHEET);
  if (old) workbook.removeWorksheet(old.id);
  const ws = workbook.addWorksheet(SUMMARY_SHEET);
  ws.columns = [{ width: 18 }, { width: 8 }, { width: 45 }, { width: 22 }, { width: 80 }];
  const bold = { font: { bold: true } };
  ws.addRow(['Auto QA results']).font = { bold: true, size: 14 };
  ws.addRow(['Execution', summary.executionId ?? '—']);
  ws.addRow(['Finished', localTime(summary.finishedAt)]);
  for (const status of Object.keys(COLORS) as Status[]) {
    const row = ws.addRow([status, summary.totals[status]]);
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS[status].fill } };
    row.getCell(1).font = { bold: true, color: { argb: COLORS[status].font } };
  }
  ws.addRow([]);
  ws.addRow(['Review queue']).font = { bold: true, size: 12 };
  if (!summary.review.length) {
    ws.addRow(['Nothing to review.']);
    return;
  }
  const head = ws.addRow(['Test case', 'Row', 'Title', 'Step', 'What is needed']);
  head.eachCell((c) => {
    c.style = bold;
  });
  for (const q of summary.review) {
    const row = ws.addRow([q.testId, q.row, q.title, q.step ?? '', q.question]);
    row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
  }
}

/** 2026-09-30T10:32:54Z → "2026-09-30 16:02" in the machine's time zone. */
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
