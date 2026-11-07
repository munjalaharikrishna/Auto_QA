import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import type { StepRecord } from '../execute/executor.js';
import { type ExecutionSession, executePlan, openExecutionSession } from '../execute/index.js';
import type { Observation, ObservedElement } from '../execute/observe.js';
import { planActions } from '../execute/planner.js';
import type { IrExpectation } from '../ir/schema.js';
import { compileCase } from '../pipeline/compile.js';
import { evaluateExpectation } from './evaluate.js';
import { judge } from './index.js';

/**
 * E0.18 step 1: STATE checks the verdict engine judges. "PIM is the default page" is judged on the page the login left, by the menu
 * whose own links open the screen shown (OrangeHRM 2.5) or by an address that names the page. "Upload button should accept photo" is
 * judged on the file field. "User should updated the data" stays a person's (owner's gold, 4 Nov 2026). Browser test: demo app
 * /ui/controls (Photo field). AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const BASE = 'http://127.0.0.1/orangehrm-2.5.0.2';
const EMPLOYEE_LIST = `${BASE}/lib/controllers/CentralController.php?reqcode=EMP&VIEW=MAIN&sortField=0&sortOrder0=ASC`;
const MENUS = [
  { name: 'Admin', targets: [`${BASE}/index.php?menu_no_top=eim`, `${BASE}/index.php?uniqcode=GEN&menu_no_top=eim`] },
  {
    name: 'PIM',
    targets: [`${BASE}/index.php?menu_no_top=hr`, EMPLOYEE_LIST, `${BASE}/lib/controllers/CentralController.php?reqcode=EMP&capturemode=addmode`],
  },
];
const page = (over: Partial<Observation> = {}): Observation => ({
  url: `${BASE}/index.php`,
  contentUrl: `${BASE}/lib/controllers/CentralController.php?reqcode=EMP&VIEW=MAIN&sortField=0&sortOrder0=ASC&VIEW=MAIN`,
  title: 'OrangeHRM',
  lines: [],
  elements: [],
  messages: [],
  fieldErrors: [],
  tabs: 1,
  screen: 'emp-list',
  menus: MENUS,
  ...over,
});
const step = (id: string, action: string, name: string, at: Observation, original = `Click ${name}`): StepRecord =>
  ({
    step: id,
    action,
    original,
    status: 'done',
    calls: [],
    changes: [],
    dialogs: [],
    checksAfter: [],
    notes: [],
    before: at,
    after: at,
    located: {
      name,
      level: 'role',
      weight: 0.95,
      selector: 'x',
      contract: { id: 'c', page: 'p', semantic: name },
      tried: [],
      element: { tag: 'input', role: 'button' },
      ignored: [],
    },
  }) as StepRecord;
const state = (expect: string, target: IrExpectation['condition']['target'], negated = false): IrExpectation => ({
  id: 'E1',
  clause: 'the check',
  negated,
  condition: { type: 'STATE', ...(target ? { target } : {}), expect },
  afterStep: 'S4',
});
const judgeOn = (exp: IrExpectation, steps: StepRecord[], at = 'S4') =>
  evaluateExpectation(exp, { steps, stepOf: new Map([['E1', at]]), seen: steps.map((s) => s.after as Observation), clause: '' });

describe('E0.18: "PIM is the default page"', () => {
  const pim = state('DEFAULT_PAGE', { ontology: 'Page', name: 'PIM' });
  const loggedIn = [step('S4', 'CLICK', 'Login', page())];

  it('the screen after login is one the PIM menu opens: proven, and "Admin is the default page" is disproven', () => {
    const e = judgeOn(pim, loggedIn);
    assert.equal(e.result, 'proven', e.actual);
    assert.ok(e.actual.includes('PIM menu opens'), e.actual);
    assert.equal(judgeOn(state('DEFAULT_PAGE', { ontology: 'Page', name: 'Admin' }), loggedIn).result, 'disproven');
    assert.equal(judgeOn(state('DEFAULT_PAGE', { ontology: 'Page', name: 'PIM' }, true), loggedIn).result, 'disproven');
  });

  it('a page an address names (a modern app: /dashboard) is proven by the address', () => {
    const modern = [step('S4', 'CLICK', 'Sign in', page({ url: 'https://app.test/dashboard', contentUrl: undefined, menus: [] }))];
    assert.equal(judgeOn(state('DEFAULT_PAGE', { ontology: 'Page', name: 'Dashboard' }), modern).result, 'proven');
  });

  it('not on the page the login left: not decided, whatever the page shows', () => {
    const later = [step('S5', 'CLICK', 'Employee List', page())];
    const e = judgeOn(pim, later, 'S5');
    assert.equal(e.result, 'unproven');
    assert.equal(e.doubt, 'NOT_OBSERVABLE');
  });

  it('no menu called PIM and no address naming it: not decided, never a PASS', () => {
    const plain = [step('S4', 'CLICK', 'Login', page({ menus: [MENUS[0] as { name: string; targets: string[] }] }))];
    assert.equal(judgeOn(pim, plain).result, 'unproven');
  });
});

describe('E0.18: "Upload button should accept photo"', () => {
  const file = (value: string, name = 'Photo'): ObservedElement => ({
    identity: name,
    role: 'button',
    name,
    tag: 'input',
    type: 'file',
    value,
    disabled: false,
    invalid: false,
  });
  const accepts = state('UPLOADED', { ontology: 'Button', label: 'upload button' });
  const at = (value: string, screen = 'add') => page({ elements: [file(value)], screen });

  it('the file field holds a file: proven; empty on the screen of the upload: disproven', () => {
    assert.equal(judgeOn(accepts, [step('S4', 'UPLOAD', 'upload', at('C:\\fakepath\\photo.png'))]).result, 'proven');
    assert.equal(judgeOn(accepts, [step('S4', 'UPLOAD', 'upload', at(''))]).result, 'disproven');
  });

  it('empty after the page changed (a Save): not decided, it does not say the file was not kept', () => {
    const steps = [step('S3', 'UPLOAD', 'upload', at('C:\\fakepath\\photo.png')), step('S4', 'CLICK', 'Save', at('', 'details'))];
    const e = judgeOn(accepts, steps);
    assert.equal(e.result, 'unproven');
    assert.equal(e.doubt, 'NOT_OBSERVABLE');
  });

  it('two file fields and no name that tells them apart, or none: not decided', () => {
    const two = page({ elements: [file('x', 'Photo'), file('', 'Resume')] });
    assert.equal(judgeOn(accepts, [step('S4', 'UPLOAD', 'upload', two)]).doubt, 'AMBIGUOUS');
    assert.equal(judgeOn(accepts, [step('S4', 'UPLOAD', 'upload', page())]).doubt, 'NOT_OBSERVABLE');
  });

  it('"updated the data" stays a person\'s: it is not judged', () => {
    const e = judgeOn(state('UPDATED', { ontology: 'Element', name: 'data' }), [step('S4', 'CLICK', 'Save', page())]);
    assert.equal(e.result, 'unproven');
  });
});

describe('E0.18 on a real page: "upload a photo by clicking upload button"', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
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

  it('the one file field of the page is the upload button, and the check sees the file in it', async () => {
    const compile = await compileCase(
      {
        id: 'T-UPLOAD',
        title: 'upload',
        steps: `1. Open ${app.url}/ui/controls\n2. upload a photo by clicking upload button`,
        expected: 'Upload button should accept photo',
      },
      { env: {} },
    );
    assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
      { mcp: session.port, page: session.page, baseUrl: app.url },
    );
    await session.reset();
    assert.equal(trace.status, 'completed', JSON.stringify(trace.stoppedAt));
    assert.ok(trace.steps.at(-1)?.notes.some((n) => n.includes('the one file field on the page')));
    const v = judge({ compile, trace });
    assert.equal(v.verdict, 'PASS', v.reason);
  });
});
