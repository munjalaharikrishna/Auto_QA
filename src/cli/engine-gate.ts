/**
 * E0.10: the protection gate (GV-13), the review reduction (GV-08) and the benchmark with the wrong-PASS KPI (GV-09, GV-06).
 *
 *   npm run engine:gate                    measure the real workbooks, compare with test/baseline/gate.json; exit 1 when blocked
 *   npm run engine:gate -- --update        accept the current numbers as the new baseline (never done by the gate itself)
 *   npm run engine:gate -- --allow-below-minimum     waive the 80% review reduction minimum for one run (said in the output)
 *   npm run engine:gate -- --key=file.json --results=file.json     also run the benchmark: any wrong PASS blocks
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnswerKeySchema,
  type BenchmarkReport,
  type BenchmarkResult,
  benchmarkText,
  checkGate,
  type GateBaseline,
  gateText,
  type Measure,
  percent,
  REVIEW_REDUCTION_MINIMUM,
  reviewCountOf,
  reviewReductionBy,
  runBenchmark,
} from '../engine/governance/index.js';
import { measureWorkbooks } from '../engine/governance/measure.js';
import { runTrap, TrapFileSchema } from '../engine/governance/traps.js';
import { readWorkbook } from '../importer/workbook.js';
import type { RawTestCase } from '../model/test-model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const baselineFile = path.join(root, 'test/baseline/gate.json');
const reviewBaselineFile = path.join(root, 'test/baseline/review-baseline.json');
const workbooks = ['test/fixtures/OrangeHRM_Login_Test_Cases_Updated.xlsx', 'test/fixtures/Add_Employee.xlsx'].map((f) => path.join(root, f));

const current = await measureWorkbooks(workbooks);

if (args.includes('--update')) {
  const version = flag('version') ?? 'E0.10';
  const next: GateBaseline = { version, modules: current };
  await writeFile(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Recorded ${path.relative(root, baselineFile)} (${version}).`);
  process.exit(0);
}

let benchmark: BenchmarkReport | undefined;
const keyFile = flag('key');
const resultsFile = flag('results');
if (keyFile && resultsFile) {
  const key = AnswerKeySchema.parse(JSON.parse(await readFile(keyFile, 'utf8')));
  if (!key.signedOff && !args.includes('--draft')) {
    console.error(`${keyFile} is not signed off: nobody has checked it by hand. A key nobody checked is not a key (add --draft to see a draft run).`);
    process.exit(1);
  }
  benchmark = runBenchmark(key, JSON.parse(await readFile(resultsFile, 'utf8')) as BenchmarkResult[]);
  console.log(benchmarkText(benchmark));
}

const baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as GateBaseline;
const legacy = JSON.parse(await readFile(reviewBaselineFile, 'utf8')) as { modules: Record<string, Measure> };
const reduction = reviewReductionBy(
  Object.fromEntries(Object.entries(legacy.modules).map(([k, v]) => [k, reviewCountOf(v)])),
  Object.fromEntries(Object.entries(current).map(([k, v]) => [k, reviewCountOf(v)])),
);
// The owner's minimum is a bar, not a hint: below it the gate blocks. Waiving it is said out loud, never silent.
const waived = args.includes('--allow-below-minimum');
const minimum = Number(flag('min-reduction') ?? REVIEW_REDUCTION_MINIMUM);
const gate = checkGate(baseline, current, benchmark, waived ? undefined : { total: reduction.total, minimum });
console.log(gateText(gate));
if (waived) console.log('  (the review reduction minimum is WAIVED for this run)');

console.log('\nReview reduction against the legacy baseline (target 90%, minimum 80%):');
for (const [k, r] of Object.entries(reduction.byGroup))
  console.log(`  ${k}: ${r.baseline.reviews} reviews before, ${r.current.reviews} now: ${percent(r.reduction)}`);
console.log(`  all: ${reduction.total.baseline.reviews} before, ${reduction.total.current.reviews} now: ${percent(reduction.total.reduction)}`);

// The wrong-PASS traps (T5) are part of the gate: any trap that does not hold blocks, whatever the numbers say.
const trapFile = TrapFileSchema.parse(JSON.parse(await readFile(path.join(root, 'test/traps/compile-traps.json'), 'utf8')));
const books = new Map<string, RawTestCase[]>();
for (const t of trapFile.traps) {
  if ('workbook' in t.case && !books.has(t.case.workbook))
    books.set(
      t.case.workbook,
      (await readWorkbook(path.join(root, 'test/fixtures', t.case.workbook))).cases.map((c) => c.raw),
    );
}
const trapOutcomes = [];
for (const t of trapFile.traps) trapOutcomes.push(await runTrap(t, (workbook, id) => books.get(workbook)?.find((c) => c.id === id)));
const brokenTraps = trapOutcomes.filter((o) => !o.ok);
console.log(`
Wrong-PASS traps: ${trapOutcomes.length - brokenTraps.length} of ${trapOutcomes.length} hold`);
for (const o of brokenTraps) console.log(`  BROKEN ${o.id}: ${o.problems.join('; ')}`);

process.exit(gate.ok && brokenTraps.length === 0 ? 0 : 1);
