import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import { defaultParserConfig } from '../../parser/config.js';
import { parseTestCase } from '../../parser/index.js';
import { toTestVerdict } from '../../pipeline/semantic-run.js';
import { ApplicationSchema } from '../knowledge/schema.js';
import { compileCase } from '../pipeline/compile.js';
import { judge } from '../verdict/index.js';
import { type ExecutionSession, executePlan, openExecutionSession } from './index.js';
import { planActions } from './planner.js';

/**
 * E0.17 item 3 exit test, on a real page: a form shows the same Save button above and below it (demo app /ui/alike). The first run uses
 * the first of the two and says so: NEEDS REVIEW, never PASS. A person's PASS keeps that button as what "Save" means on this screen (a
 * screen label, as a walkthrough pick is), and the next run uses it without asking. Needs Google Chrome and no internet.
 * AUTO_QA_SKIP_BROWSER=1 skips it.
 */

describe('E0.17 item 3: alike controls, reviewed once and then remembered', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
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

  const run = async (knowledge?: ReturnType<typeof ApplicationSchema.parse>) => {
    const compile = await compileCase(
      { id: 'T-ALIKE', title: 'Save the profile', steps: `1. Open ${app.url}/ui/alike\n2. Click Save`, expected: 'The text "Profile saved" is shown' },
      { env: {} },
    );
    assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
      { mcp: session.port, page: session.page, baseUrl: app.url, ...(knowledge ? { knowledge } : {}) },
    );
    await session.reset();
    return { trace, verdict: judge({ compile, trace }), compile };
  };

  it('the first run uses the first Save and waits for a person; once approved, the next run uses it and passes', async () => {
    const first = await run();
    assert.equal(first.trace.status, 'completed', JSON.stringify(first.trace.stoppedAt));
    const click = first.trace.steps.find((s) => s.action === 'CLICK');
    const assumed = click?.located?.assumed;
    assert.ok(assumed, 'the choice is recorded with the step');
    assert.equal(assumed.word, 'Save');
    assert.ok(assumed.why.includes('2 buttons'), assumed.why);
    assert.equal(first.verdict.verdict, 'NEEDS_REVIEW', first.verdict.reason);
    assert.ok(first.verdict.reason.includes('approves the choice'), first.verdict.reason);
    // E0.18 step 4: in the results it is NEEDS REVIEW, labelled chosen.
    const model = parseTestCase({ id: 'T-ALIKE', title: 'Save the profile', steps: '1. Open the page 2. Click Save', expected: 'x' }, defaultParserConfig());
    assert.equal(toTestVerdict(model, first.verdict, first.trace, first.compile).label, 'chosen');

    // What a PASS on the review card keeps (ReviewService → LearningService.saveLabel → learnedForRun → knowledgeFromRuns).
    const knowledge = ApplicationSchema.parse({
      name: 'demo',
      screens: [{ key: assumed.screen, words: [{ word: 'save', means: assumed.means, element: assumed.element }] }],
    });
    const second = await run(knowledge);
    const again = second.trace.steps.find((s) => s.action === 'CLICK');
    assert.equal(again?.located?.assumed, undefined, 'nothing is assumed: a person said which Save it is');
    assert.ok(
      again?.notes.some((n) => n.includes('a person said')),
      JSON.stringify(again?.notes),
    );
    assert.equal(second.verdict.verdict, 'PASS', second.verdict.reason);
  });
});
