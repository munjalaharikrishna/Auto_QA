/**
 * The whole flow for written test cases: parse → explore → generate → run → PASS / FAIL / BLOCKED / NEEDS REVIEW.
 *
 *   npm run auto-qa -- tests.xlsx --base-url https://app.example.com            a whole workbook (M6b)
 *   npm run auto-qa -- tests.xlsx --base-url https://app.example.com --only-review   answer the review queue
 *   npm run auto-qa -- examples/test-cases.json --id TC-LOGIN-001 --base-url https://www.saucedemo.com
 *
 * A workbook (.xlsx, .csv) runs unattended (D22) and its results go to a copy, <name>.results.xlsx (D23).
 * Saved complete explorations are reused while a case's steps are unchanged (--reexplore to force).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FIELDS, type Field } from '../importer/columns.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { runBatch } from '../pipeline/batch.js';
import { runCases } from '../pipeline/run-cases.js';
import { formatVerdict, summaryLine } from '../results/report.js';
import type { TestVerdict } from '../results/verdict.js';
import { terminalResolver } from './terminal-resolver.js';

const args = process.argv.slice(2);
const valueFlags = ['--id', '--base-url', '--env-file', '--test-id-attribute', '--workspace', '--login', '--sheet', '--out', '--map'];
const all = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const flag = (name: string) => all(name)[0];
const [file] = args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
if (!file) {
  console.error(`Usage: npm run auto-qa -- <tests.xlsx | tests.csv | test-cases.json> [options]

  --base-url URL              the application (or BASE_URL in .env)
  --env-file .env             credentials and other values (default .env)
  --test-id-attribute name    e.g. data-test
  --login TC-ID               case to run first for "Logged in" preconditions
  --workspace dir             where to generate the project (default workspaces/<site>)
  --reexplore                 explore again even when a saved exploration can be reused
  --headed                    show the browser

  Workbooks:
  --sheet name                worksheet (default: the first with test cases)
  --map field="Header"        a column the automatic matching does not know, e.g. --map steps="What to do"
  --out file.xlsx             results copy (default <name>.results.xlsx)
  --only-review               run only the cases set aside last time, and ask in the terminal
  --interactive               ask in the terminal instead of setting cases aside

  JSON test cases:
  --id TC-1                   only these cases (repeatable)
  --unattended                never wait for an answer`);
  process.exit(1);
}
const envFile = flag('--env-file') ?? '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);
const baseUrl = flag('--base-url') ?? process.env.BASE_URL;
if (!baseUrl) {
  console.error('Set BASE_URL (in .env or the environment) or pass --base-url.');
  process.exit(1);
}

const config = defaultParserConfig();
const isWorkbook = /\.(xlsx|xlsm|csv)$/i.test(file);
// D22: a workbook never waits, unless the tester is answering its review queue.
const unattended = isWorkbook ? !(args.includes('--interactive') || args.includes('--only-review')) : args.includes('--unattended');
const { resolver, questions, close } = terminalResolver({ unattended });
const common = {
  config,
  baseUrl,
  env: process.env,
  resolver,
  questions: () => questions,
  testIdAttribute: flag('--test-id-attribute'),
  headless: !args.includes('--headed'),
  workspace: flag('--workspace'),
  reexplore: args.includes('--reexplore'),
  onProgress: (m: string) => console.log(m),
};

try {
  let verdicts: TestVerdict[];
  let executionId: string | undefined;
  let workspace: string | undefined;
  if (isWorkbook) {
    const batch = await runBatch(file, {
      ...common,
      sheet: flag('--sheet'),
      mapping: mappingFlags(),
      out: flag('--out'),
      onlyReview: args.includes('--only-review'),
      loginId: flag('--login'),
    });
    verdicts = batch.results.flatMap((r) => (r.verdict ? [r.verdict] : []));
    executionId = batch.summary.executionId;
    workspace = batch.workspace;
    const failures = verdicts.filter((v) => v.status === 'FAIL' || v.status === 'BLOCKED');
    console.log('');
    for (const v of failures) console.log(`${formatVerdict(v)}\n`);
    const t = batch.summary.totals;
    console.log(
      `${executionId ?? 'no run'}: ${t.PASS} pass · ${t.FAIL} fail · ${t.BLOCKED} blocked · ${t['NEEDS REVIEW']} need review · ${t['NOT VERIFIED']} not verified`,
    );
    if (batch.summary.review.length) {
      console.log(`\nReview queue (${batch.summary.review.length}):`);
      for (const q of batch.summary.review) console.log(`  ? ${q.testId} (row ${q.row})${q.step ? ` ${q.step}` : ''}: ${q.question}`);
      console.log(`\nFix the rows in the workbook, or answer the questions with: npm run auto-qa -- ${file} --only-review`);
    }
    console.log(`\nResults: ${batch.out}`);
    process.exitCode = t.FAIL + t.BLOCKED + t['NEEDS REVIEW'] + t['NOT VERIFIED'] ? 1 : 0;
  } else {
    const input: unknown = JSON.parse(await readFile(file, 'utf8'));
    const models = (Array.isArray(input) ? input : [input]).map((raw) => parseTestCase(raw, config));
    const ids = all('--id');
    const selected = ids.length ? models.filter((m) => ids.includes(m.id)) : models;
    const login = flag('--login') ? models.find((m) => m.id === flag('--login')) : undefined;
    const result = await runCases(selected, {
      ...common,
      login,
      onRunEvent: (e) => {
        if (e.event === 'step-end') console.log(`   ${e.status === 'passed' ? '✔' : '✖'} ${e.testId} ${e.step}`);
      },
    });
    verdicts = result.verdicts;
    executionId = result.executionId;
    workspace = result.workspace;
    console.log('');
    for (const v of verdicts) console.log(`${formatVerdict(v)}\n`);
    console.log(`${executionId ?? 'no run'}: ${summaryLine(verdicts)}`);
    process.exitCode = verdicts.every((v) => v.status === 'PASS') ? 0 : 1;
  }
  if (workspace) console.log(`Project: ${path.normalize(workspace)}`);
} finally {
  close();
}

/** --map steps="What to do" --map expected=Outcome → { steps: 'What to do', expected: 'Outcome' }. */
function mappingFlags(): Partial<Record<Field, string>> {
  const mapping: Partial<Record<Field, string>> = {};
  for (const m of all('--map')) {
    const [field, ...rest] = m.split('=');
    if (!(FIELDS as readonly string[]).includes(field)) {
      console.error(`--map ${m}: "${field}" is not a field. Fields: ${FIELDS.join(', ')}`);
      process.exit(1);
    }
    mapping[field as Field] = rest.join('=').replace(/^["']|["']$/g, '');
  }
  return mapping;
}
