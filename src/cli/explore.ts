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
import { createInterface } from 'node:readline/promises';
import { type ExplorationResult, explore, type Resolver } from '../explorer/controller.js';
import { describe } from '../locators/match.js';
import { openSession } from '../locators/session.js';
import type { TestModel } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';

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

// D19: page URLs are kept with the environment, keyed by its base URL, so one app never uses another's pages.
const pagesFile = path.join('.auto-qa', 'pages.json');
const envKey = new URL(baseUrl).origin;
const allPages: Record<string, Record<string, string>> = existsSync(pagesFile) ? JSON.parse(await readFile(pagesFile, 'utf8')) : {};
const pageUrls = allPages[envKey] ?? {};

const interactive = process.stdin.isTTY;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
const resolver: Resolver = {
  async choose(r) {
    console.log(`\n⚠ ${r.item} "${r.raw}"\n  ${r.code}: ${r.text}`);
    for (const [i, c] of r.candidates.slice(0, 9).entries()) console.log(`  ${i + 1}) ${describe(c)}`);
    if (!rl) return 'skip';
    const a = (await rl.question(`  Pick 1-${Math.min(9, r.candidates.length)}, s to skip, q to stop: `)).trim().toLowerCase();
    if (a === 'q') return 'abort';
    const n = Number(a);
    return Number.isInteger(n) && n >= 1 && n <= r.candidates.length ? n - 1 : 'skip';
  },
  async pageUrl(r) {
    if (!rl) {
      console.log(`\n⚠ ${r.item}: the URL of the "${r.page}" page is not known. Run in a terminal to enter it.`);
      return 'abort';
    }
    const a = (await rl.question(`\n? ${r.item}: URL or path of the "${r.page}" page (q to stop): `)).trim();
    return !a || a === 'q' ? 'abort' : a;
  },
  async confirm(r) {
    console.log(`\n⚠ ${r.item} ${r.code}: ${r.text}`);
    if (!rl) return false;
    return /^y/i.test((await rl.question('  y/n: ')).trim());
  },
};

const outDir = flag('--out') ?? path.join('.auto-qa', 'explore', model.id);
const session = await openSession({ headless: !args.includes('--headed'), testIdAttribute: flag('--test-id-attribute') });
let result: ExplorationResult;
try {
  result = await explore(model, session, { config, baseUrl, env: process.env, pageUrls, resolver, outDir, production: args.includes('--production'), login });
} finally {
  rl?.close();
  await session.close();
}

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'exploration.json'), JSON.stringify(result, null, 2));
if (Object.keys(result.learnedPageUrls).length) {
  await mkdir(path.dirname(pagesFile), { recursive: true });
  await writeFile(pagesFile, JSON.stringify({ ...allPages, [envKey]: { ...pageUrls, ...result.learnedPageUrls } }, null, 2));
}

console.log(`\n━━ ${result.testId}  ${result.title}  (${result.status})`);
for (const i of result.items) {
  const mark = i.status === 'done' ? '✔' : i.status === 'skipped' ? '–' : '✖';
  const what = i.kind === 'step' ? (i.action ?? '?').toUpperCase() : `EXPECT ${i.type}`;
  console.log(`   ${mark} ${i.phase === 'setup' ? 'setup ' : ''}${i.id.padEnd(4)} ${what.padEnd(16)} ${i.raw}`);
  if (i.locator)
    console.log(
      `          ${i.locator.code}${i.locator.validated ? '' : '  (not validated)'}${i.page ? `  on ${i.page.name}` : ''}${i.resolvedBy === 'tester' ? '  (picked)' : ''}`,
    );
  if (i.effect) console.log(`          → ${i.effect}`);
  if (i.observed?.textFound !== undefined) console.log(`          text ${i.observed.textFound ? 'is' : 'is NOT'} on the page now`);
  for (const w of i.warnings) console.log(`          ! ${w}`);
  if (i.error) console.log(`          ✖ ${i.error}`);
}
console.log(
  `\nPages: ${Object.entries(result.pages)
    .map(([n, p]) => `${n} ${p.path}`)
    .join(' · ')}`,
);
console.log(`Saved ${path.join(outDir, 'exploration.json')}`);
process.exitCode = result.status === 'complete' ? 0 : 1;
