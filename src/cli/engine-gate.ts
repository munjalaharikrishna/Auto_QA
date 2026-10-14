/**
 * E0.10: the protection gate (GV-13), the review reduction (GV-08) and the benchmark with the wrong-PASS KPI (GV-09, GV-06).
 *
 *   npm run engine:gate                    measure the real workbooks, compare with test/baseline/gate.json; exit 1 when blocked
 *   npm run engine:gate -- --update        accept the current numbers as the new baseline (never done by the gate itself)
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
  reviewCountOf,
  reviewReductionBy,
  runBenchmark,
} from '../engine/governance/index.js';
import { measureWorkbooks } from '../engine/governance/measure.js';

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
  benchmark = runBenchmark(key, JSON.parse(await readFile(resultsFile, 'utf8')) as BenchmarkResult[]);
  console.log(benchmarkText(benchmark));
}

const baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as GateBaseline;
const gate = checkGate(baseline, current, benchmark);
console.log(gateText(gate));

const legacy = JSON.parse(await readFile(reviewBaselineFile, 'utf8')) as { modules: Record<string, Measure> };
const reduction = reviewReductionBy(
  Object.fromEntries(Object.entries(legacy.modules).map(([k, v]) => [k, reviewCountOf(v)])),
  Object.fromEntries(Object.entries(current).map(([k, v]) => [k, reviewCountOf(v)])),
);
console.log('\nReview reduction against the legacy baseline (target 90%, minimum 80%):');
for (const [k, r] of Object.entries(reduction.byGroup))
  console.log(`  ${k}: ${r.baseline.reviews} reviews before, ${r.current.reviews} now: ${percent(r.reduction)}`);
console.log(`  all: ${reduction.total.baseline.reviews} before, ${reduction.total.current.reviews} now: ${percent(reduction.total.reduction)}`);

process.exit(gate.ok ? 0 : 1);
