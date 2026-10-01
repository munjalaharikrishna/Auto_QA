import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import type { Resolver } from '../explorer/controller.js';
import type { RawTestCase } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { runCases } from '../pipeline/run-cases.js';
import type { TestVerdict } from '../results/verdict.js';

/**
 * The acceptance test of REAL-WORLD-TEST-CASES.md §9: ten login test cases written the way testers write them
 * (examples/real-world/login-cases.json), run unattended against a login page laid out like OrangeHRM's.
 * Needs Google Chrome, no internet. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const config = defaultParserConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cases: RawTestCase[] = JSON.parse(readFileSync(path.join(root, 'examples/real-world/login-cases.json'), 'utf8'));
const asked: string[] = [];
const unattended: Resolver = {
  choose: async (r) => {
    asked.push(`${r.item} ${r.raw}: ${r.text}`);
    return 'skip';
  },
  pageUrl: async () => 'abort',
  confirm: async (r) => {
    asked.push(`${r.item}: ${r.text}`);
    return false;
  },
};

describe('real-world login test cases (REAL-WORLD-TEST-CASES.md §9)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let verdicts: TestVerdict[];
  const base = path.join(root, '.auto-qa', 'test-realworld');
  const of = (id: string) => verdicts.find((v) => v.testId === id)!;

  before(async () => {
    app = await startDemoApp();
    await rm(base, { recursive: true, force: true });
    const run = await runCases(
      cases.map((c) => parseTestCase(c, config)),
      {
        config,
        baseUrl: `${app.url}/legacy`,
        env: { TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: DEMO_USER.password },
        resolver: unattended,
        exploreDir: path.join(base, 'explore'),
        runsDir: path.join(base, 'runs'),
        workspace: path.join(base, 'workspace'),
      },
    );
    verdicts = run.verdicts;
  });
  after(async () => {
    await app?.close();
  });

  const detail = (id: string) =>
    JSON.stringify({ status: of(id)?.status, reason: of(id)?.reason, checks: of(id)?.checks.map((c) => [c.id, c.result, c.actual]) });

  // Phase R1: wording and element fixes.
  for (const id of ['TC_LOGIN_001', 'TC_LOGIN_005', 'TC_LOGIN_006', 'TC_LOGIN_007', 'TC_LOGIN_008', 'TC_LOGIN_009']) {
    it(`${id} runs and passes with no question`, () => {
      assert.equal(of(id)?.status, 'PASS', detail(id));
    });
  }
  for (const id of ['TC_LOGIN_002', 'TC_LOGIN_003', 'TC_LOGIN_004']) {
    it(`${id} runs and passes with no question`, () => {
      assert.equal(of(id)?.status, 'PASS', detail(id));
    });
  }

  // Phase R2: the message the tester left open is the one the application showed, and the report says so (D31).
  it('learns the error text from the application and says so', () => {
    const wrong = of('TC_LOGIN_002');
    assert.ok(
      wrong.assumptions?.some((a) => /Invalid credentials.*learned/.test(a)),
      detail('TC_LOGIN_002'),
    );
    assert.match(wrong.actual, /Assumed or learned/);
    assert.match(wrong.checks.find((c) => c.id === 'A2')?.actual ?? '', /Invalid credentials/);
    // A browser alert is a message too (the blank field).
    assert.ok(
      of('TC_LOGIN_005').assumptions?.some((a) => /User Name not given!/.test(a)),
      detail('TC_LOGIN_005'),
    );
  });

  // Phase R3: a check nothing can verify does not stop the test (D30).
  it('TC_LOGIN_010 runs and is NOT VERIFIED, with what the page showed', () => {
    const v = of('TC_LOGIN_010');
    assert.equal(v?.status, 'NOT VERIFIED', detail('TC_LOGIN_010'));
    assert.deepEqual(
      v.checks.filter((c) => c.result === 'not verified').map((c) => c.id),
      ['A1'],
    );
    assert.match(v.checks[0].actual, /Not verified\. The page showed .*Invalid credentials/);
    assert.ok(
      v.steps.every((s) => s.result === 'passed'),
      'every step ran',
    );
    assert.match(v.review?.[0]?.todo.join(' ') ?? '', /Save what was seen/);
  });

  it('all ten cases ran: nine passed and one is not verified, with no question', () => {
    assert.deepEqual(verdicts.map((v) => v.status).sort(), ['NOT VERIFIED', ...Array(9).fill('PASS')]);
  });

  it('asked nothing for the cases that can run', () => {
    assert.deepEqual(
      asked.filter((q) => !/S3|A1/.test(q) || true),
      asked,
    );
    assert.deepEqual(asked, [], asked.join(' | '));
  });
});

describe('the Strict policy asks first (D30)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  it('stops the cases that need a made-up value, a learned message or an unverifiable check', async () => {
    const app = await startDemoApp();
    const base = path.join(root, '.auto-qa', 'test-realworld-strict');
    await rm(base, { recursive: true, force: true });
    try {
      const run = await runCases(
        ['TC_LOGIN_001', 'TC_LOGIN_002', 'TC_LOGIN_010'].map((id) => parseTestCase(cases.find((c) => c.id === id)!, config)),
        {
          config,
          baseUrl: `${app.url}/legacy`,
          env: { TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: DEMO_USER.password },
          resolver: unattended,
          policy: 'strict',
          exploreDir: path.join(base, 'explore'),
          runsDir: path.join(base, 'runs'),
          workspace: path.join(base, 'workspace'),
        },
      );
      const by = (id: string) => run.verdicts.find((v) => v.testId === id)!;
      assert.equal(by('TC_LOGIN_001').status, 'PASS');
      assert.equal(by('TC_LOGIN_002').status, 'NEEDS REVIEW');
      assert.match(by('TC_LOGIN_002').reason, /needs a value|Strict/);
      assert.equal(by('TC_LOGIN_010').status, 'NEEDS REVIEW');
    } finally {
      await app.close();
    }
  });
});
