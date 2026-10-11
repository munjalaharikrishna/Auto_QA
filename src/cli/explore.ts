/**
 * Milestone 4: explore one test case in the real app, step by step, and save what was found.
 *
 *   npm run explore -- examples/demo-app/test-cases.json --id TC-DEMO-001 --base-url http://127.0.0.1:4173
 *   npm run explore -- examples/test-cases.json --id TC-LOGIN-001 --test-id-attribute data-test --headed
 *
 * Values such as TEST_USERNAME come from the environment or a .env file (--env-file, default .env).
 * When a step needs the tester (ambiguous element, unknown page URL…) it asks here; without a
 * terminal it skips the step or stops. Output: .auto-qa/explore/<id>/exploration.json + screenshots.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type ExplorationResult, explore } from '../explorer/controller.js';
import { loadPageUrls, savePageUrls } from '../explorer/page-store.js';
import { openSession } from '../locators/session.js';
import type { TestModel } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { terminalResolver } from './terminal-resolver.js';

const args = process.argv.slice(2);
const valueFlags = ['--id', '--base-url', '--env-file', '--test-id-attribute', '--out', '--login'];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [file] = args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
if (!file) {
  console.error(
    'Usage: npm run explore -- <test-cases.json> [--id TC-1] [--base-url URL] [--env-file .env] [--login TC-LOGIN] [--test-id-attribute data-test] [--headed] [--production] [--out dir]',
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
const pick = (id: string | undefined): TestModel | undefined => (id ? models.find((m) => m.id === id) : models[0]);
const model = pick(flag('--id'));
if (!model) {
  console.error(`No test case ${flag('--id')} in ${file}. Found: ${models.map((m) => m.id).join(', ')}`);
  process.exit(1);
}
const login = flag('--login') ? pick(flag('--login')) : undefined;

// D19: learned page URLs are kept per environment.
const pageUrls = await loadPageUrls(baseUrl);
const { resolver, close } = terminalResolver();

const outDir = flag('--out') ?? path.join('.auto-qa', 'explore', model.id);
const session = await openSession({ headless: !args.includes('--headed'), testIdAttribute: flag('--test-id-attribute') });
let result: ExplorationResult;
try {
  result = await explore(model, session, { config, baseUrl, env: process.env, pageUrls, resolver, outDir, production: args.includes('--production'), login });
} finally {
  close();
  await session.close();
}

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'exploration.json'), JSON.stringify(result, null, 2));
await savePageUrls(baseUrl, result.learnedPageUrls);

console.log(`\n━━ ${result.testId}  ${result.title}  (${result.status})`);
for (const i of result.items) {
  const mark = i.status === 'done' ? '✔' : i.status === 'skipped' ? '–' : '✖';
  const what = i.kind === 'step' ? (i.action ?? '?').toUpperCase() : `EXPECT ${i.type}`;
  console.log(`   ${mark} ${i.phase === 'setup' ? 'setup ' : ''}${i.id.padEnd(4)} ${what.padEnd(16)} ${i.raw}`);
  if (i.locator) {
    const notes = `${i.locator.validated ? '' : '  (not validated)'}${i.page ? `  on ${i.page.name}` : ''}${i.resolvedBy === 'tester' ? '  (picked)' : ''}`;
    console.log(`          ${i.locator.code}${notes}`);
  }
  if (i.effect) console.log(`          → ${i.effect}`);
  if (i.observed?.textFound !== undefined) console.log(`          text ${i.observed.textFound ? 'is' : 'is NOT'} on the page now`);
  for (const w of i.warnings) console.log(`          ! ${w}`);
  if (i.error) console.log(`          ✖ ${i.error}`);
}
const pages = Object.entries(result.pages).map(([n, p]) => `${n} ${p.path}`);
console.log(`\nPages: ${pages.join(' · ')}`);
console.log(`Saved ${path.join(outDir, 'exploration.json')}`);
process.exitCode = result.status === 'complete' ? 0 : 1;
