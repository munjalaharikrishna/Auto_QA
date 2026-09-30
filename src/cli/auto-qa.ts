/**
 * The whole flow for written test cases: parse → explore → generate → run → PASS / FAIL / BLOCKED / NEEDS REVIEW.
 *
 *   npm run auto-qa -- examples/demo-app/test-cases.json --base-url http://127.0.0.1:4173
 *   npm run auto-qa -- examples/test-cases.json --id TC-LOGIN-001 --base-url https://www.saucedemo.com --test-id-attribute data-test
 *
 * Saved complete explorations are reused while a case's steps are unchanged (--reexplore to force).
 * --unattended never waits for an answer: a case that needs one is set aside as NEEDS REVIEW (D22).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { runCases } from '../pipeline/run-cases.js';
import { formatVerdict, summaryLine } from '../results/report.js';
import { terminalResolver } from './terminal-resolver.js';

const args = process.argv.slice(2);
const valueFlags = ['--id', '--base-url', '--env-file', '--test-id-attribute', '--workspace', '--login'];
const all = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const flag = (name: string) => all(name)[0];
const [file] = args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
if (!file) {
  console.error(
    'Usage: npm run auto-qa -- <test-cases.json> [--id TC-1 …] [--base-url URL] [--env-file .env] [--login TC-LOGIN] [--test-id-attribute data-test] [--workspace dir] [--reexplore] [--unattended] [--headed]',
  );
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
const input: unknown = JSON.parse(await readFile(file, 'utf8'));
const models = (Array.isArray(input) ? input : [input]).map((raw) => parseTestCase(raw, config));
const ids = all('--id');
const selected = ids.length ? models.filter((m) => ids.includes(m.id)) : models;
const login = flag('--login') ? models.find((m) => m.id === flag('--login')) : undefined;

const { resolver, questions, close } = terminalResolver({ unattended: args.includes('--unattended') });
try {
  const result = await runCases(selected, {
    config,
    baseUrl,
    env: process.env,
    resolver,
    questions: () => questions,
    testIdAttribute: flag('--test-id-attribute'),
    headless: !args.includes('--headed'),
    workspace: flag('--workspace'),
    login,
    reexplore: args.includes('--reexplore'),
    onProgress: (m) => console.log(m),
    onRunEvent: (e) => {
      if (e.event === 'step-end') console.log(`   ${e.status === 'passed' ? '✔' : '✖'} ${e.testId} ${e.step}`);
    },
  });
  console.log('');
  for (const v of result.verdicts) console.log(`${formatVerdict(v)}\n`);
  console.log(`${result.executionId ?? 'no run'}: ${summaryLine(result.verdicts)}`);
  if (result.workspace) console.log(`Project: ${result.workspace}`);
  process.exitCode = result.verdicts.every((v) => v.status === 'PASS') ? 0 : 1;
} finally {
  close();
}
