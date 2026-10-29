import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunTrace, StepRecord } from '../execute/executor.js';
import type { Observation } from '../execute/observe.js';
import { planActions } from '../execute/planner.js';
import { compileCase } from '../pipeline/compile.js';
import { judge, type Verdict } from './index.js';

/**
 * E0.12, found on the real OrangeHRM: two things the judge read wrongly. (1) The application answers a blank field with a native alert,
 * which the page does not show, so "a validation message is displayed" was judged on a page with no message and failed. (2) The sheet
 * says "redirected to the OrangeHRM home/dashboard page", a name that is not an address, and the check failed a login that had worked.
 * What a pop-up says is a message the user was shown; a page name the engine cannot place is not a reason to call the address wrong.
 */

const page = (p: Partial<Observation> = {}): Observation => ({
  url: 'http://app/login.php',
  title: 'Login',
  lines: [],
  elements: [],
  messages: [],
  fieldErrors: [],
  tabs: 1,
  ...p,
});

async function run(opts: {
  steps: string[];
  expected: string;
  /** What the last step left, and what its pop-ups said. */
  after: Partial<Observation>;
  before?: Partial<Observation>;
  dialogs?: string[];
  pageRoutes?: Record<string, string>;
}): Promise<Verdict> {
  const compile = await compileCase(
    { id: 'T', title: 'T', steps: opts.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), expected: opts.expected },
    { env: {}, pageRoutes: opts.pageRoutes ?? {} },
  );
  assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
  // The run merges the project's learned page addresses into what the case names (withLearnedPages).
  compile.pages = { ...(opts.pageRoutes ?? {}), ...compile.pages };
  const chain = planActions(compile.ir, compile.plan).chains;
  const steps: StepRecord[] = chain.map((ch, i) => {
    const last = i === chain.length - 1;
    return {
      step: ch.step,
      action: ch.action,
      original: ch.original,
      status: 'done',
      calls: [],
      changes: [],
      dialogs: last ? (opts.dialogs ?? []) : [],
      checksAfter: ch.checksAfter,
      notes: [],
      before: page(last ? opts.before : {}),
      after: page(last ? opts.after : {}),
    };
  });
  const trace: RunTrace = { testId: 'T', status: 'completed', capabilities: [], steps };
  return judge({ compile, trace });
}

describe('what a native pop-up said is a message the user was shown', () => {
  const alerted = { steps: ['Open the Login page', "Click the 'Login' button"], dialogs: ['alert "User Name not given!"'], after: {} };

  it('"a message with these words is shown" is proven by a pop-up that says them', async () => {
    const v = await run({ ...alerted, expected: 'Error message "User Name not given!" is displayed' });
    assert.equal(v.verdict, 'PASS', v.reason);
    assert.equal(v.evaluations[0]?.result, 'proven');
  });

  it('a pop-up is fresh by definition: it cannot be a message that was already on the page', async () => {
    const v = await run({ ...alerted, before: { messages: ['User Name not given!'] }, expected: 'Error message "User Name not given!" is displayed' });
    assert.equal(v.verdict, 'PASS', 'the same words were on the page before, but the pop-up came in this step');
  });

  it('a pop-up that says something else does not prove the words: the check is disproven, and the actual says what was shown', async () => {
    const v = await run({ ...alerted, expected: 'Error message "The username is required" is displayed' });
    assert.notEqual(v.verdict, 'PASS');
    assert.equal(v.evaluations[0]?.result, 'disproven');
    assert.ok(v.evaluations[0]?.actual.includes('User Name not given!'), v.evaluations[0]?.actual);
  });

  it('no pop-up and no message is still no message', async () => {
    const v = await run({ steps: alerted.steps, expected: 'Error message "User Name not given!" is displayed', after: {} });
    assert.equal(v.evaluations[0]?.result, 'disproven');
  });

  it('every kind of pop-up is read the way the session writes it, and a malformed one says nothing', async () => {
    for (const dialog of ['confirm "Delete this?"', 'prompt "Your name"']) {
      const v = await run({
        steps: alerted.steps,
        dialogs: [dialog],
        after: {},
        expected: `Error message "${dialog.slice(dialog.indexOf('"') + 1, -1)}" is displayed`,
      });
      assert.equal(v.verdict, 'PASS', dialog);
    }
    const none = await run({ steps: alerted.steps, dialogs: ['alert'], after: {}, expected: 'Error message "x" is displayed' });
    assert.notEqual(none.verdict, 'PASS');
  });
});

describe('a page name is not an address', () => {
  const steps = ['Open the OrangeHRM login page', "Click the 'Login' button"];
  const routes = { 'OrangeHRM login': '/app/login.php', 'OrangeHRM home': '/app/index.php' };

  it('"home/dashboard" is either page: each side is looked up, and the known address of one of them proves it', async () => {
    const v = await run({
      steps,
      pageRoutes: routes,
      after: { url: 'http://app/app/index.php' },
      expected: 'User is redirected to the OrangeHRM home/dashboard page',
    });
    const url = v.evaluations.find((e) => e.expected.includes('address'));
    assert.equal(url?.result, 'proven', JSON.stringify(v.evaluations));
  });

  it('a page the engine knows to be another one is disproven: the address is the login page, not the home page', async () => {
    const v = await run({
      steps,
      pageRoutes: routes,
      after: { url: 'http://app/app/login.php' },
      expected: 'User is redirected to the OrangeHRM home/dashboard page',
    });
    assert.equal(v.evaluations.find((e) => e.expected.includes('address'))?.result, 'disproven');
  });

  it('a name the engine cannot place, on an address it does not know, is unproven: never a FAIL it cannot back', async () => {
    const v = await run({ steps, pageRoutes: routes, after: { url: 'http://app/somewhere/else.php' }, expected: 'User is redirected to the Reports page' });
    const url = v.evaluations.find((e) => e.expected.includes('address'));
    assert.equal(url?.result, 'unproven', JSON.stringify(url));
    assert.equal(url?.doubt, 'UNRESOLVED');
    assert.notEqual(v.verdict, 'FAIL');
    assert.notEqual(v.verdict, 'PASS');
  });

  it('a name that is part of the address is still a match: "Dashboard" is /dashboard', async () => {
    const v = await run({
      steps: ['Open the Login page', "Click the 'Login' button"],
      after: { url: 'http://app/dashboard' },
      expected: 'User is redirected to the Dashboard page',
    });
    assert.equal(v.evaluations.find((e) => e.expected.includes('address'))?.result, 'proven');
  });

  it('"not redirected" to a page it cannot place is not proven either', async () => {
    const v = await run({ steps, pageRoutes: routes, after: { url: 'http://app/somewhere/else.php' }, expected: 'User is not redirected to the Reports page' });
    const url = v.evaluations.find((e) => e.expected.includes('address'));
    assert.equal(url?.result, 'unproven');
  });
});
