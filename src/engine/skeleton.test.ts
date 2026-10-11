import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import type { Resolver } from '../explorer/controller.js';
import type { RawTestCase } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { runCases } from '../pipeline/run-cases.js';
import { type CompileResult, validateIr } from './index.js';

/**
 * The walking skeleton (BP-1, E0.1): one real test case goes from text to verdict with `engine = semantic`, and the same
 * case with `engine = legacy` behaves as before. The demo application stands in for OrangeHRM; the run against the
 * real site is made by hand (it needs the site and a login). Needs Google Chrome. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const config = defaultParserConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const demoCases: RawTestCase[] = JSON.parse(readFileSync(path.join(root, 'examples/demo-app/test-cases.json'), 'utf8'));
const unattended: Resolver = { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false };

describe('walking skeleton: Excel text → QA-IR → plan → run → verdict', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  const base = path.join(root, '.auto-qa', 'test-skeleton');
  const env = { TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: DEMO_USER.password };
  const compiled: CompileResult[] = [];
  const run = (engine: 'legacy' | 'semantic', sub: string) =>
    runCases([parseTestCase(demoCases.find((c) => c.id === 'TC-DEMO-001')!, config)], {
      config,
      baseUrl: app.url,
      env,
      resolver: unattended,
      engine,
      onCompiled: (r) => void compiled.push(r),
      exploreDir: path.join(base, sub, 'explore'),
      runsDir: path.join(base, sub, 'runs'),
      workspace: path.join(base, sub, 'workspace'),
    });
  let semantic: Awaited<ReturnType<typeof run>>;
  let legacy: Awaited<ReturnType<typeof run>>;

  before(async () => {
    app = await startDemoApp();
    await rm(base, { recursive: true, force: true });
    semantic = await run('semantic', 'semantic');
    legacy = await run('legacy', 'legacy');
  });
  after(async () => {
    await app?.close();
  });

  it('gets the correct verdict with the semantic engine, the same as the legacy engine', () => {
    assert.equal(semantic.verdicts[0].status, 'PASS', JSON.stringify(semantic.verdicts[0]));
    assert.equal(legacy.verdicts[0].status, 'PASS');
  });

  it('keeps the QA-IR and a decision log that shows every compilation stage', () => {
    assert.equal(compiled.length, 1, 'only the semantic engine compiles');
    const dir = path.join(base, 'semantic', 'explore', 'TC-DEMO-001');
    const ir = JSON.parse(readFileSync(path.join(dir, 'qa-ir.json'), 'utf8'));
    assert.equal(validateIr(ir).ok, true);
    const { status, log } = JSON.parse(readFileSync(path.join(dir, 'decision-log.json'), 'utf8')) as { status: string; log: Array<{ stage: string }> };
    assert.equal(status, 'compiled');
    assert.deepEqual(
      [...new Set(log.map((l) => l.stage))],
      ['Read', 'Understand', 'Validate', 'BuildIr', 'ResolveData', 'ResolvePage', 'ResolveTarget', 'BuildPlan', 'ValidatePlan'],
    );
  });

  it('leaves the legacy engine exactly as it was: no QA-IR, no decision log', () => {
    assert.equal(existsSync(path.join(base, 'legacy', 'explore', 'TC-DEMO-001', 'qa-ir.json')), false);
    assert.equal(existsSync(path.join(base, 'legacy', 'explore', 'TC-DEMO-001', 'decision-log.json')), false);
  });
});
