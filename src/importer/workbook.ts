import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { RawTestCase } from '../model/test-model.js';
import { type ColumnMap, type Field, findHeaderRow, matchColumns } from './columns.js';

/**
 * Excel/CSV import (FR-IN-01, D21): the test case rows of a workbook, with their row numbers so results
 * can be written back next to them (FR-HI-06). Rows that cannot be read are reported, not dropped.
 */

export interface ImportedCase {
  raw: RawTestCase;
  /** 1-based sheet row. */
  row: number;
}

export interface RowProblem {
  row: number;
  id?: string;
  title?: string;
  text: string;
}

export interface ImportResult {
  file: string;
  format: 'xlsx' | 'csv';
  sheet: string;
  /** 1-based. */
  headerRow: number;
  headers: string[];
  columns: ColumnMap;
  /** Headers that are not test case fields, e.g. "Priority". Left as they are. */
  unmatched: string[];
  cases: ImportedCase[];
  /** Rows that are not test cases as written, e.g. with no steps. They get NEEDS REVIEW in the results. */
  problems: RowProblem[];
  /** Duplicate IDs that were renamed, e.g. TC-5 on rows 7 and 9 → the second is TC-5-R9. */
  warnings: string[];
}

export interface ImportOptions {
  /** Worksheet name. Default: the first sheet with a header row. */
  sheet?: string;
  /** `{ field: header }` for headers the automatic matching does not know (FR-IN-09). */
  mapping?: Partial<Record<Field, string>>;
}

export async function loadWorkbook(file: string): Promise<{ workbook: ExcelJS.Workbook; format: 'xlsx' | 'csv' }> {
  const workbook = new ExcelJS.Workbook();
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') {
    await workbook.xlsx.readFile(file);
    return { workbook, format: 'xlsx' };
  }
  if (ext === '.csv') {
    await workbook.csv.readFile(file, { parserOptions: { delimiter: await guessDelimiter(file) } });
    return { workbook, format: 'csv' };
  }
  throw new Error(`${file}: only .xlsx and .csv workbooks can be imported (old .xls files: save as .xlsx first).`);
}

export async function readWorkbook(file: string, options: ImportOptions = {}): Promise<ImportResult> {
  const { workbook, format } = await loadWorkbook(file);
  const sheets = options.sheet ? [workbook.getWorksheet(options.sheet)].filter((s): s is ExcelJS.Worksheet => !!s) : workbook.worksheets;
  if (options.sheet && !sheets.length) throw new Error(`${file} has no sheet "${options.sheet}". Sheets: ${workbook.worksheets.map((s) => s.name).join(', ')}`);

  for (const sheet of sheets) {
    const rows = rowsOf(sheet);
    const header = findHeaderRow(rows, options.mapping);
    if (header === undefined) continue;
    const headers = rows[header].map((h) => h ?? '');
    const match = matchColumns(headers, options.mapping);
    if (match.missing.length) {
      throw new Error(
        `${file} (${sheet.name}): no column for ${match.missing.join(', ')}. Headers found: ${headers.filter(Boolean).join(', ')}. Add a mapping, e.g. --map steps="Your steps header".`,
      );
    }
    const cell = (row: Array<string | undefined>, field: Field) => {
      const col = match.map[field];
      const v = col ? row[col - 1]?.trim() : undefined;
      return v ? v : undefined;
    };

    const cases: ImportedCase[] = [];
    const problems: RowProblem[] = [];
    const warnings: string[] = [];
    const seen = new Map<string, number>();
    for (let i = header + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row.some((c) => c?.trim())) continue;
      const sheetRow = i + 1;
      let id = cell(row, 'id');
      const title = cell(row, 'title');
      const empty = (['title', 'steps', 'expected'] as Field[]).filter((f) => !cell(row, f));
      if (empty.length) {
        problems.push({ row: sheetRow, id, title, text: `Row ${sheetRow} has no ${empty.map(label).join(', ')}.` });
        continue;
      }
      if (id && seen.has(id)) {
        const renamed = `${id}-R${sheetRow}`;
        warnings.push(`${id} is on rows ${seen.get(id)} and ${sheetRow}; the second is ${renamed}.`);
        id = renamed;
      }
      if (id) seen.set(id, sheetRow);
      cases.push({
        row: sheetRow,
        raw: {
          id,
          title: title!,
          type: cell(row, 'type')?.toLowerCase(),
          preconditions: cell(row, 'preconditions'),
          steps: cell(row, 'steps')!,
          testData: cell(row, 'testData'),
          expected: cell(row, 'expected')!,
          requirementId: cell(row, 'requirementId'),
          row: sheetRow,
        },
      });
    }
    return { file, format, sheet: sheet.name, headerRow: header + 1, headers, columns: match.map, unmatched: match.unmatched, cases, problems, warnings };
  }
  throw new Error(`${file}: no sheet has a header row with Title, Steps and Expected Result columns (or similar names).`);
}

const label = (f: Field) => ({ title: 'Title', steps: 'Steps', expected: 'Expected Result' })[f as 'title' | 'steps' | 'expected'] ?? f;

/** Every row as text, as the sheet shows it (formulas as their result, rich text as plain text). */
function rowsOf(sheet: ExcelJS.Worksheet): Array<Array<string | undefined>> {
  const rows: Array<Array<string | undefined>> = [];
  const width = sheet.columnCount;
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const values: Array<string | undefined> = [];
    for (let c = 1; c <= width; c++) {
      const text = row.getCell(c).text;
      values.push(text === '' ? undefined : text.replace(/\r\n?/g, '\n'));
    }
    rows.push(values);
  }
  return rows;
}

/** Comma, semicolon (common in Europe and India) or tab, whichever the first line uses most. */
async function guessDelimiter(file: string): Promise<string> {
  const first = (await readFile(file, 'utf8')).replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ',';
}
