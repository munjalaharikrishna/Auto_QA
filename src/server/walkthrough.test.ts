import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StepRecord } from '../engine/execute/executor.js';
import { observed } from '../engine/execute/observe.js';
import type { DomElement } from '../engine/locate/types.js';
import type { RawTestCase } from '../model/test-model.js';
import { addCheck, CHECK_KINDS, changesData, checkProblem, checkSentence, placeCheck, tryOnScreen, type WalkCheck } from './walkthrough.js';

/** E0.14b: the rules of the guided walkthrough, without a browser. */

const RAW: RawTestCase = {
  id: 'TC-ADD',
  title: 'Add an employee',
  steps: '1. Open http://hr.test/\n2. Click PIM\n3. Click the Add button\n4. Enter "Asha" in First Name',
  expected: 'The Save button is displayed',
};

const EACH: Record<(typeof CHECK_KINDS)[number], WalkCheck> = {
  visible: { kind: 'visible', target: { role: 'textbox', name: 'First Name' } },
  'not-visible': { kind: 'not-visible', target: { role: 'button', name: 'Delete' } },
  'text-contains': { kind: 'text-contains', target: { role: 'heading', name: 'PIM' }, expected: 'Add Employee' },
  value: { kind: 'value', target: { role: 'textbox', name: 'First Name' }, expected: 'Asha' },
  enabled: { kind: 'enabled', target: { role: 'button', name: 'Save' } },
  disabled: { kind: 'disabled', target: { role: 'button', name: 'Save' } },
  'url-contains': { kind: 'url-contains', expected: 'capturemode=addmode' },
};

describe('E0.14b: a check added in a walkthrough is read back as exactly that check', () => {
  for (const kind of CHECK_KINDS) {
    it(`${kind}: at the end, and after a step`, async () => {
      const atEnd = await addCheck(RAW, EACH[kind]);
      assert.ok(atEnd.ok, atEnd.ok ? '' : atEnd.why);
      assert.ok(atEnd.raw.expected?.endsWith(atEnd.sentence));
      const afterStep = await addCheck(RAW, { ...EACH[kind], afterStep: 'S3' });
      assert.ok(afterStep.ok, afterStep.ok ? '' : afterStep.why);
      assert.equal(afterStep.expectation.afterStep, 'S3', 'judged on the page step 3 left');
      assert.match(afterStep.raw.steps, new RegExp(`\\n4\\. Verify ${afterStep.sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
    });
  }
  it('offers only the checks the verdict engine judges, and text is "contains", never a promise of an exact match', () => {
    assert.deepEqual([...CHECK_KINDS], ['visible', 'not-visible', 'text-contains', 'value', 'enabled', 'disabled', 'url-contains']);
  });
  it('refuses a check it cannot write, and says why', async () => {
    assert.match(checkProblem({ kind: 'value', target: { role: 'textbox', name: 'First Name' } }) ?? '', /Say what it should show/);
    assert.match(checkProblem({ kind: 'visible' }) ?? '', /Pick the element/);
    assert.match(checkProblem({ kind: 'text-contains', target: { role: 'heading', name: 'A "B"' }, expected: 'x' }) ?? '', /double quote/);
    const refused = await addCheck(RAW, { kind: 'visible' });
    assert.equal(refused.ok, false);
  });
  it('refuses a sentence the engine reads as another check, instead of saving something that means something else', async () => {
    // A name that holds the words of a check: "is not displayed" turns the sentence around.
    const odd = await addCheck(RAW, { kind: 'visible', target: { role: 'button', name: 'Save is not' } });
    assert.equal(odd.ok, false);
  });
  it('a step that does not exist is refused', async () => {
    const r = await addCheck(RAW, { ...EACH.visible, afterStep: 'S9' });
    assert.equal(r.ok, false);
  });
});

describe('E0.14b: placing a check', () => {
  it('puts it after the step as a Verify step, numbers the steps again, and keeps every other field', () => {
    const r = placeCheck({ ...RAW, testData: 'First Name: Asha' }, 'The Save button is displayed', 'S2');
    assert.equal(
      r.steps,
      '1. Open http://hr.test/\n2. Click PIM\n3. Verify The Save button is displayed\n4. Click the Add button\n5. Enter "Asha" in First Name',
    );
    assert.equal(r.testData, 'First Name: Asha');
    assert.equal(r.expected, RAW.expected);
  });
  it('folds the per-step expected results in first, so S-numbers of the run are the lines of the steps', () => {
    const r = placeCheck({ ...RAW, stepExpected: { '2': 'The Add button is displayed' } }, 'X is displayed', 'S3');
    assert.equal(r.stepExpected, undefined);
    assert.deepEqual(r.steps.split('\n').slice(1, 4), ['2. Click PIM', '3. Verify The Add button is displayed', '4. Verify X is displayed']);
  });
  it('adds a check at the end as a new line of the expected result', () => {
    assert.equal(placeCheck(RAW, 'X is displayed').expected, 'The Save button is displayed\nX is displayed');
    assert.equal(placeCheck({ ...RAW, expected: '' }, 'X is displayed').expected, 'X is displayed');
  });
  it('writes sentences in the words the engine reads', () => {
    assert.equal(checkSentence(EACH.visible), 'The First Name field is displayed');
    assert.equal(checkSentence(EACH.value), 'The "First Name" field has the value "Asha"');
    assert.equal(checkSentence(EACH['url-contains']), 'The page URL contains "capturemode=addmode"');
  });
});

describe('E0.14b: steps that change data are asked about first', () => {
  const click = (name: string, original = `Click ${name}`) => ({ action: 'CLICK' as const, target: { ontology: 'Button', name }, original });
  it('a click on Save, Delete, Submit, OK or Yes changes data; on PIM, Add, Next or Back it does not', () => {
    for (const n of ['Save', 'Delete', 'Submit', 'OK', 'Yes', 'Update Record']) assert.equal(changesData(click(n)), true, n);
    for (const n of ['PIM', 'Add', 'Next', 'Back', 'Search']) assert.equal(changesData(click(n)), false, n);
  });
  it('submitting, deleting, uploading and pressing Enter change data; typing and opening a page do not', () => {
    assert.equal(changesData({ action: 'SUBMIT', original: 'Submit the form' }), true);
    assert.equal(changesData({ action: 'UPLOAD', original: 'Upload photo' }), true);
    assert.equal(changesData({ action: 'PRESS', value: 'Enter', original: 'Press Enter' }), true);
    assert.equal(changesData({ action: 'PRESS', value: 'Tab', original: 'Press Tab' }), false);
    assert.equal(changesData({ action: 'ENTER_VALUE', target: { ontology: 'Field', name: 'Save path' }, original: 'Enter x in Save path' }), false);
    assert.equal(changesData({ action: 'NAVIGATE', original: 'Open the page' }), false);
  });
});

describe('E0.14b: a check is tried on the screen the person sees', () => {
  const el = (over: Partial<DomElement>): DomElement => ({
    index: 0,
    tag: 'input',
    role: 'textbox',
    ariaName: '',
    labels: [],
    text: '',
    visible: true,
    disabled: false,
    readOnly: false,
    covered: false,
    box: { x: 0, y: 0, width: 10, height: 10 },
    focused: false,
    focusable: true,
    parents: [],
    nearbyText: '',
    xpath: '/x',
    inDialog: false,
    invalid: false,
    frame: [],
    ...over,
  });
  const record = (elements: DomElement[]): StepRecord => {
    const page = observed('http://hr.test/add', 'Add', ['PIM : Add Employee'], elements);
    return {
      step: 'S4',
      action: 'ENTER_VALUE',
      original: 'x',
      status: 'done',
      calls: [],
      changes: [],
      dialogs: [],
      checksAfter: [],
      notes: [],
      before: page,
      after: page,
    };
  };
  it('says the check holds when it does, and does not when it does not', async () => {
    const added = await addCheck(RAW, EACH.visible);
    assert.ok(added.ok);
    const shown = tryOnScreen(added.expectation, record([el({ labels: ['First Name'], xpath: '/f' })]));
    assert.equal(shown?.result, 'proven', shown?.why ?? 'not tried');
    const gone = tryOnScreen(added.expectation, record([el({ labels: ['Last Name'], xpath: '/l' })]));
    assert.notEqual(gone?.result, 'proven');
  });
});
