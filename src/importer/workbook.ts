import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { RawTestCase } from '../model/test-model.js';
import { splitNumbered } from '../parser/text.js';
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
    const { rows, slaves } = rowsOf(sheet);
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
    // A test case can be spread over several rows (one step per row, the title merged over them): the rows are gathered here.
    let pending: Pending | undefined;
    const flush = () => {
      if (!pending) return;
      const built = buildCase(pending);
      pending = undefined;
      if ('problem' in built) {
        problems.push(built.problem);
        return;
      }
      let id = built.raw.id;
      if (id && seen.has(id)) {
        const renamed = `${id}-R${built.row}`;
        warnings.push(`${id} is on rows ${seen.get(id)} and ${built.row}; the second is ${renamed}.`);
        id = renamed;
      }
      if (id) seen.set(id, built.row);
      cases.push({ row: built.row, raw: { ...built.raw, id } });
    };
    for (let i = header + 1; i < rows.length; i++) {
      const row = rows[i];
      const filled = row.filter((c) => c?.trim()).length;
      if (!filled) continue;
      const sheetRow = i + 1;
      const id = cell(row, 'id');
      const title = cell(row, 'title');
      const steps = cell(row, 'steps');
      const expected = cell(row, 'expected');

      // "LOGIN MODULE": a heading row between groups of test cases (RW-I07). It ends the case above and starts nothing.
      if (filled === 1 && !steps && !expected) {
        flush();
        warnings.push(`Row ${sheetRow} ("${row.find((c) => c?.trim())?.trim()}") is a heading, not a test case, and was skipped.`);
        continue;
      }
      // The rest of a test case above: no id of its own, or the id/title cell is merged down from it (RW-I01, RW-I02).
      const mergedDown = (field: Field) => !!match.map[field] && slaves[i]?.[(match.map[field] as number) - 1] === true;
      const continues = !!pending && !!steps && ((!id && !title) || mergedDown('id') || mergedDown('title'));
      if (continues && pending) {
        pending.parts.push({ row: sheetRow, steps: steps as string, expected, testData: cell(row, 'testData') });
        continue;
      }
      flush();
      pending = {
        row: sheetRow,
        id,
        title,
        type: cell(row, 'type'),
        preconditions: cell(row, 'preconditions'),
        requirementId: cell(row, 'requirementId'),
        parts: [{ row: sheetRow, steps, expected, testData: cell(row, 'testData') }],
      };
    }
    flush();

    // Other sheets that also hold test cases are not imported; say so instead of leaving it unnoticed.
    const others = sheets.filter((other) => other !== sheet && findHeaderRow(rowsOf(other).rows, options.mapping) !== undefined).map((other) => other.name);
    if (others.length && !options.sheet) warnings.push(`Other sheets with test cases were not imported: ${others.join(', ')}. Choose the sheet to import.`);
    return { file, format, sheet: sheet.name, headerRow: header + 1, headers, columns: match.map, unmatched: match.unmatched, cases, problems, warnings };
  }
  throw new Error(`${file}: no sheet has a header row with Title, Steps and Expected Result columns (or similar names).`);
}

/**
 * Every row as text, as the sheet shows it (formulas as their result, rich text as plain text). `slaves` marks the cells
 * that are part of a merged range but not its first cell: they hold the same text as the first one.
 */
function rowsOf(sheet: ExcelJS.Worksheet): { rows: Array<Array<string | undefined>>; slaves: boolean[][] } {
  const rows: Array<Array<string | undefined>> = [];
  const slaves: boolean[][] = [];
  const width = sheet.columnCount;
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const values: Array<string | undefined> = [];
    const merged: boolean[] = [];
    for (let c = 1; c <= width; c++) {
      const cellAt = row.getCell(c);
      const text = cellAt.text;
      values.push(text === '' ? undefined : text.replace(/\r\n?/g, '\n'));
      merged.push(cellAt.isMerged && cellAt.master.address !== cellAt.address);
    }
    rows.push(values);
    slaves.push(merged);
  }
  return { rows, slaves };
}

interface Part {
  row: number;
  steps?: string;
  expected?: string;
  testData?: string;
}

interface Pending {
  row: number;
  id?: string;
  title?: string;
  type?: string;
  preconditions?: string;
  requirementId?: string;
  parts: Part[];
}

/** One test case from the rows that belong to it: steps numbered in order, a step's own expected result as a check after it (RW-E12). */
function buildCase(p: Pending): { row: number; raw: RawTestCase } | { problem: RowProblem } {
  const first = p.parts[0];
  const withSteps = p.parts.filter((x) => x.steps);
  const lines: string[] = [];
  const stepLine = (text: string) => lines.push(`${lines.length + 1}. ${text}`);
  let finalExpected: string | undefined;
  for (const [k, part] of withSteps.entries()) {
    // A row may hold several numbered steps already: keep them in order under the new numbering.
    for (const line of splitNumbered(part.steps as string)) stepLine(line.text);
    const last = k === withSteps.length - 1;
    if (part.expected) {
      if (last || withSteps.length === 1) finalExpected = part.expected;
      else stepLine(`Verify ${part.expected}`);
    }
  }
  finalExpected ??= [...p.parts].reverse().find((x) => x.expected)?.expected;
  const empty = [!p.title && 'Title', !withSteps.length && 'Steps', !finalExpected && 'Expected Result'].filter(Boolean) as string[];
  if (empty.length) return { problem: { row: p.row, id: p.id, title: p.title, text: `Row ${p.row} has no ${empty.join(', ')}.` } };
  const testData = p.parts
    .map((x) => x.testData)
    .filter(Boolean)
    .join('; ');
  return {
    row: p.row,
    raw: {
      id: p.id,
      title: p.title as string,
      type: p.type?.toLowerCase(),
      preconditions: p.preconditions,
      steps: p.parts.length > 1 || withSteps.length > 1 ? lines.join('\n') : (first.steps as string),
      testData: testData || undefined,
      expected: finalExpected as string,
      requirementId: p.requirementId,
      row: p.row,
    },
  };
}

/** Comma, semicolon (common in Europe and India) or tab, whichever the first line uses most. */
async function guessDelimiter(file: string): Promise<string> {
  const first = (await readFile(file, 'utf8')).replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ',';
}
