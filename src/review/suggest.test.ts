import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Screen } from '../engine/knowledge/screens.js';
import type { Status, TestVerdict } from '../results/verdict.js';
import { suggestionsFor, templateOf } from './suggest.js';

/**
 * E0.19 step 4, one-click rewrite: a card that asks what a sentence means offers sentences that run, built only from names the screens
 * showed, each read by the engine before it is offered; when none fits, the engine's own pattern is given to fill in.
 */

const el = (role: string, name: string, frame: string[] = []) => ({ id: `${role}:${name}`, role, name, frame, inside: [] });
const menu = [el('link', 'Admin'), el('link', 'PIM'), el('link', 'Logout')];
const screen = (key: string, title: string, elements: ReturnType<typeof el>[], headings: string[] = []): Screen =>
  ({ key, title, headings, tables: [], elements, source: 'run', cases: [], words: [] }) as Screen;

const login = screen('/login.php', 'OrangeHRM', [el('textbox', 'Login Name'), el('button', 'Login'), el('button', 'Clear')]);
const list = screen(
  '/emp-list',
  'Employee Information',
  [
    ...menu,
    el('heading', 'Employee Information', ['f']),
    el('button', 'Add', ['f']),
    el('button', 'Delete', ['f']),
    el('link', 'Anita Kumari Rao', ['f']),
    el('link', 'Sort in ascending order', ['f']),
  ],
  ['Employee Information'],
);
const add = screen('/emp-add', 'PIM : Add Employee', [...menu, el('textbox', 'Last Name', ['f']), el('button', 'Save', ['f'])], ['PIM : Add Employee']);
const byCase = new Map<string, Screen[]>([
  ['TC04', [login, list, add]],
  ['TC05', [login, list]],
]);

const verdict = (raw: string, todo: string[] = []): TestVerdict =>
  ({
    executionId: 'E',
    testId: 'T',
    title: 'T',
    automationId: 'T',
    status: 'NEEDS REVIEW' as Status,
    reason: '',
    review: [{ id: 'step 1', raw, headline: '', why: '', todo }],
    expected: '',
    actual: '',
    steps: [],
    checks: [],
    durationMs: 1,
    evidence: { screenshots: [] },
  }) as TestVerdict;

describe('one-click rewrite (E0.19 step 4)', () => {
  it('a step that names no item offers the items listed on the screens about it, never the menu', async () => {
    const s = await suggestionsFor(
      { sentence: 'Click on Employee Name', kind: 'step', why: '"Employee Name" names no employee' },
      verdict('Click on Employee Name'),
      [],
      byCase,
    );
    assert.deepEqual(
      s.ready.map((r) => r.text),
      ['Click "Anita Kumari Rao"'],
    );
  });

  it('a check that names a button and the part it is in becomes a check the engine reads, with the names as the screens show them', async () => {
    const s = await suggestionsFor(
      { sentence: 'User should add  button in employee information section', kind: 'check', why: 'no check could be read' },
      verdict('User should add  button in employee information section'),
      [],
      byCase,
    );
    assert.equal(s.ready[0]?.text, 'The "Add" button is shown in the "Employee Information" section');
    assert.ok(s.ready.every((r) => !r.text.includes('Admin')));
  });

  it('"Broswer should be Opened" (a typo) is what the first screen of the cases shows', async () => {
    const s = await suggestionsFor(
      { sentence: 'Verify Broswer should be Opened', kind: 'step', why: 'no check could be read' },
      verdict('Verify Broswer should be Opened'),
      [],
      byCase,
    );
    assert.deepEqual(
      s.ready.map((r) => r.text),
      ['The "Login" button is shown'],
    );
  });

  it('a sentence that names nothing on any screen offers nothing ready, only the engine’s pattern', async () => {
    const v = verdict('The system handles the whitespace', [
      'Say what should be true on the screen, for example: Verify the <name> <button, field, message> is displayed.',
    ]);
    const s = await suggestionsFor({ sentence: 'The system handles the whitespace', kind: 'check', why: 'fits none of the grammar models' }, v, [], byCase);
    assert.deepEqual(s.ready, []);
    assert.equal(s.template, 'Verify the <name> <button, field, message> is displayed');
  });

  it('the pattern is cut from the engine’s advice, and a cut that leaves a quote open is not offered', () => {
    assert.equal(
      templateOf(verdict('x', ['Name the employee: Click on "<the name>" in the list, or give it in Test Data.'])),
      'Click on "<the name>" in the list',
    );
    assert.equal(
      templateOf(verdict('x', ['Say which result is expected, for example: "If spaces are not accepted, <result A>; otherwise <result B>"'])),
      undefined,
    );
    assert.equal(templateOf(verdict('x', ['Decide PASS or FAIL on the review card.'])), undefined);
  });
});
