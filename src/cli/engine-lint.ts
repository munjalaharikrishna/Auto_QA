/**
 * E0.15: the lint of real workbooks before any run. Every line of every test case gets a status (understood, matched, not found,
 * screen not learned yet, vague, ambiguous, not understood) and a suggestion where it needs one. No browser is opened: the screens
 * are those the runs and walkthroughs saved.
 *
 *   npm run engine:lint                                        the two OrangeHRM workbooks of the project
 *   npm run engine:lint -- tests.xlsx --explore=<dir>          a workbook, matched with the screens saved under <dir>
 *   npm run engine:lint -- --all                               also list the lines that are fine
 *
 * Exit 1 when a line has no status or a vague line has no suggestion (the E0.15 exit test).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCase } from '../engine/index.js';
import { knowledgeFromRuns } from '../engine/knowledge/from-runs.js';
import { type LintLine, lintCase, lintCounts, lintText } from '../engine/language/lint.js';
import { readWorkbook } from '../importer/workbook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const all = args.includes('--all');
const explore = args.find((a) => a.startsWith('--explore='))?.slice('--explore='.length);
const targets = files.length
  ? files
  : ['test/fixtures/OrangeHRM_Login_Test_Cases_Updated.xlsx', 'test/fixtures/Add_Employee.xlsx'].map((f) => path.join(root, f));

const knowledge = explore ? await knowledgeFromRuns('lint', undefined, explore, [], { cache: false }) : undefined;
if (explore) console.log(`${knowledge?.screens?.length ?? 0} screen(s) learned under ${explore}\n`);

const everything: LintLine[] = [];
for (const file of targets) {
  const imported = await readWorkbook(file);
  console.log(`${'='.repeat(78)}\n${path.basename(file)}\n${'='.repeat(78)}`);
  for (const c of imported.cases) {
    const lines = lintCase(await compileCase(c.raw, { ...(knowledge ? { knowledge } : {}) }), knowledge);
    everything.push(...lines);
    const shown = all ? lines : lines.filter((l) => l.status !== 'understood' && l.status !== 'matched');
    if (shown.length) console.log(`\n${c.raw.id}  ${c.raw.title.split('\n').join(' ')}\n${lintText(shown)}`);
  }
  console.log('');
}

const counts = lintCounts(everything);
console.log(
  `Lines: ${everything.length}. ${Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}`,
);
const noSuggestion = everything.filter((l) => l.status === 'vague' && !l.suggestion);
const noStatus = everything.filter((l) => !l.status);
console.log(
  `Exit test: every line has a status (${noStatus.length ? 'NO' : 'yes'}); every vague line has a suggestion (${noSuggestion.length ? 'NO' : 'yes'})`,
);
if (noStatus.length || noSuggestion.length) process.exitCode = 1;
