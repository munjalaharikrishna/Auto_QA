/**
 * Milestone 5: turn explored test cases into a standalone Playwright project with Page Objects.
 *
 *   npm run generate -- examples/demo-app/test-cases.json
 *   npm run generate -- examples/test-cases.json --id TC-LOGIN-001 --id TC-LOGIN-002 --out workspaces/saucedemo
 *
 * Each test case must have been explored first (npm run explore); its result is read from
 * .auto-qa/explore/<id>/exploration.json. Without --id, every explored case in the file is used.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult } from '../explorer/controller.js';
import { type GenerateInput, generateProject, workspaceName, writeProject } from '../generator/index.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';

const args = process.argv.slice(2);
const valueFlags = ['--id', '--out', '--explorations'];
const all = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const flag = (name: string) => all(name)[0];
const [file] = args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
if (!file) {
  console.error('Usage: npm run generate -- <test-cases.json> [--id TC-1 …] [--out workspaces/app] [--explorations .auto-qa/explore]');
  process.exit(1);
}

const config = defaultParserConfig();
const input: unknown = JSON.parse(await readFile(file, 'utf8'));
const models = (Array.isArray(input) ? input : [input]).map((raw) => parseTestCase(raw, config));
const ids = all('--id');
const exploreDir = flag('--explorations') ?? path.join('.auto-qa', 'explore');

const inputs: GenerateInput[] = [];
for (const model of models) {
  if (ids.length && !ids.includes(model.id)) continue;
  const f = path.join(exploreDir, model.id, 'exploration.json');
  if (!existsSync(f)) {
    if (ids.length) {
      console.error(`${model.id} has not been explored. Run: npm run explore -- ${file} --id ${model.id}`);
      process.exit(1);
    }
    continue;
  }
  inputs.push({ model, exploration: JSON.parse(await readFile(f, 'utf8')) as ExplorationResult });
}
if (!inputs.length) {
  console.error(`No explored test cases found for ${file}. Run npm run explore first.`);
  process.exit(1);
}

let result: Awaited<ReturnType<typeof generateProject>>;
const name = workspaceName(inputs[0].exploration.baseUrl);
try {
  result = await generateProject(inputs, name);
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
}
const out = flag('--out') ?? path.join('workspaces', name);
const { written, unchanged } = await writeProject(out, result.files);

console.log(`\nGenerated ${inputs.length} test(s) into ${out}`);
for (const p of result.plan.pages) {
  console.log(`  ${p.className} (${p.path}): ${p.properties.map((x) => x.name).join(', ')}`);
  for (const m of p.methods) console.log(`    ${m.name}(${m.params.join(', ')})`);
}
for (const w of result.plan.warnings) console.log(`  ! ${w}`);
console.log(`\n${written.length} file(s) written, ${unchanged.length} unchanged.`);
console.log(`Run it: cd ${out} && npm install && npx playwright test   (set BASE_URL and credentials in .env first)`);
