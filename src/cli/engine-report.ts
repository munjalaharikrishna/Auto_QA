/**
 * E0.4: compile real workbooks to QA-IR without a browser and show what the new language layers made of them: the
 * pre-flight report (GV-14), the coverage report (GV-07) and the numbers to compare version by version (T6, BP-2).
 *
 *   npm run engine:report                              the two real workbooks of the project
 *   npm run engine:report -- tests.xlsx other.xlsx     any workbooks
 *   npm run engine:report -- --all                     also list the test cases that are ready
 *   npm run engine:report -- --write                   record the numbers in test/baseline/ (T6), under --tag=e05 by default
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CompileResult, compileCase } from '../engine/index.js';
import { coverageOf, coverageText, preflightOf, preflightReport, preflightText } from '../engine/language/index.js';
import { readWorkbook } from '../importer/workbook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const write = args.includes('--write');
/** The version the numbers are recorded under: each version keeps its own file, so the next can be compared with it (T6). */
const tag = args.find((a) => a.startsWith('--tag='))?.slice(6) ?? 'e05';
const all = args.includes('--all');
const targets = files.length
  ? files
  : ['test/fixtures/OrangeHRM_Login_Test_Cases_Updated.xlsx', 'test/fixtures/Add_Employee.xlsx'].map((f) => path.join(root, f));

const sections: string[] = [];
const numbers: Record<string, unknown> = {};
const everything: CompileResult[] = [];

for (const file of targets) {
  const imported = await readWorkbook(file);
  // The whole compile, so what the data resolver settled (generated values, references) is not reported as a question.
  const languages: CompileResult[] = [];
  for (const c of imported.cases) languages.push(await compileCase(c.raw, { source: { file: path.basename(file), sheet: imported.sheet } }));
  everything.push(...languages);
  const report = preflightReport(imported.cases.map((c, i) => preflightOf(c.raw.title, languages[i] as CompileResult)));
  const label = path.basename(file);
  const coverage = coverageOf(languages);
  sections.push(`${'='.repeat(78)}\n${label}\n${'='.repeat(78)}\n\n${preflightText(report, { all })}\n${coverageText(label, coverage)}\n`);
  numbers[label] = {
    testCases: coverage.testCases,
    withDocument: coverage.withDocument,
    ready: coverage.ready,
    preflight: { ready: report.ready, review: report.review, blocked: report.blocked },
    steps: coverage.steps,
    expectations: coverage.expectations,
    byCategory: coverage.byCategory,
    models: coverage.models,
    topReasons: coverage.topReasons,
  };
}

const text = sections.join('\n');
console.log(text);

if (write) {
  const dir = path.join(root, 'test', 'baseline');
  await mkdir(dir, { recursive: true });
  const total = coverageOf(everything);
  await writeFile(
    path.join(dir, `${tag}-t6.json`),
    `${JSON.stringify({ version: tag.toUpperCase().replace('E0', 'E0.'), engine: 'semantic', workbooks: numbers, total }, null, 2)}\n`,
  );
  await writeFile(path.join(dir, `${tag}-preflight.txt`), `${text}\n`);
  console.log(`Recorded in ${path.relative(root, dir)}: ${tag}-t6.json, ${tag}-preflight.txt`);
}
