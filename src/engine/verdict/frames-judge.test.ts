import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunTrace, StepRecord } from '../execute/executor.js';
import type { Observation } from '../execute/observe.js';
import { planActions } from '../execute/planner.js';
import { isNavigationRace, pageIdentityOf, readSettled } from '../locate/index.js';
import { compileCase } from '../pipeline/compile.js';
import { judge, type Verdict } from './index.js';

/**
 * E0.13: the judge when the page is a shell around frames. A frame that could not be read hides what it holds, so a check that is
 * "not found" there is not decided; and the screen a person is on is the address of the frame, not of the shell.
 */

const page = (p: Partial<Observation> = {}): Observation => ({
  url: 'http://app/index.php',
  title: 'App',
  lines: [],
  elements: [],
  messages: [],
  fieldErrors: [],
  tabs: 1,
  ...p,
});

async function run(opts: { steps: string[]; expected: string; after?: Partial<Observation>; before?: Partial<Observation> }): Promise<Verdict> {
  const compile = await compileCase(
    { id: 'T', title: 'T', steps: opts.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), expected: opts.expected },
    { env: {}, pageRoutes: {} },
  );
  assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
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
      dialogs: [],
      checksAfter: ch.checksAfter,
      notes: [],
      before: page(last ? opts.before : {}),
      after: page(last ? opts.after : {}),
    };
  });
  const trace: RunTrace = { testId: 'T', status: 'completed', capabilities: [], steps };
  return judge({ compile, trace });
}

describe('a frame that could not be read hides what it holds', () => {
  const steps = ['Open the Login page', "Click the 'Login' button"];
  const expected = 'Error message "Invalid credentials" is displayed';

  it('with every frame read, a message that is not there is a disproven check', async () => {
    const v = await run({ steps, expected, after: {} });
    assert.equal(v.evaluations[0]?.result, 'disproven');
  });

  it('with a frame unread, the same absence is not decided: unproven, NOT_OBSERVABLE, never a FAIL', async () => {
    const v = await run({ steps, expected, after: { unreadFrames: ['/html/body/iframe[1]'] } });
    const e = v.evaluations[0];
    assert.equal(e?.result, 'unproven', JSON.stringify(e));
    assert.equal(e?.doubt, 'NOT_OBSERVABLE');
    assert.notEqual(v.verdict, 'FAIL');
    assert.notEqual(v.verdict, 'PASS');
  });

  it('what was found stays found: a message that is shown is proven even while another frame is unread', async () => {
    const v = await run({ steps, expected, after: { messages: ['Invalid credentials'], unreadFrames: ['/html/body/iframe[1]'] } });
    assert.equal(v.evaluations[0]?.result, 'proven', JSON.stringify(v.evaluations[0]));
  });
});

describe('the screen is the address of the frame', () => {
  const steps = ['Open the Login page', "Click the 'Login' button"];

  it('a shell that never changes address is on the Dashboard when its frame is', async () => {
    const v = await run({
      steps,
      expected: 'User is redirected to the Dashboard page',
      after: { url: 'http://app/index.php', contentUrl: 'http://app/dashboard.php' },
    });
    assert.equal(v.evaluations.find((e) => e.expected.includes('address'))?.result, 'proven', JSON.stringify(v.evaluations));
  });

  it('"address stays the same" is false when the shell stayed but the screen in it changed', async () => {
    const v = await run({
      steps,
      expected: 'User remains on the Login page',
      before: { contentUrl: 'http://app/login.php' },
      after: { contentUrl: 'http://app/dashboard.php' },
    });
    const e = v.evaluations.find((x) => x.expected.includes('address'));
    assert.equal(e?.result, 'disproven', JSON.stringify(v.evaluations));
  });

  it('"address stays the same" holds when neither the shell nor the screen changed, record ids aside', async () => {
    const v = await run({
      steps,
      expected: 'User remains on the Login page',
      before: { contentUrl: 'http://app/view.php?id=EMP0001' },
      after: { contentUrl: 'http://app/view.php?id=EMP0002' },
    });
    assert.equal(v.evaluations.find((x) => x.expected.includes('address'))?.result, 'proven', JSON.stringify(v.evaluations));
  });
});

describe('what identifies a screen', () => {
  it('is the path and the parameters that choose it; a record id or page number is not one', () => {
    assert.equal(pageIdentityOf('http://x/lib/index.php?uniqcode=PIM&menu_no=1&id=EMP0007'), '/lib/index.php?uniqcode=PIM');
    assert.equal(pageIdentityOf('http://x/a/list.php?page=2'), '/a/list.php');
    assert.equal(pageIdentityOf('http://x/a/list/'), '/a/list');
    assert.equal(pageIdentityOf('http://x/a/list.php?action=view'), '/a/list.php?action=view');
  });
});

describe('a frame read while the page is moving', () => {
  it('knows a navigation race from a closed page', () => {
    for (const m of [
      'Execution context was destroyed',
      'Frame was detached',
      'frame was detached',
      'Cannot find context with specified id',
      'Frame has been detached',
    ])
      assert.equal(isNavigationRace(new Error(m)), true, m);
    assert.equal(isNavigationRace(new Error('Target page, context or browser has been closed')), false);
    assert.equal(isNavigationRace(new Error('something else')), false);
  });

  const frame = (fails: number, message: string) => {
    let loads = 0;
    let reads = 0;
    return {
      loads: () => loads,
      reads: () => reads,
      frame: {
        waitForLoadState: async () => {
          loads++;
        },
      },
      read: async () => {
        reads++;
        if (reads <= fails) throw new Error(message);
        return 'text';
      },
    };
  };

  it('reads again once after the frame has loaded', async () => {
    const f = frame(1, 'Execution context was destroyed');
    const r = await readSettled(f.frame as never, f.read);
    assert.deepEqual(r, { ok: true, value: 'text' });
    assert.equal(f.loads(), 1);
    assert.equal(f.reads(), 2);
  });

  it('a read that still fails is reported, not hidden', async () => {
    const f = frame(5, 'Execution context was destroyed');
    const r = await readSettled(f.frame as never, f.read);
    assert.equal(r.ok, false);
    assert.equal(f.reads(), 2, 'one retry only');
  });
});
