import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { masker } from '../explorer/values.js';
import type { ManifestTest } from '../generator/plan.js';
import { type ReportedTest, type TestVerdict, verdictFor } from '../results/verdict.js';

/**
 * Execution manager (FR-RUN-01…03): runs a generated project with Playwright Test, follows the
 * reporter's events, and turns the results into verdicts. MCP is not involved (D3).
 */

export interface Manifest {
  version: number;
  name: string;
  baseUrl: string;
  testIdAttribute: string;
  envVars: string[];
  /** Variables holding secrets, masked in every result (FR-EV-03). */
  secretVars: string[];
  tests: ManifestTest[];
}

export interface RunOptions {
  /** Only these test cases; all of them when empty. */
  testIds?: string[];
  /** Added to the process environment, e.g. credentials. The workspace's own .env is read too (FR-ENV-05). */
  env?: Record<string, string | undefined>;
  /** Where run records and evidence are kept. Default `.auto-qa/runs`. */
  runsDir?: string;
  /** Called for every reporter event (test-begin, step-end, test-end), for live progress (FR-RUN-02). */
  onEvent?: (event: RunEvent) => void;
}

export interface RunEvent {
  event: 'test-begin' | 'step-end' | 'test-end' | 'run-end';
  testId?: string;
  step?: string;
  status?: string;
  duration?: number;
}

export interface RunResult {
  executionId: string;
  startedAt: string;
  durationMs: number;
  verdicts: TestVerdict[];
  /** The run's folder: result.json and the evidence copied out of the workspace. */
  dir: string;
  /** The last lines Playwright printed, for when a run fails before any test starts. */
  output: string;
}

export async function readManifest(workspace: string): Promise<Manifest> {
  const file = path.join(workspace, 'auto-qa.json');
  if (!existsSync(file)) throw new Error(`${workspace} has no auto-qa.json. Generate it with npm run generate.`);
  return JSON.parse(await readFile(file, 'utf8')) as Manifest;
}

export async function runWorkspace(workspace: string, options: RunOptions = {}): Promise<RunResult> {
  const manifest = await readManifest(workspace);
  const tests = options.testIds?.length ? manifest.tests.filter((t) => options.testIds?.includes(t.testId)) : manifest.tests;
  const unknown = options.testIds?.filter((id) => !manifest.tests.some((t) => t.testId === id)) ?? [];
  if (unknown.length) throw new Error(`${workspace} has no test ${unknown.join(', ')}. It has: ${manifest.tests.map((t) => t.testId).join(', ')}`);

  const runsDir = options.runsDir ?? path.join('.auto-qa', 'runs');
  const executionId = await nextExecutionId(runsDir);
  const dir = path.join(runsDir, executionId);
  await mkdir(dir, { recursive: true });

  const env: Record<string, string | undefined> = { ...process.env, ...readEnvFile(path.join(workspace, '.env')), ...options.env };
  const secrets = manifest.secretVars.flatMap((n) => (env[n] ? [env[n] as string] : []));
  const mask = masker(secrets);
  const missing = manifest.envVars.filter((n) => n !== 'BASE_URL' && !env[n]);
  const startedAt = new Date();

  // FR-ENV-05: without its credentials a test cannot run; it is BLOCKED, not FAILED.
  const needs = (t: ManifestTest) => missing.filter((n) => specUses(workspace, t, n));
  const runnable = tests.filter((t) => !needs(t).length);

  let reported: ReportedTest[] = [];
  let output = '';
  if (runnable.length) {
    const resultsFile = path.join(workspace, 'reports', 'auto-qa-results.json');
    await rm(resultsFile, { force: true });
    output = await spawnPlaywright(workspace, runnable, { ...env, AUTO_QA_EXECUTION_ID: executionId, FORCE_COLOR: '0' }, options.onEvent);
    if (existsSync(resultsFile)) reported = (JSON.parse(await readFile(resultsFile, 'utf8')) as { tests: ReportedTest[] }).tests;
  }

  const verdicts: TestVerdict[] = [];
  for (const t of tests) {
    const r = reported.find((x) => x.testId === t.testId);
    const v = verdictFor(t, r, { executionId, missingEnv: needs(t) });
    v.evidence.screenshots = await keep(workspace, dir, v.evidence.screenshots);
    if (v.evidence.trace) v.evidence.trace = (await keep(workspace, dir, [v.evidence.trace]))[0];
    verdicts.push(maskVerdict(v, mask));
  }

  const result: RunResult = {
    executionId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    verdicts,
    dir,
    output: mask(output.slice(-4000)),
  };
  await writeFile(path.join(dir, 'result.json'), `${JSON.stringify({ ...result, workspace }, null, 2)}\n`);
  return result;
}

/**
 * Masks secrets in what the run produced (actual results, errors, page facts), not in the tester's own
 * words (title, steps, expected), which never hold one (FR-TD-02), nor in evidence file paths.
 * Masking everything would turn a title like "Wrong password" into "•••• password" when a secret is "wrong".
 */
export function maskVerdict(v: TestVerdict, mask: (text: string) => string): TestVerdict {
  const m = (text?: string) => (text === undefined ? undefined : mask(text));
  return {
    ...v,
    reason: mask(v.reason),
    actual: mask(v.actual),
    error: m(v.error),
    checks: v.checks.map((c) => ({ ...c, actual: mask(c.actual) })),
    evidence: { ...v.evidence, facts: v.evidence.facts && (JSON.parse(mask(JSON.stringify(v.evidence.facts))) as typeof v.evidence.facts) },
  };
}

/** EXEC-2026-00001, EXEC-2026-00002… one sequence per year (FR-EN-06). */
export async function nextExecutionId(runsDir: string): Promise<string> {
  await mkdir(runsDir, { recursive: true });
  const file = path.join(runsDir, 'sequence.json');
  const year = new Date().getFullYear();
  const seq: Record<string, number> = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  seq[year] = (seq[year] ?? 0) + 1;
  await writeFile(file, `${JSON.stringify(seq, null, 2)}\n`);
  return `EXEC-${year}-${String(seq[year]).padStart(5, '0')}`;
}

function spawnPlaywright(workspace: string, tests: ManifestTest[], env: Record<string, string | undefined>, onEvent?: (e: RunEvent) => void): Promise<string> {
  const require = createRequire(import.meta.url);
  // The workspace's own Playwright when it was installed there, otherwise the platform's (same version).
  let cli: string;
  try {
    cli = require.resolve('@playwright/test/cli', { paths: [path.resolve(workspace)] });
  } catch {
    cli = require.resolve('@playwright/test/cli');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', ...tests.map((t) => t.file)], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let buffered = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      buffered += text;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('AUTOQA ')) continue;
        try {
          onEvent?.(JSON.parse(line.slice(7)) as RunEvent);
        } catch {}
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c: Buffer) => {
      output += c.toString();
    });
    child.on('error', reject);
    child.on('close', () => resolve(output));
  });
}

/** Copies evidence out of the workspace, whose reports/ folder the next run replaces (FR-EV-01). */
async function keep(workspace: string, dir: string, files: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const [i, rel] of files.entries()) {
    const from = path.join(workspace, rel);
    if (!existsSync(from)) continue;
    const to = path.join(dir, 'evidence', `${i}-${path.basename(path.dirname(from))}-${path.basename(from)}`);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    kept.push(to);
  }
  return kept;
}

/** Whether a test's spec reads `process.env.NAME`, so only the tests that need a missing value are blocked. */
function specUses(workspace: string, test: ManifestTest, name: string): boolean {
  try {
    return readFileSync(path.join(workspace, test.file), 'utf8').includes(`process.env.${name}`);
  } catch {
    return true;
  }
}

/** KEY=value lines; the workspace's .env holds the credentials from the form (FR-ENV-05). */
function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
