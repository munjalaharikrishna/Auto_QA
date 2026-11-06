import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import type { IrExpectation } from '../ir/schema.js';
import { type DomElement, inspectPage, locate } from '../locate/index.js';
import { compileCase } from '../pipeline/compile.js';
import { evaluateExpectation } from '../verdict/evaluate.js';
import { judge } from '../verdict/index.js';
import { type ExecutionSession, executePlan, openExecutionSession } from './index.js';
import type { Observation } from './observe.js';
import { planActions } from './planner.js';
import { cellsHold, findRow, rowHolds } from './tables.js';

/**
 * E0.17 item 4, row actions: "Check the checkbox in the row for Anita Kumari Rao". The row is found by the values it holds, also when a
 * name runs across cells next to each other; an unnamed control is the one of its kind in that row; several of that kind are a
 * question. Browser tests use the demo app (/ui/rows) and the captured OrangeHRM 2.5 employee list. AUTO_QA_SKIP_BROWSER=1 skips them.
 */

describe('E0.17 item 4: a value across cells next to each other', () => {
  it('a name kept in First, Middle and Last is in the row, in that order', () => {
    assert.equal(cellsHold(['', 'Anita', 'Kumari', 'Rao', 'Delete'], 'Anita Kumari Rao'), true);
    assert.equal(rowHolds({ cells: ['', 'Anita', 'Kumari', 'Rao'] }, ['anita kumari rao']), true);
  });

  it('empty cells between them are skipped; other text between them, or another order, is not the name', () => {
    assert.equal(cellsHold(['Anita', '', 'Rao'], 'Anita Rao'), true);
    assert.equal(cellsHold(['Anita', 'Kumari', 'Rao'], 'Anita Rao'), false);
    assert.equal(cellsHold(['Kumari', 'Anita', 'Rao'], 'Anita Kumari Rao'), false);
    assert.equal(cellsHold(['Anita', 'HR', 'Kumari', 'Rao'], 'Anita Kumari Rao'), false);
  });

  it('one word, or a name in one cell, is the single-cell rule as before', () => {
    assert.equal(cellsHold(['Anita', 'Rao'], 'Anita'), false);
    assert.equal(rowHolds({ cells: ['0001', 'Anita Kumari Rao'] }, ['anita kumari rao']), true);
  });
});

const box = (over: Partial<DomElement>): DomElement => ({
  index: 0,
  tag: 'input',
  type: 'checkbox',
  role: 'checkbox',
  ariaName: '',
  labels: [],
  text: '',
  visible: true,
  disabled: false,
  readOnly: false,
  covered: false,
  box: { x: 0, y: 0, width: 13, height: 13 },
  focused: false,
  focusable: true,
  parents: [],
  nearbyText: '',
  xpath: '/tr[1]/td[1]/input[1]',
  inDialog: false,
  invalid: false,
  frame: [],
  ...over,
});

describe('E0.17 item 4: a control the step names only by its kind', () => {
  const link = box({ tag: 'a', type: undefined, role: 'link', text: 'Anita Kumari Rao', xpath: '/tr[1]/td[3]/a[1]' });

  it('the only checkbox of the row is meant', () => {
    const r = locate({ name: '', ontology: 'Checkbox', onlyOfKind: true }, [box({}), link]);
    assert.equal(r.status, 'found');
    if (r.status === 'found') assert.equal(r.element.role, 'checkbox');
  });

  it('two checkboxes in the row: a question; none: not found', () => {
    assert.equal(locate({ name: '', ontology: 'Checkbox', onlyOfKind: true }, [box({}), box({ xpath: '/tr[1]/td[1]/input[2]' })]).status, 'ambiguous');
    assert.equal(locate({ name: '', ontology: 'Checkbox', onlyOfKind: true }, [link]).status, 'not-found');
  });

  it('without a row (onlyOfKind not set), a control with no name is not found: the page has too many', () => {
    assert.equal(locate({ name: '', ontology: 'Checkbox' }, [box({})]).status, 'not-found');
  });

  it('"Tick the box in the … row" is a checkbox, a text box is not', async () => {
    const r = await compileCase(
      { id: 'T-BOX', title: 'box', steps: '1. Open the People page\n2. Tick the box in the Anita Kumari Rao row', expected: 'The People page is shown' },
      {},
    );
    assert.deepEqual(r.ir?.steps[1]?.target, { ontology: 'Checkbox', label: 'box', row: ['anita kumari rao'] });
  });
});

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

describe('E0.17 item 4 exit test on real pages', { skip }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let session: ExecutionSession;
  let browser: Browser;
  before(async () => {
    app = await startDemoApp();
    session = await openExecutionSession();
    browser = await chromium.launch({ channel: 'chrome' });
  });
  after(async () => {
    await session?.close();
    await app?.close();
    await browser?.close();
  });

  const run = async (step: string, expected: string) => {
    const compile = await compileCase({ id: 'T-ROWS', title: 'Rows', steps: `1. Open ${app.url}/ui/rows\n2. ${step}`, expected }, { env: {} });
    assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
      { mcp: session.port, page: session.page, baseUrl: app.url },
    );
    await session.reset();
    return { trace, verdict: judge({ compile, trace }), seen: trace.steps.at(-1)?.after };
  };

  it('"Check the checkbox in the row for Anita Kumari Rao" ticks the box of that row, and only that one', async () => {
    const r = await run('Check the checkbox in the row for Anita Kumari Rao', 'The text "Picked: 1" is shown');
    assert.equal(r.trace.status, 'completed', JSON.stringify(r.trace.stoppedAt));
    assert.ok(r.seen?.lines.includes('Picked: 1'), JSON.stringify(r.seen?.lines.filter((l) => l.startsWith('Picked'))));
    assert.equal(r.verdict.verdict, 'PASS', r.verdict.reason);
  });

  it('a button named in the row is found there: Delete in the row for Anita Kumari Rao is the first row', async () => {
    const r = await run('Click Delete in the row for Anita Kumari Rao', 'The text "Deleted row 1" is shown');
    assert.equal(r.verdict.verdict, 'PASS', r.verdict.reason);
  });

  it('"Anita Rao" is in two rows (Anita, Rao; and Kumari, Anita, Rao): the row is not guessed', async () => {
    const r = await run('Click Delete in the row for Anita Rao', 'The text "Deleted row 2" is shown');
    assert.equal(r.trace.stoppedAt?.code, 'ROW_AMBIGUOUS', JSON.stringify(r.trace.stoppedAt));
  });

  it('a row with two checkboxes: the step stops and says so, nothing is ticked', async () => {
    const r = await run('Check the checkbox in the row for Ravi Shah', 'The text "Picked: 4" is shown');
    assert.equal(r.trace.status, 'blocked');
    assert.equal(r.trace.stoppedAt?.code, 'LOCATE_AMBIGUOUS');
  });

  it('the captured OrangeHRM 2.5 employee list: the checkbox in the row for Anita Kumari Rao is chkLocID[] of row 0001', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(root, 'test', 'dom', 'orangehrm-employee-list.html')).href);
    const row = await findRow(page, ['anita kumari rao'], { go: async () => {} });
    assert.equal(row.status, 'found');
    if (row.status !== 'found') return;
    assert.deepEqual(row.row.cells.slice(1, 3), ['0001', 'Anita Kumari Rao']);
    const inRow = (await inspectPage(page)).filter((e) => e.xpath.startsWith(`${row.row.xpath}/`));
    const r = locate({ name: '', ontology: 'Checkbox', onlyOfKind: true }, inRow);
    assert.equal(r.status, 'found');
    if (r.status === 'found') assert.equal(r.element.nameAttr, 'chkLocID[]');
    await page.close();
  });
});

describe('E0.17 item 4: "the checkbox in the row for … is checked" is judged on that row', () => {
  const page = (boxes: Array<{ row: string[]; checked: boolean; name?: string }>): Observation => ({
    url: 'http://app/people',
    title: 'People',
    lines: [],
    elements: boxes.map((b, i) => ({
      identity: `b${i}`,
      role: 'checkbox',
      name: b.name ?? '',
      tag: 'input',
      disabled: false,
      invalid: false,
      checked: b.checked,
      row: b.row,
    })),
    messages: [],
    fieldErrors: [],
    tabs: 1,
  });
  const judgeOn = async (expected: string, obs: Observation) => {
    const compile = await compileCase({ id: 'T-CHK', title: 'chk', steps: '1. Open the People page', expected }, { env: {} });
    assert.ok(compile.ir);
    const exp = compile.ir.expectations[0] as IrExpectation;
    const step = {
      step: 'S1',
      action: 'NAVIGATE',
      original: 'Open',
      status: 'done',
      calls: [],
      changes: [],
      dialogs: [],
      checksAfter: [exp.id],
      notes: [],
      before: obs,
      after: obs,
    };
    return evaluateExpectation(exp, { steps: [step as never], stepOf: new Map([[exp.id, 'S1']]), seen: [obs], clause: '' } as never);
  };
  const ROWS = [
    { row: ['', 'Anita', 'Kumari', 'Rao'], checked: true },
    { row: ['', 'Anita', '', 'Rao'], checked: false },
  ];

  it('the box of that row decides, not a box of another row', async () => {
    assert.equal((await judgeOn('The checkbox in the row for Anita Kumari Rao is checked', page(ROWS))).result, 'proven');
    assert.equal((await judgeOn('The checkbox in the row for Anita Kumari Rao is not checked', page(ROWS))).result, 'disproven');
    const other = [ROWS[0], { ...ROWS[1], checked: true }].map((r, i) => (i === 0 ? { ...r, checked: false } : r)) as typeof ROWS;
    assert.equal((await judgeOn('The checkbox in the row for Anita Kumari Rao is checked', page(other))).result, 'disproven');
  });

  it('no such row, or two boxes in it: not decided', async () => {
    assert.equal((await judgeOn('The checkbox in the row for Ravi Shah is checked', page(ROWS))).doubt, 'NOT_FOUND');
    const two = [...ROWS, { row: ['', 'Anita', 'Kumari', 'Rao'], checked: false }];
    assert.equal((await judgeOn('The checkbox in the row for Anita Kumari Rao is checked', page(two))).doubt, 'AMBIGUOUS');
  });
});
