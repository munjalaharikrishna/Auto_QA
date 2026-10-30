import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { screenOf } from '../execute/capture.js';
import { observed } from '../execute/observe.js';
import { screenKeyOf } from '../locate/page-identity.js';
import type { DomElement } from '../locate/types.js';
import { diffScreens, elementIdentity, mergeScreens, type Screen, ScreenSchema } from './screens.js';

/** E0.14a: screen keys, element identity, merging captures, and what changed between two of them. */

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
  box: { x: 10, y: 20, width: 100, height: 20 },
  focused: false,
  focusable: true,
  parents: [],
  nearbyText: '',
  xpath: '/html/body/input[1]',
  inDialog: false,
  invalid: false,
  frame: [],
  ...over,
});

const screen = (key: string, elements: Array<Partial<Screen['elements'][number]> & { id: string; name: string }>): Screen =>
  ScreenSchema.parse({ key, elements: elements.map((e) => ({ role: 'textbox', ...e })) });

describe('E0.14a: the screen key', () => {
  it('is the address that chooses the screen: the content frame on a shell page, query parameters kept, record numbers left out', () => {
    const list = 'http://h/orangehrm/lib/controllers/CentralController.php?reqcode=EMP&VIEW=MAIN&sortField=0';
    const add = 'http://h/orangehrm/lib/controllers/CentralController.php?reqcode=EMP&capturemode=addmode';
    assert.notEqual(screenKeyOf(list), screenKeyOf(add), 'OrangeHRM 2.5 chooses its screens by query parameters');
    assert.equal(screenKeyOf(`${list}&id=17`), screenKeyOf(list), 'the employee that is open is a record, not a screen');
    assert.equal(screenKeyOf(add, 'Confirm'), `${screenKeyOf(add)} [dialog: Confirm]`, 'an open dialog is a screen of its own');
  });
  it('is on every observation, from the content frame when there is one', () => {
    const o = observed('http://h/index.php', 'Shell', [], [el({ labels: ['Code'], id: 'txtEmployeeId' })], 1, [], {
      contentUrl: 'http://h/c.php?reqcode=EMP&capturemode=addmode',
    });
    assert.equal(o.screen, '/c.php?capturemode=addmode&reqcode=EMP');
  });
});

describe('E0.14a: what an observation keeps for a screen model', () => {
  it('keeps label, placeholder, type, ids and frame, and draws a box inside a frame where it is on the whole page', () => {
    const inFrame = el({
      labels: ['First Name'],
      placeholder: 'Given name',
      type: 'text',
      id: 'txtEmpFirstName',
      nameAttr: 'txtEmpFirstName',
      frame: ['rightMenu'],
    });
    const o = observed('http://h/', 'T', [], [inFrame], 1, [], { offsets: { '': { x: 0, y: 0 }, rightMenu: { x: 200, y: 100 } } });
    const e = o.elements[0];
    assert.equal(e?.label, 'First Name');
    assert.equal(e?.placeholder, 'Given name');
    assert.equal(e?.type, 'text');
    assert.equal(e?.htmlId, 'txtEmpFirstName');
    assert.deepEqual(e?.frame, ['rightMenu']);
    assert.deepEqual(e?.box, { x: 210, y: 120, width: 100, height: 20 });
  });
  it('gives no box to an element in a frame whose place is not known, rather than a wrong one', () => {
    const o = observed('http://h/', 'T', [], [el({ labels: ['A'], frame: ['gone'] })]);
    assert.equal(o.elements[0]?.box, undefined);
  });
  it('lists the headings, the table headers and the open dialog', () => {
    const o = observed(
      'http://h/',
      'T',
      [],
      [el({ tag: 'h1', role: 'heading', text: 'Employee Information', xpath: '/h1' }), el({ tag: 'div', role: 'dialog', ariaName: 'Delete?', xpath: '/div' })],
      1,
      [],
      { tables: [['Id', 'Name']] },
    );
    assert.deepEqual(o.headings, ['Employee Information']);
    assert.deepEqual(o.tables, [['Id', 'Name']]);
    assert.equal(o.dialog, 'Delete?');
    assert.ok(o.screen?.endsWith('[dialog: Delete?]'));
  });
  it('a screen model never holds a value that was typed', () => {
    const o = observed(
      'http://h/',
      'T',
      [],
      [el({ labels: ['Password'], type: 'password', value: '••••' }), el({ labels: ['Name'], value: 'Asha', xpath: '/x' })],
    );
    const s = screenOf(o, 'TC-1');
    assert.ok(!JSON.stringify(s).includes('Asha'));
    assert.ok(!JSON.stringify(s).includes('••••'));
  });
  it('leaves out layout rows and pictures that have no name and nothing that identifies them', () => {
    const o = observed('http://h/', 'T', [], [el({ tag: 'tr', role: 'row', xpath: '/tr' }), el({ labels: ['Code'], xpath: '/i' })]);
    assert.deepEqual(
      screenOf(o, 'TC-1').elements.map((e) => e.name),
      ['Code'],
    );
  });
});

describe('E0.14a: element identity', () => {
  it('uses the test id, then a stable id, then the name of a form field: none of them changes with the label', () => {
    assert.equal(elementIdentity({ role: 'button', name: 'Save', testId: 'save' }), 'testid=save');
    assert.equal(elementIdentity({ role: 'textbox', name: 'Code', htmlId: 'txtEmployeeId' }), 'id=txtEmployeeId');
    assert.equal(
      elementIdentity({ role: 'textbox', name: 'Code', nameAttr: 'txtEmpId' }),
      elementIdentity({ role: 'textbox', name: 'Employee Id', nameAttr: 'txtEmpId' }),
    );
  });
  it('does not trust an id the page makes up for each load', () => {
    assert.notEqual(elementIdentity({ role: 'button', name: 'Save', htmlId: 'ember1234' }), 'id=ember1234');
    assert.notEqual(elementIdentity({ role: 'button', name: 'Save', htmlId: ':r3:' }), 'id=:r3:');
  });
  it('tells apart the options of one radio group, which share their name', () => {
    assert.notEqual(
      elementIdentity({ role: 'radio', name: 'Male', nameAttr: 'gender' }),
      elementIdentity({ role: 'radio', name: 'Female', nameAttr: 'gender' }),
    );
  });
  it('puts the frame in the identity: the same id in two frames is two elements', () => {
    assert.notEqual(
      elementIdentity({ role: 'button', name: 'Save', htmlId: 'save', frame: ['a'] }),
      elementIdentity({ role: 'button', name: 'Save', htmlId: 'save' }),
    );
  });
});

describe('E0.14a: merging captures and the diff', () => {
  it('merges a screen seen twice: elements of both, the newer name, the cases of both', () => {
    const a = { ...screen('/add', [{ id: 'id=code', name: 'Code' }]), cases: ['TC-1'] };
    const b = {
      ...screen('/add', [
        { id: 'id=code', name: 'Employee Id' },
        { id: 'id=first', name: 'First Name' },
      ]),
      cases: ['TC-2'],
    };
    const [m] = mergeScreens([a], [b]);
    assert.deepEqual(
      m?.elements.map((e) => e.name),
      ['Employee Id', 'First Name'],
    );
    assert.deepEqual(m?.cases, ['TC-1', 'TC-2']);
    assert.equal(a.elements[0]?.name, 'Code', 'the inputs are not changed');
  });
  it('keeps a screen a person showed as the person’s', () => {
    const shown = { ...screen('/add', [{ id: 'id=code', name: 'Code' }]), source: 'walkthrough' as const };
    assert.equal(mergeScreens([shown], [screen('/add', [])])[0]?.source, 'walkthrough');
  });
  it('a changed label is one rename, not a removal and an addition', () => {
    const before = [
      screen('/add', [
        { id: 'id=code', name: 'Code' },
        { id: 'id=first', name: 'First Name' },
      ]),
    ];
    const after = [
      screen('/add', [
        { id: 'id=code', name: 'Employee Id' },
        { id: 'id=first', name: 'First Name' },
      ]),
    ];
    assert.deepEqual(diffScreens(before, after), [{ screen: '/add', change: 'renamed', what: 'textbox "Code" → "Employee Id"' }]);
  });
  it('reports added and removed elements, a new screen once, and nothing about a screen the run did not reach', () => {
    const before = [screen('/add', [{ id: 'id=a', name: 'A' }]), screen('/other', [{ id: 'id=o', name: 'O' }])];
    const after = [
      screen('/add', [{ id: 'id=b', name: 'B' }]),
      screen('/new', [
        { id: 'id=n', name: 'N' },
        { id: 'id=m', name: 'M' },
      ]),
    ];
    assert.deepEqual(
      diffScreens(before, after).map((c) => `${c.screen} ${c.change} ${c.what}`),
      ['/add added textbox "B"', '/add removed textbox "A"', '/new screen added /new'],
    );
  });
});
