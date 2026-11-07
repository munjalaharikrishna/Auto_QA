import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { type ExecutionSession, executePlan, openExecutionSession } from '../engine/execute/index.js';
import { planActions } from '../engine/execute/planner.js';
import { compileCase } from '../engine/pipeline/compile.js';
import type { TestVerdict } from '../results/verdict.js';
import { unconfirmedPasses } from './run-cases.js';
import { runSemanticJobs } from './semantic-run.js';

/**
 * E0.18 step 3, the shadow gap. A legacy PASS the new engine cannot confirm becomes NEEDS REVIEW with the reason (owner, 7 Nov 2026);
 * a case the new engine runs may take at most a set time, so a step that waits for ever does not hold up a batch; and "Open the Login
 * page" with no address known opens the application's own address. Browser tests: demo app. AUTO_QA_SKIP_BROWSER=1 skips them.
 */

const verdict = (testId: string, status: TestVerdict['status']): TestVerdict => ({
  executionId: 'EXEC-1',
  testId,
  title: testId,
  automationId: testId,
  status,
  reason: 'all checks passed',
  expected: 'x',
  actual: 'x',
  steps: [],
  checks: [],
  durationMs: 1,
  evidence: { screenshots: [] },
});

describe('E0.18 step 3: a legacy PASS the new engine cannot confirm', () => {
  it('becomes NEEDS REVIEW with why; a FAIL, a stop and a confirmed case stay as they were', () => {
    const ran = new Map<string, TestVerdict>([
      ['TC1', verdict('TC1', 'PASS')],
      ['TC2', verdict('TC2', 'FAIL')],
      ['TC3', verdict('TC3', 'PASS')],
    ]);
    unconfirmedPasses(
      ran,
      new Map([
        ['TC1', 'E2 is a COUNT check, which the verdict engine does not judge yet'],
        ['TC2', 'the new engine did not read this test case'],
      ]),
    );
    assert.equal(ran.get('TC1')?.status, 'NEEDS REVIEW');
    assert.ok(ran.get('TC1')?.reason.includes('COUNT check'), String(ran.get('TC1')?.reason));
    assert.ok(ran.get('TC1')?.review?.some((r) => r.headline.includes('could not confirm')));
    assert.equal(ran.get('TC2')?.status, 'FAIL');
    assert.equal(ran.get('TC3')?.status, 'PASS', 'not listed: the shadow run confirms it, as before');
  });
});

describe('E0.18 step 3 on a real page', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let session: ExecutionSession;
  before(async () => {
    app = await startDemoApp();
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  it('a case that runs over its time keeps its review, and the batch goes on', async () => {
    const compiled = await compileCase(
      { id: 'T-SLOW', title: 'slow', steps: `1. Open ${app.url}/ui/controls`, expected: 'The Controls heading is displayed' },
      { env: {} },
    );
    const said: string[] = [];
    const out = await runSemanticJobs([{ model: { id: 'T-SLOW', title: 'slow', steps: [], assertions: [] } as never, compiled, baseUrl: app.url }], {
      caseTimeoutMs: 1,
      onProgress: (m) => said.push(m),
    });
    assert.equal(out.size, 0, 'no verdict: the case keeps the review it had');
    assert.ok(
      said.some((m) => m.includes('stopped it after')),
      said.join(' | '),
    );
  });

  it('"Open the Login page" with no address known opens the application, and says so', async () => {
    const compile = await compileCase(
      { id: 'T-LOGIN-PAGE', title: 'login page', steps: '1. Open the Login page', expected: 'The Login button is displayed' },
      { env: {} },
    );
    assert.ok(compile.ir && compile.plan);
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: {} },
      { mcp: session.port, page: session.page, baseUrl: app.url },
    );
    await session.reset();
    assert.equal(trace.status, 'completed', JSON.stringify(trace.stoppedAt));
    assert.ok(trace.steps[0]?.notes.some((n) => n.includes("the application's own address was opened")));
  });

  it('another page with no address known is still a stop: only a login page is opened that way', async () => {
    const compile = await compileCase(
      { id: 'T-REPORTS', title: 'reports', steps: '1. Open the Reports page', expected: 'The Reports heading is displayed' },
      { env: {} },
    );
    assert.ok(compile.ir && compile.plan);
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: {} },
      { mcp: session.port, page: session.page, baseUrl: app.url },
    );
    await session.reset();
    assert.equal(trace.stoppedAt?.code, 'PAGE_UNKNOWN');
  });
});
