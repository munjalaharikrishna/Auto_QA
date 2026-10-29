/**
 * Measures what the caches of GV-11 save, on the real workbooks and the saved explorations, and says how much the numbers vary.
 *
 *   npm run engine:cache-bench                  compile the cases of the workbooks in test/fixtures; read .auto-qa/explore
 *   npm run engine:cache-bench -- <runs>        the number of passes to take the median of (default 7)
 *
 * Each pass compiles every case: with the caches off, cold (the cache was just emptied) and warm (the same cases again). The median
 * and the range of the passes are printed, so a number that moves a lot between passes shows it. Nothing is written.
 */
import path from 'node:path';
import { cacheStats, clearCaches, compileCase } from '../engine/index.js';
import { knowledgeFromRuns } from '../engine/knowledge/from-runs.js';
import { readWorkbook } from '../importer/workbook.js';

const runs = Math.max(3, Number(process.argv[2]) || 7);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const show = (xs: number[]): string => `median ${median(xs).toFixed(1).padStart(7)} ms   range ${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)}`;

const fixtures = path.join('test', 'fixtures');
const cases = (
  await Promise.all(
    ['OrangeHRM_Login_Test_Cases_Updated.xlsx', 'Add_Employee.xlsx'].map(async (f) => (await readWorkbook(path.join(fixtures, f))).cases.map((c) => c.raw)),
  )
).flat();

const compilePass = async (cache: boolean): Promise<number> => {
  const start = performance.now();
  for (const c of cases) await compileCase(c, { env: {}, cache });
  return performance.now() - start;
};
await compilePass(false); // the first use of the code is slower than the rest: it is not measured
const off: number[] = [];
const cold: number[] = [];
const warm: number[] = [];
for (let i = 0; i < runs; i++) {
  off.push(await compilePass(false));
  clearCaches();
  cold.push(await compilePass(true));
  warm.push(await compilePass(true));
}
console.log(`Compiling ${cases.length} cases, ${runs} passes`);
console.log(`  caches off   ${show(off)}`);
console.log(`  cache cold   ${show(cold)}`);
console.log(`  cache warm   ${show(warm)}   (${(median(off) / median(warm)).toFixed(0)}× faster than off)`);
console.log(`  ${JSON.stringify(cacheStats().understand)}`);

const dir = path.join('.auto-qa', 'explore');
const read = async (cache: boolean): Promise<number> => {
  const start = performance.now();
  await knowledgeFromRuns('bench', undefined, dir, [], { cache });
  return performance.now() - start;
};
const kOff: number[] = [];
const kCold: number[] = [];
const kWarm: number[] = [];
for (let i = 0; i < runs; i++) {
  kOff.push(await read(false));
  clearCaches();
  kCold.push(await read(true));
  kWarm.push(await read(true));
}
console.log(`\nReading the saved explorations in ${dir}, ${runs} passes`);
console.log(`  caches off   ${show(kOff)}`);
console.log(`  cache cold   ${show(kCold)}`);
console.log(`  cache warm   ${show(kWarm)}   (${(median(kOff) / median(kWarm)).toFixed(1)}× faster than off)`);
