import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import type { RawTestCase } from '../../model/test-model.js';
import { type ExecutionSession, executePlan, openExecutionSession, type RunTrace } from '../execute/index.js';
import { planActions } from '../execute/planner.js';
import { compileCase } from '../pipeline/compile.js';
import { buildCards, decide, judge, LearningBook, renderVerdict, type Verdict } from './index.js';

/** The verdict engine on real runs of the demo app: what the page really shows decides, and a stale message does not count. */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

describe('verdicts on real runs of the demo app', { skip }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let session: ExecutionSession;
  const shots = mkdtempSync(path.join(tmpdir(), 'aq-shots-'));
  before(async () => {
    app = await startDemoApp();
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  async function run(
    steps: string[],
    expected: string,
    extra: Partial<RawTestCase> = {},
    learning?: LearningBook,
  ): Promise<{ verdict: Verdict; trace: RunTrace }> {
    const raw: RawTestCase = { id: 'T-E08', title: 'A run', steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), expected, ...extra };
    const compile = await compileCase(raw, { env: {} });
    assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
      { mcp: session.port, page: session.page, baseUrl: app.url, screenshotDir: shots },
    );
    return { verdict: judge({ compile, trace, ...(learning ? { learning } : {}) }), trace };
  }
  const login = (user: string): string[] => [
    `Open ${app.url}/`,
    `Enter '${user}' in the Username field`,
    'Enter password in the Password field',
    "Click the 'Login' button",
  ];
  const good = { testData: 'Password: demo123' };
  const bad = { testData: 'Password: nope' };

  it('PASS: a good login shows the Dashboard heading', async () => {
    const { verdict } = await run(login('demo'), 'The Dashboard heading is displayed', good);
    assert.equal(verdict.verdict, 'PASS', renderVerdict(verdict));
  });
  it('PASS: a wrong password shows the error that this click produced', async () => {
    const { verdict } = await run(login('demo'), 'Error message "Invalid username or password" is displayed', bad);
    assert.equal(verdict.verdict, 'PASS', renderVerdict(verdict));
    assert.equal(verdict.evaluations[0]?.fresh, true);
  });
  it('FAIL: a wrong password does not show the Dashboard', async () => {
    const { verdict } = await run(login('demo'), 'The Dashboard heading is displayed', bad);
    assert.equal(verdict.verdict, 'FAIL', renderVerdict(verdict));
    assert.equal(verdict.rootCause, 'APPLICATION');
  });
  it('NEEDS_REVIEW: the error was there before the second click, so it proves nothing; the card has both pictures, and a click is learned', async () => {
    const steps = [...login('demo'), "Click the 'Login' button"];
    const expected = 'Error message "Invalid username or password" is displayed';
    const { verdict, trace } = await run(steps, expected, bad);
    assert.equal(verdict.verdict, 'NEEDS_REVIEW', renderVerdict(verdict));
    assert.equal(verdict.evaluations[0]?.doubt, 'STALE');
    const [card] = buildCards([{ verdict, trace }]);
    assert.ok(card?.evidence.before && existsSync(card.evidence.before) && card.evidence.after && existsSync(card.evidence.after), 'both pictures exist');
    const book = new LearningBook();
    const [decided] = decide(card as NonNullable<typeof card>, [verdict], { decision: 'PASS', who: 'asha' }, book);
    assert.equal(decided?.verdict, 'PASS');
    const again = await run(steps, expected, bad, book);
    assert.equal(again.verdict.verdict, 'PASS', renderVerdict(again.verdict));
    assert.equal(again.verdict.decidedByUser?.remembered, true);
  });
});
