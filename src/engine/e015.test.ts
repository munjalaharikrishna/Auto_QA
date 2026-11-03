import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunTrace, StepRecord } from './execute/executor.js';
import type { Observation } from './execute/observe.js';
import { planActions } from './execute/planner.js';
import { understandCase } from './language/index.js';
import { fixTyposIn } from './language/synonyms.js';
import { compileCase } from './pipeline/compile.js';
import { judge } from './verdict/index.js';

/**
 * E0.15: the reading fixes that do not depend on the owner's gold readings. Each test is a sentence from the real OrangeHRM Add
 * Employee workbook (test/fixtures/Add_Employee.xlsx) or the BookMarket one.
 */

const page = (p: Partial<Observation> = {}): Observation => ({
  url: 'http://app/pim',
  title: 'PIM',
  lines: [],
  elements: [],
  messages: [],
  fieldErrors: [],
  tabs: 1,
  ...p,
});
const SHOWN: Partial<Observation> = {
  lines: ['PIM', 'Employee Information', 'Add'],
  elements: [{ identity: 'add', role: 'button', name: 'Add', tag: 'button', disabled: false, invalid: false }],
};

/** Compiles the case, makes every step "done" on a page showing `after`, and judges it. */
async function runCase(expected: string) {
  const compile = await compileCase({ id: 'T-E015', title: 'E0.15', steps: '1. Open the PIM page', expected }, { env: {} });
  if (!compile.ir || !compile.plan) return { compile, verdict: undefined };
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
    before: page({ url: 'http://app/' }),
    after: page(SHOWN),
  }));
  const trace: RunTrace = { testId: 'T-E015', status: 'completed', capabilities: [], steps };
  return { compile, verdict: judge({ compile, trace }) };
}

describe('E0.15: an expected result nobody can read does not stop the case', () => {
  const UNREADABLE = 'User should add  button in employee information section';

  it('the case still compiles and runs; that one check goes to a person', async () => {
    const { compile } = await runCase(`The Add button is displayed\n${UNREADABLE}`);
    assert.ok(compile.ir && compile.plan, 'one unreadable check no longer blocks the whole case');
    const issue = compile.issues.find((i) => i.code === 'NOT_UNDERSTOOD');
    assert.equal(issue?.severity, 'review');
    assert.equal(compile.status, 'needs-review');
  });

  it('is never a PASS while that check is unread, even when every other check holds', async () => {
    const readable = await runCase('The Add button is displayed');
    assert.equal(readable.verdict?.verdict, 'PASS', readable.verdict?.reason ?? '');
    const { verdict } = await runCase(`The Add button is displayed\n${UNREADABLE}`);
    assert.equal(verdict?.verdict, 'NEEDS_REVIEW', verdict?.reason ?? '');
    assert.ok((verdict?.reason ?? '').includes('could not be read as a check'), verdict?.reason ?? '');
  });
});

/** The name of what each expected result of `expected` checks, with its type. */
const checksOf = (expected: string) =>
  (understandCase({ id: 'T-E015', title: 'E0.15', steps: '1. Open the PIM page', expected }).ir?.expectations ?? []).map(
    (e) => `${e.condition.type} ${e.condition.target?.name ?? ''}`,
  );

describe('E0.15: a page is named by its name, not by what kind of screen it is', () => {
  it('drops screen words after the name, alone or joined: page/popup, page or popup, section, screen', () => {
    assert.deepEqual(checksOf('User should navigate to Add Employee page/popup'), ['URL Add Employee']);
    assert.deepEqual(checksOf('User should navigate to the Add Employee page or popup'), ['URL Add Employee']);
    assert.deepEqual(checksOf('User should naviagte to Employment section'), ['URL Employment']);
    assert.deepEqual(checksOf('User is redirected to the Dashboard screen'), ['URL Dashboard']);
  });
  it('after a screen word, "of …" names the application, not the page', () => {
    assert.deepEqual(checksOf('User should navigate to login section of Oragne Hrm'), ['URL login']);
  });
  it("keeps a choice between two pages as written: which one is the tester's to say", () => {
    assert.deepEqual(checksOf('User should navigate to the Admin or PIM page'), ['URL Admin or PIM']);
  });
});

describe('E0.15: a known typo is not part of a name', () => {
  it('corrects it and keeps how the word was capitalised', () => {
    assert.equal(fixTyposIn('Employement Status'), 'Employment Status');
    assert.equal(fixTyposIn('respective fileds'), 'respective fields');
    assert.equal(fixTyposIn('EMPLOYEMENT'), 'EMPLOYMENT');
    assert.equal(fixTyposIn('Sub-Division'), 'Sub-Division');
  });
  it('a field named with a typo is the field', () => {
    const lang = understandCase({
      id: 'T-E015',
      title: 'E0.15',
      steps: '1. Select "Full-Time" in the Employement Status dropdown',
      expected: 'The Employement Status shows "Full-Time"',
    });
    assert.equal(lang.ir?.steps[0]?.target?.name, 'Employment Status');
  });
  it('a quoted name stays exactly as written', () => {
    const lang = understandCase({ id: 'T-E015', title: 'E0.15', steps: '1. Click the "Employement" tab', expected: 'The page shows "Saved"' });
    assert.equal(lang.ir?.steps[0]?.target?.name, 'Employement');
  });
});

describe('E0.15: one sentence, two checks', () => {
  it('"see tabs and PIM as a default page": the tabs are shown, and PIM is the page shown first', () => {
    const lang = understandCase({ id: 'T-E015', title: 'E0.15', steps: '1. Open the PIM page', expected: 'User Should see tabs and PIM as a default page' });
    const checks = (lang.ir?.expectations ?? []).map((e) => [e.condition.type, e.condition.target?.name ?? e.condition.target?.label, e.condition.expect]);
    assert.deepEqual(checks, [
      ['VISIBILITY', 'tabs', 'VISIBLE'],
      ['STATE', 'PIM', 'DEFAULT_PAGE'],
    ]);
    assert.ok(!lang.issues.some((i) => i.message.includes('as a default page')), 'the words are read, not set aside');
  });
  it('a list item that is only a kind of thing is kept: "tabs and PIM" names two things', () => {
    assert.deepEqual(checksOf('The tabs and the PIM link are displayed').length, 2);
  });
});

describe('E0.15: the parser defects of the audit (U6)', () => {
  it('"(masked)" right after a check is a second check on the same thing, not dropped', () => {
    assert.deepEqual(checksOf('The password is shown (masked)'), ['VISIBILITY password', 'MASKED password']);
  });
  it('words in brackets it cannot read are said to be unread, never dropped silently', () => {
    const lang = understandCase({ id: 'T-E015', title: 'E0.15', steps: '1. Open the login page', expected: 'The password is displayed (as dots)' });
    assert.ok(lang.issues.some((i) => i.severity === 'review' && i.message.includes('(as dots)')));
  });
  it('"The Job Title field shows "Engineer"" checks the field\'s value, not a message', () => {
    assert.deepEqual(checksOf('The Job Title field shows "Engineer"'), ['VALUE Job Title']);
    assert.deepEqual(checksOf('The Country dropdown shows "India"'), ['VALUE Country']);
    assert.deepEqual(checksOf('The page shows "Saved"'), ['TEXT ']);
  });
});

describe('E0.15: a check written as a step and again as its expected result is checked once', () => {
  const raw = (stepExpected: Record<string, string>, expected = 'The PIM heading is displayed') => ({
    id: 'T-E015-TWIN',
    title: 'twin',
    steps: '1. Open the Login page\n2. Checking the login section at middle of the page',
    stepExpected,
    expected,
  });
  const layout = (c: ReturnType<typeof understandCase>) => c.ir?.expectations.filter((e) => e.condition.type === 'LAYOUT') ?? [];

  it('keeps one layout check, under the words of the expected result', () => {
    const c = understandCase(raw({ '2': 'Login section should be middle of the page' }));
    assert.equal(layout(c).length, 1, JSON.stringify(layout(c)));
    assert.equal(layout(c)[0]?.clause, 'Verify Login section should be middle of the page');
    assert.ok(c.decisions.some((d) => d.message.includes('checked once')));
  });

  it('keeps the check of the step when no expected result says the same', () => {
    const c = understandCase(raw({ '2': 'The PIM heading is displayed' }));
    assert.equal(layout(c).length, 1);
    assert.equal(layout(c)[0]?.clause, 'Checking the login section at middle of the page');
  });

  it('keeps both when two expected results read the same: each is a sentence of the tester', () => {
    const c = understandCase(raw({ '2': 'Login section should be middle of the page' }, 'Login section should be middle of the page'));
    assert.equal(layout(c).length, 2);
  });
});
