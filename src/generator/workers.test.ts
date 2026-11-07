import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import type { ExplorationResult } from '../explorer/controller.js';
import type { RawTestCase } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { type GenerateInput, generateProject, writeProject } from './index.js';

/**
 * E0.16 item 5 (audit P5, PD-15): one account per worker, one worker by default, and every test starting with no saved login. Run
 * on the demo app only: OrangeHRM has one test account, so its runs stay at one worker.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const config = defaultParserConfig();
const cases: RawTestCase[] = JSON.parse(readFileSync(path.join(root, 'examples/demo-app/test-cases.json'), 'utf8'));
const exploration = (id: string): ExplorationResult => JSON.parse(readFileSync(path.join(here, `fixtures/demo/${id}.exploration.json`), 'utf8'));
const demoInputs = (): GenerateInput[] =>
  ['TC-DEMO-001', 'TC-DEMO-002', 'TC-DEMO-003'].map((id) => ({
    model: parseTestCase(cases.find((c) => c.id === id) as RawTestCase, config),
    exploration: exploration(id),
  }));

/** Two spec files that note which worker ran them and which account it had: what the run says about accounts per worker. */
const PROBE = (name: string): string => `import { test } from '../fixtures/test.fixture';

for (const n of [1, 2]) {
  test('${name} ' + n, async ({ account }, testInfo) => {
    testInfo.annotations.push({ type: 'worker', description: String(testInfo.parallelIndex) });
    testInfo.annotations.push({ type: 'account', description: process.env.TEST_USERNAME ?? '' });
    testInfo.annotations.push({ type: 'fixture', description: account.username ?? '' });
    await new Promise((r) => setTimeout(r, 300));
  });
}
`;

interface Result {
  title: string;
  ok: boolean;
  worker: number;
  account: string;
  fixture: string;
}

describe('workers and accounts (E0.16)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  const exec = promisify(execFile);
  const require = createRequire(import.meta.url);
  const dir = path.join(root, '.auto-qa', 'test-workspaces', 'workers');
  let app: Awaited<ReturnType<typeof startDemoApp>>;

  before(async () => {
    app = await startDemoApp();
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeProject(dir, (await generateProject(demoInputs(), 'demo')).files);
  });
  after(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs the project's tests (or the files given) and returns each test's outcome and notes. */
  const run = async (env: Record<string, string | undefined>, files: string[] = []): Promise<{ results: Result[]; stderr: string }> => {
    const cli = require.resolve('@playwright/test/cli');
    const out = await exec(process.execPath, [cli, 'test', '--reporter=json', ...files], {
      cwd: dir,
      env: { ...process.env, BASE_URL: app.url, AUTO_QA_WORKERS: undefined, ...env },
      maxBuffer: 50 * 1024 * 1024,
    }).catch((e: { stdout: string; stderr: string }) => e);
    const report = JSON.parse(out.stdout) as { suites: unknown[] };
    const results: Result[] = [];
    const walk = (suite: { specs?: unknown[]; suites?: unknown[] }): void => {
      for (const spec of (suite.specs ?? []) as Array<{
        title: string;
        ok: boolean;
        tests: Array<{ annotations: Array<{ type: string; description?: string }>; results: Array<{ parallelIndex: number }> }>;
      }>) {
        const t = spec.tests[0];
        const note = (type: string): string => t?.annotations.find((a) => a.type === type)?.description ?? '';
        results.push({ title: spec.title, ok: spec.ok, worker: t?.results[0]?.parallelIndex ?? -1, account: note('account'), fixture: note('fixture') });
      }
      for (const s of (suite.suites ?? []) as Array<{ specs?: unknown[]; suites?: unknown[] }>) walk(s);
    };
    for (const s of report.suites as Array<{ specs?: unknown[]; suites?: unknown[] }>) walk(s);
    return { results, stderr: out.stderr };
  };

  it('two workers with two accounts: each worker logs in as its own account, never the other', async () => {
    await writeFile(path.join(dir, 'tests', 'probe-a.spec.ts'), PROBE('a'));
    await writeFile(path.join(dir, 'tests', 'probe-b.spec.ts'), PROBE('b'));
    const { results } = await run(
      { AUTO_QA_WORKERS: '2', TEST_USERNAME_1: 'alice', TEST_PASSWORD_1: 'pw-a', TEST_USERNAME_2: 'bob', TEST_PASSWORD_2: 'pw-b' },
      ['tests/probe-a.spec.ts', 'tests/probe-b.spec.ts'],
    );
    assert.equal(results.length, 4);
    assert.ok(results.every((r) => r.ok));
    const byWorker = new Map<number, Set<string>>();
    for (const r of results) byWorker.set(r.worker, (byWorker.get(r.worker) ?? new Set()).add(r.account));
    assert.deepEqual([...byWorker.keys()].sort(), [0, 1], 'both workers ran');
    assert.deepEqual([...(byWorker.get(0) ?? [])], ['alice']);
    assert.deepEqual([...(byWorker.get(1) ?? [])], ['bob']);
    assert.ok(results.every((r) => r.fixture === r.account));
  });

  it('more workers than accounts: the run is cut to the accounts there are, and says so', async () => {
    const { results, stderr } = await run({ AUTO_QA_WORKERS: '2', TEST_USERNAME: 'solo', TEST_PASSWORD: 'pw' }, [
      'tests/probe-a.spec.ts',
      'tests/probe-b.spec.ts',
    ]);
    assert.ok(results.every((r) => r.ok && r.worker === 0 && r.account === 'solo'));
    assert.match(stderr, /2 workers asked, 0 account\(s\) given/);
  });

  it('one worker by default', async () => {
    const { results } = await run({ TEST_USERNAME_1: 'alice', TEST_PASSWORD_1: 'pw-a', TEST_USERNAME_2: 'bob', TEST_PASSWORD_2: 'pw-b' }, [
      'tests/probe-a.spec.ts',
      'tests/probe-b.spec.ts',
    ]);
    assert.ok(results.every((r) => r.worker === 0 && r.account === 'alice'));
  });

  it('the demo app with two workers and an account each: the logins pass, and the wrong-login case starts signed out', async () => {
    await rm(path.join(dir, 'tests', 'probe-a.spec.ts'), { force: true });
    await rm(path.join(dir, 'tests', 'probe-b.spec.ts'), { force: true });
    const { results } = await run({
      AUTO_QA_WORKERS: '2',
      TEST_USERNAME_1: DEMO_USER.username,
      TEST_PASSWORD_1: DEMO_USER.password,
      TEST_USERNAME_2: DEMO_USER.username,
      TEST_PASSWORD_2: DEMO_USER.password,
      TEST_WRONG_PASSWORD: 'nope',
    });
    assert.equal(results.length, 3);
    // TC-DEMO-002 expects the rejection of a wrong password: it passes only when its browser was not already signed in.
    assert.ok(
      results.every((r) => r.ok),
      results.map((r) => `${r.title}: ${r.ok}`).join('\n'),
    );
    assert.ok(new Set(results.map((r) => r.worker)).size >= 1);
  });
});
