import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { type RawTestCase, RawTestCaseSchema } from '../model/test-model.js';
import { splitNumbered } from '../parser/text.js';
import { type ColumnMap, type Field, findHeaderRow, matchColumns } from './columns.js';
import { orderNumbered, orderParts } from './numbering.js';

/**
 * Excel/CSV import (FR-IN-01, D21; IN-01 to IN-23): the test case rows of a workbook, with their row numbers so results
 * can be written back next to them (FR-HI-06). Rows that cannot be read are reported, not dropped.
 */

export interface ImportedCase {
  raw: RawTestCase;
  /** 1-based sheet row. */
  row: number;
  /** The sheet the case was read from. */
  sheet: string;
}

export interface RowProblem {
  row: number;
  id?: string;
  title?: string;
  text: string;
  sheet?: string;
}

/** Two test cases that are the same case (IN-20): the same id twice, or different ids with identical content. */
export interface Duplicate {
  kind: 'id' | 'content';
  /** The ids as imported (a repeated id has been renamed, see `warnings`). */
  ids: string[];
  rows: number[];
}

export interface ImportResult {
  file: string;
  format: 'xlsx' | 'csv';
  /** The sheet read, or every sheet read, joined by ", ". */
  sheet: string;
  sheets: string[];
  /** 1-based. Of the first sheet read. */
  headerRow: number;
  headers: string[];
  columns: ColumnMap;
  /** Headers that are not test case fields, e.g. "Automation status". Left as they are. */
  unmatched: string[];
  cases: ImportedCase[];
  /** Rows that are not test cases as written, e.g. with no steps. They get NEEDS REVIEW in the results. */
  problems: RowProblem[];
  /** Duplicate IDs that were renamed, e.g. TC-5 on rows 7 and 9 → the second is TC-5-R9; steps that were re-ordered or skip a number. */
  warnings: string[];
  duplicates: Duplicate[];
}

export interface ImportOptions {
  /** Worksheet name. Default: the first sheet with a header row. */
  sheet?: string;
  /** Read every sheet that has a header row (IN-04). Sheets with no test cases are skipped. Default: only the first. */
  allSheets?: boolean;
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

interface SheetRead {
  sheet: string;
  header: number;
  headers: string[];
  columns: ColumnMap;
  unmatched: string[];
  cases: ImportedCase[];
  problems: RowProblem[];
  warnings: string[];
}

export async function readWorkbook(file: string, options: ImportOptions = {}): Promise<ImportResult> {
  const { workbook, format } = await loadWorkbook(file);
  const sheets = options.sheet ? [workbook.getWorksheet(options.sheet)].filter((s): s is ExcelJS.Worksheet => !!s) : workbook.worksheets;
  if (options.sheet && !sheets.length) throw new Error(`${file} has no sheet "${options.sheet}". Sheets: ${workbook.worksheets.map((s) => s.name).join(', ')}`);

  // One id is used once in the whole workbook, so a repeat on another sheet is found too.
  const seen = new Map<string, number>();
  const read: SheetRead[] = [];
  for (const sheet of sheets) {
    const one = readSheet(file, sheet, options, seen);
    if (!one) continue;
    read.push(one);
    if (!options.allSheets) break;
  }
  if (!read.length) throw new Error(`${file}: no sheet has a header row with Title, Steps and Expected Result columns (or similar names).`);

  const first = read[0];
  const cases = read.flatMap((r) => r.cases);
  const warnings = read.flatMap((r) => r.warnings);
  // Other sheets that also hold test cases are not imported unless asked; say so instead of leaving it unnoticed.
  if (!options.allSheets && !options.sheet) {
    const others = sheets
      .filter((other) => other !== workbook.getWorksheet(first.sheet) && findHeaderRow(rowsOf(other).rows, options.mapping) !== undefined)
      .map((other) => other.name);
    if (others.length) warnings.push(`Other sheets with test cases were not imported: ${others.join(', ')}. Choose the sheet to import.`);
  }
  const duplicates = findDuplicates(cases);
  for (const d of duplicates.filter((x) => x.kind === 'content')) {
    warnings.push(`${d.ids.join(' and ')} (rows ${d.rows.join(' and ')}) have the same title, steps and expected result.`);
  }
  return {
    file,
    format,
    sheet: read.map((r) => r.sheet).join(', '),
    sheets: read.map((r) => r.sheet),
    headerRow: first.header + 1,
    headers: first.headers,
    columns: first.columns,
    unmatched: first.unmatched,
    cases,
    problems: read.flatMap((r) => r.problems),
    warnings,
    duplicates: [...duplicates, ...idDuplicates(warnings, cases)],
  };
}

/** One sheet. `undefined` when it has no header row (a notes sheet); throws when it has one but misses a required column (IN-21). */
function readSheet(file: string, sheet: ExcelJS.Worksheet, options: ImportOptions, seen: Map<string, number>): SheetRead | undefined {
  const { rows, slaves } = rowsOf(sheet);
  const header = findHeaderRow(rows, options.mapping);
  if (header === undefined) return undefined;
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
  // A test case can be spread over several rows (one step per row, the title merged over them): the rows are gathered here.
  let pending: Pending | undefined;
  const flush = () => {
    if (!pending) return;
    const built = buildCase(pending);
    pending = undefined;
    if ('problem' in built) {
      problems.push({ ...built.problem, sheet: sheet.name });
      return;
    }
    // Every imported case is checked against the schema; what is wrong is listed per row (IN-22).
    const valid = RawTestCaseSchema.safeParse(built.raw);
    if (!valid.success) {
      const why = valid.error.issues.map((i) => `${i.path.join('.') || 'case'}: ${i.message}`).join('; ');
      problems.push({
        row: built.row,
        id: built.raw.id,
        title: built.raw.title,
        text: `Row ${built.row} is not a valid test case (${why}).`,
        sheet: sheet.name,
      });
      return;
    }
    warnings.push(...built.warnings);
    let id = built.raw.id;
    if (id && seen.has(id)) {
      const renamed = `${id}-R${built.row}`;
      warnings.push(`${id} is on rows ${seen.get(id)} and ${built.row}; the second is ${renamed}.`);
      id = renamed;
    }
    if (id) seen.set(id, built.row);
    cases.push({ row: built.row, sheet: sheet.name, raw: { ...built.raw, id } });
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
    const part: Part = { row: sheetRow, steps, expected, testData: cell(row, 'testData'), stepNo: cell(row, 'stepNo') };
    const continues = !!pending && !!steps && ((!id && !title) || mergedDown('id') || mergedDown('title'));
    if (continues && pending) {
      pending.parts.push(part);
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
      priority: cell(row, 'priority'),
      tags: cell(row, 'tags'),
      actual: cell(row, 'actual'),
      parts: [part],
    };
  }
  flush();
  return { sheet: sheet.name, header, headers, columns: match.map, unmatched: match.unmatched, cases, problems, warnings };
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
  /** "Step 3": the number the sheet gives this step. */
  stepNo?: string;
}

interface Pending {
  row: number;
  id?: string;
  title?: string;
  type?: string;
  preconditions?: string;
  requirementId?: string;
  priority?: string;
  tags?: string;
  actual?: string;
  parts: Part[];
}

/** Tags written as "smoke, login" or "smoke; login", each once. */
const tagsOf = (text?: string): string[] | undefined => {
  const tags = [
    ...new Set(
      (text ?? '')
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
  return tags.length ? tags : undefined;
};

/** One test case from the rows that belong to it: steps numbered in order, a step's own expected result as a check after it (RW-E12). */
function buildCase(p: Pending): { row: number; raw: RawTestCase; warnings: string[] } | { problem: RowProblem } {
  const label = p.id ?? p.title ?? `row ${p.row}`;
  const warnings: string[] = [];
  const first = p.parts[0];
  // Steps are put in the order of their numbers, and a skipped number is reported (IN-18).
  const ordered = orderParts(p.parts.filter((x) => x.steps));
  if (ordered.reordered) warnings.push(`${label}: the steps were out of order and were put in the order of their numbers.`);
  for (const gap of ordered.gaps) warnings.push(`${label}: ${gap}`);
  const withSteps = ordered.parts;
  const lines: string[] = [];
  const stepLine = (text: string) => lines.push(`${lines.length + 1}. ${text}`);
  let finalExpected: string | undefined;
  for (const [k, part] of withSteps.entries()) {
    if (part.stepNo !== undefined) {
      // The sheet gives every row its own step number: the row is one step, however many lines its cell has (IN-17).
      stepLine((part.steps as string).replace(/\s*\n\s*/g, ' ').trim());
    } else {
      // A row may hold several numbered steps already: keep them in order under the new numbering.
      const cell = orderNumbered(part.steps as string);
      if (cell.reordered) warnings.push(`${label}: the numbered lines in row ${part.row} were out of order and were put in order.`);
      for (const gap of cell.gaps) warnings.push(`${label}: ${gap}`);
      for (const line of splitNumbered(cell.text)) stepLine(line.text);
    }
    const last = k === withSteps.length - 1;
    if (part.expected) {
      if (last || withSteps.length === 1) finalExpected = part.expected;
      else stepLine(`Verify ${part.expected.replace(/\s*\n\s*/g, ' ').trim()}`);
    }
  }
  finalExpected ??= [...p.parts].reverse().find((x) => x.expected)?.expected;
  const empty = [!p.title && 'Title', !withSteps.length && 'Steps', !finalExpected && 'Expected Result'].filter(Boolean) as string[];
  if (empty.length) return { problem: { row: p.row, id: p.id, title: p.title, text: `Row ${p.row} has no ${empty.join(', ')}.` } };
  const testData = p.parts
    .map((x) => x.testData)
    .filter(Boolean)
    .join('; ');
  const single = p.parts.length === 1 && withSteps.length === 1 && first.stepNo === undefined;
  return {
    row: p.row,
    warnings,
    raw: {
      id: p.id,
      title: p.title as string,
      type: p.type?.toLowerCase(),
      preconditions: p.preconditions,
      steps: single ? orderNumbered(first.steps as string).text : lines.join('\n'),
      testData: testData || undefined,
      expected: finalExpected as string,
      requirementId: p.requirementId,
      priority: p.priority,
      tags: tagsOf(p.tags),
      actual: p.actual,
      row: p.row,
    },
  };
}

const signature = (c: ImportedCase): string =>
  createHash('sha1')
    .update(JSON.stringify([c.raw.title, c.raw.steps, c.raw.expected].map((t) => t.toLowerCase().replace(/\s+/g, ' ').trim())))
    .digest('hex');

/** Different ids, identical content (IN-20). */
function findDuplicates(cases: ImportedCase[]): Duplicate[] {
  const bySignature = new Map<string, ImportedCase[]>();
  for (const c of cases) bySignature.set(signature(c), [...(bySignature.get(signature(c)) ?? []), c]);
  return [...bySignature.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ kind: 'content' as const, ids: group.map((c) => c.raw.id ?? `row ${c.row}`), rows: group.map((c) => c.row) }));
}

/** The same id twice: the repeat was renamed (`TC-5-R9`), and is listed here as a duplicate of the first. */
function idDuplicates(warnings: string[], cases: ImportedCase[]): Duplicate[] {
  const out: Duplicate[] = [];
  for (const w of warnings) {
    const m = /^(\S+) is on rows (\d+) and (\d+); the second is (\S+)\.$/.exec(w);
    if (!m) continue;
    const renamed = cases.find((c) => c.raw.id === m[4]);
    out.push({ kind: 'id', ids: [m[1], m[4]], rows: [Number(m[2]), renamed?.row ?? Number(m[3])] });
  }
  return out;
}

/** Comma, semicolon (common in Europe and India) or tab, whichever the first line uses most. */
async function guessDelimiter(file: string): Promise<string> {
  const first = (await readFile(file, 'utf8')).replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ',';
}
