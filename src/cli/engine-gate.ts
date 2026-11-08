/**
 * E0.10: the protection gate (GV-13), the review reduction (GV-08) and the benchmark with the wrong-PASS KPI (GV-09, GV-06).
 * E0.19 step 6: the review reduction is measured at run time, from saved live runs against the frozen baseline, and the gate runs in CI.
 *
 *   npm run engine:gate                    measure, compare with test/baseline/gate.json; exit 1 when blocked
 *   npm run engine:gate -- --update        accept the current understanding numbers as the new baseline (never done by the gate itself)
 *   npm run engine:gate -- --allow-below-minimum     waive the 80% review reduction minimum for one run (said in the output)
 *   npm run engine:gate -- --key=file.json --results=file.json     also run the benchmark of a result list: any wrong PASS blocks
 *
 * What blocks:
 *  - a step back in understanding (steps or checks understood, test cases ready) against the accepted numbers;
 *  - a wrong-PASS trap that does not hold;
 *  - a wrong PASS in a saved live run (test/baseline/runs) against the answer key, draft or not: a draft key is the best answer there is,
 *    and a PASS it says is not a PASS is not let through;
 *  - once the owner has declared the minimum engine (`minimumEngineDeclared` in gate.json, set by hand): fewer than 80% fewer questions
 *    than the legacy engine asked, at run time. Before that, the number is shown and does not block.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AnswerKey,
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
import type { TestVerdict } from '../results/verdict.js';
import { KpiBaselineSchema, kpiTotal, type RunKpi, runGateProblems, runKpiOf } from '../review/kpi.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const baselineFile = path.join(root, 'test/baseline/gate.json');
const reviewBaselineFile = path.join(root, 'test/baseline/review-baseline.json');
const workbooks = ['test/fixtures/OrangeHRM_Login_Test_Cases_Updated.xlsx', 'test/fixtures/Add_Employee.xlsx'].map((f) => path.join(root, f));

const current = await measureWorkbooks(workbooks);
const baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as GateBaseline;

if (args.includes('--update')) {
  const version = flag('version') ?? baseline.version;
  // The owner's declaration is kept: an update of the numbers never takes it back.
  const next: GateBaseline = {
    version,
    modules: current,
    ...(baseline.minimumEngineDeclared ? { minimumEngineDeclared: baseline.minimumEngineDeclared } : {}),
  };
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

// The saved live runs, measured as a person meets them: questions per run against the frozen legacy baseline (E0.19 step 1).
const runsDir = path.resolve(flag('runs') ?? path.join(root, 'test/baseline/runs'));
const kpiBaseline = KpiBaselineSchema.parse(JSON.parse(await readFile(path.join(root, 'test/baseline/kpi-baseline.json'), 'utf8')));
const runKey: AnswerKey = AnswerKeySchema.parse(
  JSON.parse(await readFile(path.resolve(flag('run-key') ?? path.join(root, 'test/benchmark/orangehrm.answer-key.json')), 'utf8')),
);
const kpis: RunKpi[] = [];
if (existsSync(runsDir))
  for (const file of (await readdir(runsDir)).filter((f) => f.endsWith('.json')).sort()) {
    const data = JSON.parse(await readFile(path.join(runsDir, file), 'utf8')) as { verdicts?: Record<string, TestVerdict> };
    const rows = Object.values(data.verdicts ?? {}).map((v) => ({ testId: v.testId, status: v.status, verdict: v }));
    if (rows.length) kpis.push(runKpiOf({ run: file, rows, baseline: kpiBaseline, key: runKey }));
  }
const total = kpiTotal(kpis);
const declared = baseline.minimumEngineDeclared;
const waived = args.includes('--allow-below-minimum');
const minimum = Number(flag('min-reduction') ?? REVIEW_REDUCTION_MINIMUM);
// The owner's minimum is a bar once the minimum engine is declared: below it the gate blocks. Waiving it is said out loud, never silent.
const gate = checkGate(baseline, current, benchmark);
const fromRuns = runGateProblems(kpis, { declared: !!declared, minimum, waived, draftKey: !runKey.signedOff });
const wrongPass = fromRuns.filter((p) => p.what.startsWith('wrong PASS'));
gate.problems.push(...fromRuns);
gate.ok = gate.problems.length === 0;
console.log(gateText(gate));
if (waived) console.log('  (the review reduction minimum is WAIVED for this run)');

console.log(`\nQuestions to answer at run time, against the legacy engine (saved live runs in ${path.relative(root, runsDir)}):`);
for (const k of kpis.filter((x) => x.vsBaseline))
  console.log(`  ${k.label}: ${k.vsBaseline?.questions.before} before, ${k.questions} now: ${percent(k.vsBaseline?.questions.reduction)}`);
if (total) console.log(`  all: ${total.questions.before} before, ${total.questions.after} now: ${percent(total.questions.reduction)}`);
console.log(
  declared
    ? `  The minimum engine was declared on ${declared.on} by ${declared.by}: below ${percent(minimum)} blocks.`
    : `  The minimum engine is not declared yet: the ${percent(minimum)} minimum is shown, and does not block.`,
);
console.log(`  Wrong PASS in the saved runs: ${wrongPass.length}${runKey.signedOff ? '' : ' (against the draft answer key)'}`);

// The compile-time count of E0.10, kept for comparison: what a person would have to look at before any run.
const legacy = JSON.parse(await readFile(reviewBaselineFile, 'utf8')) as { modules: Record<string, Measure> };
const compiled = reviewReductionBy(
  Object.fromEntries(Object.entries(legacy.modules).map(([k, v]) => [k, reviewCountOf(v)])),
  Object.fromEntries(Object.entries(current).map(([k, v]) => [k, reviewCountOf(v)])),
);
console.log('\nTest cases not ready before a run (compile time, for comparison):');
for (const [k, r] of Object.entries(compiled.byGroup)) console.log(`  ${k}: ${r.baseline.reviews} before, ${r.current.reviews} now: ${percent(r.reduction)}`);

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
