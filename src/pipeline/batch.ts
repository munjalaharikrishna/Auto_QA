import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Field } from '../importer/columns.js';
import { type BatchSummary, defaultResultsFile, type RowResult, writeResults } from '../importer/results.js';
import { type ImportResult, readWorkbook } from '../importer/workbook.js';
import type { RawTestCase, TestModel } from '../model/test-model.js';
import { parseTestCase } from '../parser/index.js';
import type { Status, TestVerdict } from '../results/verdict.js';
import { type PipelineOptions, runCases } from './run-cases.js';

/**
 * Batch run of a workbook (FR-IN-08, M6b): every test case, unattended (D22), with the results written
 * to a copy of the workbook (FR-HI-06, D23) and a review queue for what needs the tester (FR-HI-07).
 *
 * Progress is kept per workbook, so a stopped batch resumes: finished explorations are reused, and
 * `onlyReview` runs just the cases set aside last time.
 */

export interface BatchOptions extends Omit<PipelineOptions, 'login'> {
  sheet?: string;
  mapping?: Partial<Record<Field, string>>;
  /** Results copy. Default: `<name>.results.xlsx` next to the workbook. */
  out?: string;
  /** Only the cases whose last result was NEEDS REVIEW, e.g. after answering them interactively. */
  onlyReview?: boolean;
  /** Test case to run first for "Logged in" preconditions. Default: the sheet's first login case. */
  loginId?: string;
  /** Where batch progress is kept. Default: .auto-qa/batches. */
  batchesDir?: string;
  /** Test cases the tester edited in the app, by id. They replace the sheet's version of the same case. */
  overrides?: Record<string, RawTestCase>;
  /** Called with the test cases read from the sheet, before any runs, so they can be kept (item 1). */
  onImported?: (cases: ImportResult['cases']) => void | Promise<void>;
}

export interface BatchResult {
  imported: ImportResult;
  results: RowResult[];
  summary: BatchSummary;
  out: string;
  workspace?: string;
  loginCase?: string;
}

interface Progress {
  file: string;
  verdicts: Record<string, TestVerdict>;
}

export async function runBatch(file: string, options: BatchOptions): Promise<BatchResult> {
  const progress = options.onProgress ?? (() => {});
  const imported = await readWorkbook(file, { sheet: options.sheet, mapping: options.mapping });
  progress(
    `${imported.cases.length} test case(s) in "${imported.sheet}"${imported.problems.length ? `, ${imported.problems.length} row(s) that are not complete test cases` : ''}`,
  );
  for (const w of imported.warnings) progress(`! ${w}`);
  // An edit made in the app wins over the sheet, which is never changed (D23).
  for (const c of imported.cases) {
    const edited = c.raw.id ? options.overrides?.[c.raw.id] : undefined;
    if (edited) {
      c.raw = { ...edited, id: c.raw.id, row: c.raw.row };
      progress(`${c.raw.id}: using the version edited in Auto QA`);
    }
  }
  imported.problems = imported.problems.filter((p) => !(p.id && options.overrides?.[p.id]));
  await options.onImported?.(imported.cases);

  const models: TestModel[] = [];
  const rowOf = new Map<string, number>();
  const unreadable: RowResult[] = imported.problems.map((p) => ({ row: p.row, problem: p.text, id: p.id, title: p.title }));
  for (const c of imported.cases) {
    try {
      const model = parseTestCase(c.raw, options.config);
      models.push(model);
      rowOf.set(model.id, c.row);
    } catch (e) {
      unreadable.push({ row: c.row, problem: `Row ${c.row} could not be read: ${(e as Error).message.split('\n')[0]}`, id: c.raw.id, title: c.raw.title });
    }
  }

  const progressFile = path.join(options.batchesDir ?? path.join('.auto-qa', 'batches'), `${batchKey(file)}.json`);
  const saved: Progress = existsSync(progressFile) ? (JSON.parse(await readFile(progressFile, 'utf8')) as Progress) : { file, verdicts: {} };
  const selected = options.onlyReview ? models.filter((m) => saved.verdicts[m.id]?.status === 'NEEDS REVIEW') : models;
  if (options.onlyReview) progress(`${selected.length} case(s) from the review queue`);

  const login = pickLogin(models, options.loginId);
  if (login && selected.some((m) => m.preconditions.some((p) => p.kind === 'logged-in'))) progress(`"Logged in" cases start with ${login.id}'s steps`);

  const run = await runCases(selected, { ...options, login });
  for (const v of run.verdicts) saved.verdicts[v.testId] = v;
  // Cases no longer in the sheet are dropped from the progress.
  saved.verdicts = Object.fromEntries(models.filter((m) => saved.verdicts[m.id]).map((m) => [m.id, saved.verdicts[m.id]]));
  await mkdir(path.dirname(progressFile), { recursive: true });
  await writeFile(progressFile, `${JSON.stringify(saved, null, 2)}\n`);

  const results: RowResult[] = [
    ...models.flatMap((m) => (saved.verdicts[m.id] ? [{ row: rowOf.get(m.id)!, verdict: saved.verdicts[m.id] }] : [])),
    ...unreadable,
  ].sort((a, b) => a.row - b.row);
  const summary = summarize(results, run.executionId, models);
  const out = options.out ?? defaultResultsFile(file);
  await writeResults(imported, results, summary, out);
  return { imported, results, summary, out, workspace: run.workspace, loginCase: login?.id };
}

function summarize(results: RowResult[], executionId: string | undefined, models: TestModel[]): BatchSummary {
  const totals: Record<Status, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, 'NEEDS REVIEW': 0 };
  const review: BatchSummary['review'] = [];
  for (const r of results) {
    const status = r.verdict?.status ?? 'NEEDS REVIEW';
    totals[status]++;
    if (status !== 'NEEDS REVIEW') continue;
    const model = r.verdict && models.find((m) => m.id === r.verdict?.testId);
    review.push({
      row: r.row,
      testId: r.verdict?.testId ?? r.id ?? `row ${r.row}`,
      title: model?.title ?? r.verdict?.title ?? r.title ?? '',
      step: r.verdict?.failedStep,
      question: r.verdict?.reason ?? r.problem ?? '',
    });
  }
  return { executionId, finishedAt: new Date().toISOString(), totals, review };
}

/**
 * The login case for "Logged in" preconditions: the one named, or the sheet's first case without
 * preconditions that enters the password and clicks something.
 */
function pickLogin(models: TestModel[], id?: string): TestModel | undefined {
  if (id) {
    const named = models.find((m) => m.id === id);
    if (!named) throw new Error(`There is no test case ${id} to use as the login.`);
    return named;
  }
  return models.find(
    (m) =>
      !m.preconditions.some((p) => p.kind === 'logged-in' || p.kind === 'flow') &&
      m.steps.some((s) => s.action === 'fill' && s.value?.kind === 'env' && s.value.name === 'TEST_PASSWORD') &&
      m.steps.some((s) => s.action === 'click'),
  );
}

/** One progress file per workbook path, so two workbooks never share progress. */
function batchKey(file: string): string {
  const base = path
    .basename(file)
    .replace(/\.[^.]+$/, '')
    .replace(/\.results$/, '');
  return `${base.replace(/[^\w-]+/g, '-')}-${createHash('sha1')
    .update(
      path
        .resolve(file)
        .replace(/\.results(\.\w+)$/, '$1')
        .toLowerCase(),
    )
    .digest('hex')
    .slice(0, 8)}`;
}
