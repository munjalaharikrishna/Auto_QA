import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import type { RunTrace, StepRecord } from '../execute/executor.js';
import type { Observation } from '../execute/observe.js';
import { planActions } from '../execute/planner.js';
import { compileCase } from '../pipeline/compile.js';
import { judge } from '../verdict/index.js';
import { nearestTo } from './anchors.js';
import { identical } from './candidates.js';
import { type DomElement, inspectPage, locate } from './index.js';

/**
 * E0.17 item 3, the identical-element rule. Controls alike in role, name, handler, form and frame are one control shown more than once:
 * the first on the page is used, as an assumption that keeps the case from passing until a person approves it. Owner, 6 Nov 2026: the
 * one in the part of the page the case is working in comes first. The browser tests use test/dom/identical.html. AUTO_QA_SKIP_BROWSER=1
 * skips them.
 */

const el = (over: Partial<DomElement>): DomElement => ({
  index: 0,
  tag: 'input',
  type: 'button',
  role: 'button',
  ariaName: 'Save',
  labels: [],
  text: '',
  visible: true,
  disabled: false,
  readOnly: false,
  covered: false,
  box: { x: 0, y: 0, width: 40, height: 20 },
  focused: false,
  focusable: true,
  parents: [],
  nearbyText: '',
  xpath: '/a',
  inDialog: false,
  invalid: false,
  frame: [],
  handler: 'saveAll(); return false;',
  form: 'frmEmp',
  ...over,
});

describe('E0.17 item 3: which controls are alike', () => {
  it('the same role, name, handler, form and frame: alike, whatever their ids', () => {
    assert.equal(identical([el({ id: 'a', index: 1 }), el({ id: 'b', index: 2 })]), true);
  });

  it('another handler, form, frame, kind of input, test id or name: different controls', () => {
    const one = el({ id: 'a' });
    for (const other of [
      el({ handler: 'saveOther();' }),
      el({ form: 'frmOther' }),
      el({ frame: ['#content'] }),
      el({ type: 'submit' }),
      el({ testId: 'save-job' }),
      el({ nameAttr: 'btnSaveJob' }),
      el({ ariaName: 'Save and close' }),
    ])
      assert.equal(identical([one, other]), false, JSON.stringify(other));
  });

  it('inside named containers (two cards titled alike) they are records of their own, not one control (UI-07)', () => {
    assert.equal(identical([el({ containers: ['Backpack'] }), el({ containers: ['Backpack'] })]), false);
  });

  it('the locator uses the first of alike controls only to act, never to look at one', () => {
    const page = [el({ id: 'b', index: 2, xpath: '/b' }), el({ id: 'a', index: 1, xpath: '/a' })];
    const act = locate({ name: 'Save', ontology: 'Button' }, page);
    assert.equal(act.status, 'found');
    assert.equal(act.passAllowed, false);
    if (act.status === 'found' && !act.passAllowed) {
      assert.equal(act.element.id, 'a', 'the first on the page, by document order');
      assert.ok(act.ignored.some((i) => i.element.id === 'b' && i.reason.includes('alike')));
    }
    assert.equal(locate({ name: 'Save', ontology: 'Button', purpose: 'inspect' }, page).status, 'ambiguous');
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name: string): string => pathToFileURL(path.join(root, 'test', 'dom', name)).href;

describe('E0.17 item 3 on a page with two alike Save buttons', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let browser: Browser;
  let page: Page;
  let elements: DomElement[];
  before(async () => {
    browser = await chromium.launch({ channel: 'chrome' });
    page = await browser.newPage();
    await page.goto(fixture('identical.html'));
    elements = await inspectPage(page);
  });
  after(async () => {
    await browser?.close();
  });

  const alike = (): DomElement[] => {
    const r = locate({ name: 'Save', ontology: 'Button' }, elements);
    assert.ok(r.status === 'found' && !r.passAllowed, JSON.stringify(r.status));
    return r.status === 'found' && !r.passAllowed ? r.alike : [];
  };
  const at = (id: string): { frame: string[]; xpath: string } => {
    const e = elements.find((x) => x.id === id) as DomElement;
    return { frame: e.frame, xpath: e.xpath };
  };

  it('the handler is read from the page, and the hidden Save with another handler is not one of them', () => {
    const shown = alike();
    assert.deepEqual(
      shown.map((e) => e.id),
      ['save-1', 'save-2'],
    );
    assert.equal(shown[0]?.handler, 'saveAll(); return false;');
  });

  it('after typing in Phone, the Save of the Phone part is the one the case is working in', async () => {
    assert.equal((await nearestTo(page, at('txt-phone'), alike()))?.id, 'save-2');
    assert.equal((await nearestTo(page, at('txt-name'), alike()))?.id, 'save-1');
  });

  it('after a step outside both parts, neither is nearer: the first is used, as an assumption', async () => {
    assert.equal(await nearestTo(page, at('menu-job'), alike()), undefined);
  });
});

describe('E0.17 item 3: a run that used the first of alike controls is not a PASS or a FAIL', () => {
  const obs = (lines: string[]): Observation => ({ url: 'http://app/emp', title: 'Employee', lines, elements: [], messages: lines, fieldErrors: [], tabs: 1 });
  const run = async (shown: string[], assumed: boolean) => {
    const compile = await compileCase(
      { id: 'T-ALIKE', title: 'alike', steps: '1. Open the Employee page\n2. Click Save', expected: 'The text "Saved" is shown' },
      { env: {} },
    );
    assert.ok(compile.ir && compile.plan);
    const steps: StepRecord[] = planActions(compile.ir, compile.plan).chains.map((ch) => ({
      step: ch.step,
      action: ch.action,
      original: ch.original,
      status: 'done',
      calls: [],
      changes: [],
      dialogs: [],
      checksAfter: ch.checksAfter,
      notes: [],
      before: obs([]),
      after: obs(shown),
      ...(assumed && ch.action === 'CLICK'
        ? {
            located: {
              name: 'Save',
              level: 'role' as const,
              weight: 0.95,
              selector: 'xpath=//*[@id="save-1"]',
              contract: { id: 'c', page: '/emp', semantic: 'Save' },
              tried: [],
              element: { tag: 'input', role: 'button' },
              ignored: [],
              assumed: {
                why: '2 buttons called "Save" are alike: the first on the page was used',
                word: 'Save',
                means: 'Save',
                screen: '/emp',
                element: '|/a',
              },
            },
          }
        : {}),
    }));
    const trace: RunTrace = { testId: 'T-ALIKE', status: 'completed', capabilities: [], steps };
    return judge({ compile, trace });
  };

  it('every check proven, but the control was chosen: NEEDS REVIEW, with the choice as the reason', async () => {
    const v = await run(['Saved'], true);
    assert.equal(v.verdict, 'NEEDS_REVIEW');
    assert.ok(v.reason.includes('alike') && v.reason.includes('approves'), v.reason);
    assert.equal((await run(['Saved'], false)).verdict, 'PASS');
  });

  it('a check that fails after the choice may be the choice: NEEDS REVIEW, not FAIL', async () => {
    const v = await run(['Could not store the record'], true);
    assert.equal(v.verdict, 'NEEDS_REVIEW');
    assert.ok(v.reason.includes('whether that was the right one'), v.reason);
    assert.equal((await run(['Could not store the record'], false)).verdict, 'FAIL');
  });
});
