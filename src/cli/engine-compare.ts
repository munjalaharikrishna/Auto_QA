/**
 * Compare mode: one workbook through the legacy engine and through the new engine, side by side.
 *
 *   npm run engine:compare -- --project bookmarket --workbook "path/to/tests.xlsx"
 *   npm run engine:compare -- --project bookmarket --workbook tests.xlsx --headed --only TC01,TC02
 *
 * The project gives the application address, credentials (its workspace .env), rules and learned page routes, read from a
 * snapshot of the database, so the real data is not touched. The legacy arm is the run the app does today. The new arm
 * compiles every case and runs each one the verdict engine can judge through the new executor, with no fallback, so what it
 * cannot do shows as NOT RUN with the reason. Everything is written to .auto-qa/compare/<time>/ and nothing else changes.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { LocalArtifactStore } from '../db/artifacts.js';
import { Store } from '../db/store.js';
import { CATEGORY, compileCase, preflightOf } from '../engine/index.js';
import { readWorkbook } from '../importer/workbook.js';
import { withRules } from '../parser/config.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { rulesFor } from '../parser/rules.js';
import { type CompareRow, compareRow, compareTable } from '../pipeline/compare.js';
import { runCases } from '../pipeline/run-cases.js';
import { runSemanticJobs, type SemanticJob, semanticSupport } from '../pipeline/semantic-run.js';
import type { TestVerdict } from '../results/verdict.js';
import { readEnvFile } from '../server/credentials.js';
import { terminalResolver } from './terminal-resolver.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((_a, i) => args[i - 1] === name);
const projectId = flag('--project');
const workbook = flag('--workbook');
if (!projectId || !workbook) {
  console.error('Usage: npm run engine:compare -- --project <project id> --workbook <tests.xlsx> [--only TC01,TC02] [--headed] [--data-dir .auto-qa]');
  process.exit(1);
}
const dataDir = path.resolve(flag('--data-dir') ?? process.env.AUTO_QA_DATA ?? path.join(root, '.auto-qa'));
const workspacesDir = path.resolve(process.env.AUTO_QA_WORKSPACES ?? path.join(root, 'workspaces'));
const only = flag('--only')
  ?.split(',')
  .map((s) => s.trim());
const headless = !args.includes('--headed');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(dataDir, 'compare', stamp);
await mkdir(out, { recursive: true });

// A snapshot of the database: the project's rules and learned pages are read from it, and the live file is never opened for writing.
const snapshot = path.join(out, 'snapshot.db');
const live = path.join(dataDir, 'auto-qa.db');
if (!existsSync(live)) throw new Error(`No database at ${live}.`);
const source = new DatabaseSync(live, { readOnly: true });
try {
  source.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
} catch {
  copyFileSync(live, snapshot);
} finally {
  source.close();
}
const store = await Store.open(snapshot, { artifacts: new LocalArtifactStore({ local: dataDir, workspace: workspacesDir }) });

try {
  const project = await store.project(projectId);
  if (!project) throw new Error(`There is no project "${projectId}".`);
  const config = withRules(defaultParserConfig(), rulesFor(await store.rules(project.id)));
  const envId = await store.defaultEnvironmentId(project.id);
  const routes = envId ? await store.pageRoutes(envId) : {};
  const env = { ...process.env, ...readEnvFile(project.workspace) };
  const log = (m: string) => console.log(m);

  const imported = await readWorkbook(workbook);
  const cases = imported.cases.filter((c) => !only || only.includes(c.raw.id ?? ''));
  log(
    `${cases.length} test case(s) from "${path.basename(workbook)}", project ${project.id} (${project.baseUrl}), ${Object.keys(config.rules?.element ?? {}).length} element rule(s), ${Object.keys(routes).length} learned page(s)`,
  );
  const models = cases.map((c) => parseTestCase(c.raw, config));

  // ---- legacy arm: exactly the unattended run the app does today, in its own folders ----
  log('\n=== legacy engine ===');
  const { resolver, close } = terminalResolver({ unattended: true });
  let legacy: TestVerdict[] = [];
  try {
    const result = await runCases(models, {
      config,
      baseUrl: project.baseUrl,
      env,
      resolver,
      testIdAttribute: project.testIdAttribute,
      headless,
      workspace: path.join(out, 'legacy', 'workspace'),
      exploreDir: path.join(out, 'legacy', 'explore'),
      runsDir: path.join(out, 'legacy', 'runs'),
      pages: { load: async () => ({ ...routes }), save: async () => {} },
      engine: 'legacy',
      onProgress: log,
    });
    legacy = result.verdicts;
  } finally {
    close();
  }

  // ---- new arm: compile every case, run what the verdict engine can judge, say why for the rest ----
  log('\n=== new engine ===');
  const jobs: SemanticJob[] = [];
  const notRun = new Map<string, string>();
  const compileOf = new Map<string, string>();
  const newIssues = new Map<string, string[]>();
  for (const model of models) {
    const compiled = await compileCase(
      {
        id: model.id,
        title: model.title,
        type: model.type,
        preconditions: model.source.rawPreconditions,
        steps: model.source.rawSteps,
        testData: model.source.rawTestData,
        expected: model.source.rawExpected,
        requirementId: model.requirementId,
        row: model.source.row,
      },
      { config, pageRoutes: routes, env },
    );
    compileOf.set(model.id, `${compiled.status}, ${preflightOf(model.title, compiled).status}`);
    newIssues.set(
      model.id,
      unique(compiled.issues.filter((i) => i.severity !== 'info').map((i) => `${i.item ?? i.where} "${i.original}": ${CATEGORY[i.code]}: ${i.message}`)),
    );
    const support = semanticSupport(compiled);
    if (support.ok) jobs.push({ model, compiled, baseUrl: project.baseUrl, headless, testIdAttribute: project.testIdAttribute });
    else notRun.set(model.id, support.why);
    log(`${model.id}: compiled (${compiled.status}); ${support.ok ? 'will run' : `not run: ${support.why}`}`);
  }
  const ran = jobs.length
    ? await runSemanticJobs(jobs, { screenshotDir: path.join(out, 'new', 'screenshots'), onProgress: log })
    : new Map<string, TestVerdict>();
  for (const job of jobs) if (!ran.has(job.model.id)) notRun.set(job.model.id, 'the new executor could not run it (see the log above)');

  // ---- the table ----
  const rows: CompareRow[] = models.map((m) =>
    compareRow({
      testId: m.id,
      title: m.title,
      legacy: legacy.find((v) => v.testId === m.id),
      next: ran.get(m.id),
      notRun: notRun.get(m.id),
      compile: compileOf.get(m.id) ?? '',
      legacyIssues: legacyIssuesOf(legacy.find((v) => v.testId === m.id)),
      newIssues: newIssues.get(m.id) ?? [],
    }),
  );
  const table = compareTable(rows, `Legacy engine against the new engine: ${path.basename(workbook)}`);
  await writeFile(path.join(out, 'compare.md'), table);
  await writeFile(path.join(out, 'compare.json'), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`\n${table}\nWritten to ${out}`);
} finally {
  await store.close();
}

/** What the legacy run set aside for a person, one line per sentence. */
function legacyIssuesOf(verdict: TestVerdict | undefined): string[] {
  return unique((verdict?.review ?? []).map((r) => `${r.id} "${r.raw}": ${r.headline}`));
}

function unique(lines: string[]): string[] {
  return [...new Set(lines)];
}
