import path from 'node:path';
import { readWorkbook } from '../../importer/workbook.js';
import { coverageOf } from '../language/coverage.js';
import { preflightOf } from '../language/preflight.js';
import { type CompileResult, compileCase } from '../pipeline/compile.js';
import { type Measure, measureOf } from './gate.js';

/**
 * Compiles real workbooks with no browser and measures each: how many test cases are ready, how many steps and checks are
 * understood (T6, BP-2). The gate (GV-13) and the review reduction (GV-08) both read these numbers, so they are made in one place.
 */
export async function measureWorkbooks(files: readonly string[]): Promise<Record<string, Measure>> {
  const out: Record<string, Measure> = {};
  for (const file of files) {
    const imported = await readWorkbook(file);
    const compiled: CompileResult[] = [];
    for (const c of imported.cases) compiled.push(await compileCase(c.raw, { source: { file: path.basename(file), sheet: imported.sheet } }));
    const statuses = imported.cases.map((c, i) => preflightOf(c.raw.title, compiled[i] as CompileResult).status);
    out[path.basename(file)] = measureOf(statuses, coverageOf(compiled));
  }
  return out;
}
