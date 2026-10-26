import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { GRAMMAR_SENTENCES, POSITIONAL } from '../../../test/language/grammar-sentences.js';
import { writeResults } from '../../importer/results.js';
import { readWorkbook } from '../../importer/workbook.js';
import type { RawTestCase } from '../../model/test-model.js';
import { compileCase } from '../pipeline/compile.js';
import {
  ASSERTION_WORDS,
  actionsOf,
  allowsAction,
  CATEGORIES,
  type CaseLanguage,
  canonical,
  coverageOf,
  coverageText,
  headNounOf,
  type LineResult,
  ONTOLOGY,
  parseTestData,
  preflightOf,
  preflightReport,
  preflightText,
  refineField,
  SYNONYM_SETS,
  synonymVersions,
  understandCase,
  understandLine,
  VERBS,
  verbOf,
  wordingOf,
} from './index.js';

/** E0.4 exit tests: the language layers, from the controlled vocabulary to the pre-flight report. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name: string): string => path.join(root, 'test', 'fixtures', name);
const GOLDEN = path.join(root, 'test', 'language', 'grammar.golden.json');
const T6 = path.join(root, 'test', 'baseline', 'e04-t6.json');

const line = (sentence: string, mode: 'step' | 'expected' = 'step', data = ''): LineResult =>
  understandLine(sentence, { data: parseTestData(data), facts: new Map(), mode });

const raw = (over: Partial<RawTestCase> & { steps: string; expected: string }): RawTestCase => ({ id: 'T-1', title: 'A test case', ...over });

describe('VO-01: the controlled action vocabulary', () => {
  const SENTENCES: Record<string, [sentence: string, action: string]> = {
    click: ["Click the 'Save' button", 'CLICK'],
    enter: ["Enter 'abc' in the Email field", 'ENTER_VALUE'],
    type: ["Type 'abc' in the Email field", 'ENTER_VALUE'],
    fill: ["Fill the Email field with 'abc'", 'ENTER_VALUE'],
    select: ["Select 'India' from the Country dropdown", 'SELECT'],
    choose: ["Choose 'India' from the Country dropdown", 'SELECT'],
    upload: ['Upload a file by clicking the Upload button', 'UPLOAD'],
    download: ['Download the Report link', 'DOWNLOAD'],
    submit: ['Submit the form', 'SUBMIT'],
    login: ['Login with valid credentials', 'LOGIN'],
    logout: ['Logout', 'LOGOUT'],
    search: ["Search for 'laptop' in the Search field", 'SEARCH'],
    open: ['Open the Login page', 'NAVIGATE'],
    navigate: ['Navigate to the Dashboard page', 'NAVIGATE'],
    scroll: ['Scroll the page', 'SCROLL'],
    hover: ['Hover over the Profile menu', 'HOVER'],
    drag: ["Drag the 'Task' item", 'DRAG'],
    drop: ["Drop the 'Task' item", 'DROP'],
    press: ['Press Enter', 'PRESS'],
    check: ['Check the Remember me checkbox', 'CHECK'],
    uncheck: ['Uncheck the Remember me checkbox', 'UNCHECK'],
    clear: ['Clear the Search field', 'CLEAR'],
    remove: ["Remove the 'Draft' record", 'REMOVE'],
    delete: ["Delete the 'Draft' record", 'DELETE'],
    edit: ["Edit the 'Draft' record", 'EDIT'],
    save: ['Save the form', 'SAVE'],
    cancel: ['Cancel the form', 'CANCEL'],
    close: ['Close the dialog', 'CLOSE'],
    expand: ['Expand the Details section', 'EXPAND'],
    collapse: ['Collapse the Details section', 'COLLAPSE'],
    refresh: ['Refresh the page', 'REFRESH'],
  };

  it('is exactly the 31 verbs of the specification', () => {
    assert.deepEqual(
      VERBS.map((v) => v.verb),
      Object.keys(SENTENCES),
    );
    assert.equal(VERBS.length, 31);
  });
  it('gives every verb a meaning, an action type and its word forms', () => {
    for (const v of VERBS) {
      assert.ok(v.meaning.length > 8, v.verb);
      assert.ok(v.action, v.verb);
      assert.ok(v.forms.length >= 4, `${v.verb} lists base, third person, past and -ing`);
      for (const form of v.forms) assert.equal(verbOf(form)?.verb, v.verb, form);
    }
  });
  it('reads a sentence with every verb into the right action', () => {
    for (const v of VERBS) {
      const [sentence, action] = SENTENCES[v.verb] as [string, string];
      const r = line(sentence);
      assert.equal(r.steps[0]?.action, action, `${v.verb}: ${sentence} → ${JSON.stringify(r.issues)}`);
      assert.equal(v.action, action, v.verb);
    }
  });
  it('treats a verb outside the list as unsupported, with the word named (VD-05)', () => {
    for (const word of ['Complete the process', 'Do the needful', 'Proceed', 'Finish the task']) {
      const r = line(word);
      assert.equal(r.steps.length, 0, word);
      const issue = r.issues.find((i) => i.code === 'UNSUPPORTED');
      assert.ok(issue, word);
      assert.equal(issue.severity, 'blocking');
      assert.ok(issue.message.includes(`"${word.split(' ')[0]}"`), issue.message);
      assert.ok(issue.suggestion, 'a clearer wording is suggested');
    }
  });
});

describe('VO-02: the controlled assertion vocabulary', () => {
  const SENTENCES: Record<string, string> = {
    verify: 'Verify the Dashboard heading is displayed',
    validate: 'Validate the Dashboard heading is displayed',
    confirm: 'Confirm the Dashboard heading is displayed',
    ensure: 'Ensure the Dashboard heading is displayed',
    check: 'Check that the Dashboard heading is displayed',
    expect: 'Expect the Dashboard heading to be displayed',
    should: 'The Dashboard heading should be displayed',
    must: 'The Dashboard heading must be displayed',
    displays: 'The system displays the Dashboard heading',
    shows: 'The system shows the Dashboard heading',
    contains: "The Search field contains 'abc'",
    equals: "The Search field equals 'abc'",
    remains: 'The user remains on the Login page',
    redirects: 'The system redirects to the Dashboard page',
    rejects: 'The system rejects the email',
    accepts: "The Email field accepts 'a@b.com'",
  };
  it('is exactly the 16 words of the specification', () => {
    assert.deepEqual(
      ASSERTION_WORDS.map((a) => a.word),
      Object.keys(SENTENCES),
    );
    assert.equal(ASSERTION_WORDS.length, 16);
  });
  it('makes each word mark an expectation, and no step', () => {
    for (const [word, sentence] of Object.entries(SENTENCES)) {
      const r = line(sentence, 'expected');
      assert.ok(r.expectations.length >= 1, `${word}: ${sentence} → ${JSON.stringify(r.issues)}`);
      assert.equal(r.steps.length, 0, `${word} must not make a step`);
      assert.equal(r.issues.filter((i) => i.severity === 'blocking').length, 0, `${word}: ${JSON.stringify(r.issues)}`);
    }
  });
  it('lets the grammar decide "check": a box to tick, or something to verify', () => {
    assert.equal(line('Check the Remember me checkbox').steps[0]?.action, 'CHECK');
    assert.equal(line('Check that the Dashboard heading is displayed').expectations.length, 1);
    assert.equal(line('Check that the Dashboard heading is displayed').steps.length, 0);
  });
});

describe('SY-01, SY-02: the synonym engine', () => {
  it('has the ten categories, each its own versioned set', () => {
    assert.deepEqual([...CATEGORIES], ['Action', 'Assertion', 'Navigation', 'Authentication', 'Form', 'Error', 'Visibility', 'State', 'Data', 'Negation']);
    for (const c of CATEGORIES) {
      assert.equal(SYNONYM_SETS[c].category, c);
      assert.equal(SYNONYM_SETS[c].version.split('.').length, 3, `${c} has a version like 1.0.0`);
      assert.ok(SYNONYM_SETS[c].entries.length >= 1);
    }
    assert.deepEqual(Object.keys(synonymVersions()), [...CATEGORIES]);
  });
  it('maps explicitly: tap is click, press stays press', () => {
    assert.equal(canonical('Action', 'tap'), 'click');
    assert.equal(canonical('Action', 'press'), undefined, 'press is its own driver');
    assert.equal(canonical('Action', 'tick'), 'check');
    assert.equal(line('Tap the Login button').steps[0]?.action, 'CLICK');
  });
  it('lets a word mean different things in different categories', () => {
    assert.equal(canonical('Action', 'empty'), 'clear');
    assert.equal(canonical('State', 'empty'), 'empty');
    assert.equal(canonical('Data', 'empty'), 'blank');
    assert.equal(canonical('Action', 'cleared'), undefined);
    assert.equal(canonical('State', 'cleared'), 'empty');
  });
  it('"press Enter" is a key and "press the Login button" is a click, recorded as a decision (SY-01)', () => {
    const key = line('Press Enter');
    assert.equal(key.steps[0]?.action, 'PRESS');
    assert.deepEqual(key.steps[0]?.value, { kind: 'literal', value: 'Enter' });
    const button = line('Press the Login button');
    assert.equal(button.steps[0]?.action, 'CLICK');
    assert.equal(button.steps[0]?.target?.ontology, 'Button');
    assert.ok(button.steps[0]?.decisions.some((d) => d.includes('press')));
  });
  it("fixes known misspellings only to compare words, never in the tester's own names", () => {
    const r = line('User should naviagte to Personal Informaton page', 'expected');
    assert.equal(r.expectations[0]?.condition.type, 'URL');
    assert.equal(r.expectations[0]?.condition.target?.name, 'Personal Informaton', 'the name stays as written');
  });
});

describe('ON-01: the ontology', () => {
  const CORE = [
    'User',
    'Applicant',
    'Expert',
    'Admin',
    'Username',
    'Password',
    'Field',
    'Button',
    'Link',
    'Dropdown',
    'Checkbox',
    'RadioButton',
    'Table',
    'Row',
    'Column',
    'Modal',
    'Page',
    'Section',
    'Message',
    'Error',
    'Validation',
    'Dashboard',
    'URL',
    'File',
    'Record',
    'ApiResponseStatus',
  ];
  it('has the 26 core classes of the specification', () => {
    assert.deepEqual(
      ONTOLOGY.filter((c) => c.origin === 'core').map((c) => c.name),
      CORE,
    );
  });
  it('gives every class its allowed actions and assertions, inherited through its parent', () => {
    assert.ok(allowsAction('Button', 'CLICK'));
    assert.ok(!allowsAction('Button', 'ENTER_VALUE'));
    assert.ok(allowsAction('Password', 'ENTER_VALUE'), 'a Password is a Field');
    assert.deepEqual(actionsOf('Username'), actionsOf('Field'));
    assert.ok(allowsAction('Dashboard', 'NAVIGATE'), 'a Dashboard is a Page');
  });
  it('reads the class from the head noun and refines a field by its name', () => {
    assert.deepEqual(headNounOf(['login', 'name', 'text', 'box']), { cls: 'Field', length: 2 });
    assert.deepEqual(headNounOf(['add', 'button']), { cls: 'Button', length: 1 });
    assert.equal(refineField('Login Name'), 'Username');
    assert.equal(refineField('Password'), 'Password');
    assert.equal(refineField('Email'), 'Field');
  });
  it('stops an action the class does not allow before anything runs (VD-04)', async () => {
    for (const sentence of ["Enter 'abc' in the Login button", "Select 'x' from the Email field"]) {
      const r = line(sentence);
      const issue = r.issues.find((i) => i.code === 'PARADOX');
      assert.ok(issue, sentence);
      assert.equal(issue.severity, 'blocking');
    }
    const compiled = await compileCase(raw({ steps: "1. Open the Login page\n2. Enter 'abc' in the Login button", expected: 'The Login page is displayed' }));
    assert.equal(compiled.status, 'needs-review');
    assert.equal(compiled.stage, 'Validate', 'stopped before a plan was built');
  });
});

describe('GR-01 to GR-11: the grammar golden set', () => {
  const snapshot = () => {
    const t = (x?: { ontology: string; name?: string; label?: string; near?: string; within?: string }): string | undefined =>
      x ? `${x.ontology}${x.name ? `:${x.name}` : x.label ? `:<${x.label}>` : ''}${x.near ? `~${x.near}` : ''}${x.within ? `@${x.within}` : ''}` : undefined;
    const out: Record<string, unknown> = {};
    for (const [model, { mode, sentences }] of Object.entries(GRAMMAR_SENTENCES)) {
      out[model] = sentences.map((sentence) => {
        const r = line(sentence, mode);
        return {
          sentence,
          models: [...new Set(r.models)],
          steps: r.steps.map((s) => ({ action: s.action, target: t(s.target), value: s.value, guard: s.guard })),
          expectations: r.expectations.map((e) => ({
            negated: e.negated,
            type: e.condition.type,
            target: t(e.condition.target),
            expect: e.condition.expect,
            text: e.condition.text,
            region: e.condition.region,
            guard: e.guard,
          })),
          conditionals: r.conditionals.map((c) => ({
            keyword: c.conditional.keyword,
            negated: c.conditional.negated,
            type: c.conditional.condition.type,
            target: t(c.conditional.condition.target),
            expect: c.conditional.condition.expect,
            given: c.given,
          })),
          issues: r.issues.map((i) => `${i.code}/${i.severity}`),
        };
      });
    }
    return JSON.parse(JSON.stringify(out));
  };

  it('has at least ten sentences for each of GR-01 to GR-10, and ten for GR-11: 110 in all', () => {
    for (let n = 1; n <= 10; n++) assert.ok((GRAMMAR_SENTENCES[`GR-${String(n).padStart(2, '0')}`]?.sentences.length ?? 0) >= 10, `GR-${n}`);
    assert.ok(POSITIONAL.length >= 10);
    assert.ok(Object.values(GRAMMAR_SENTENCES).reduce((n, g) => n + g.sentences.length, POSITIONAL.length) >= 110);
  });
  it('reads every sentence with the model it is written for, and with no blocking issue', () => {
    for (const [model, { mode, sentences }] of Object.entries(GRAMMAR_SENTENCES)) {
      for (const s of sentences) {
        const r = line(s, mode);
        assert.ok(r.models.includes(model as never), `${model}: ${s} → ${[...new Set(r.models)].join(', ')}`);
        assert.deepEqual(
          r.issues.filter((i) => i.severity === 'blocking'),
          [],
          s,
        );
      }
    }
  });
  it('GR-11: reads the action, the target and the value by position', () => {
    for (const p of POSITIONAL) {
      const s = line(p.sentence).steps[0];
      assert.equal(s?.action, p.action, p.sentence);
      assert.equal(s?.target?.name, p.target, p.sentence);
      assert.deepEqual(s?.value, p.value === undefined ? undefined : { kind: 'literal', value: p.value }, p.sentence);
    }
    const spec = line('Enter cypress in username field').steps[0];
    assert.deepEqual(
      [spec?.action, spec?.target?.name, spec?.value && 'value' in spec.value ? spec.value.value : undefined],
      ['ENTER_VALUE', 'username', 'cypress'],
      'the example of GR-11',
    );
  });
  it('gives every sentence the approved QA-IR', () => {
    const now = snapshot();
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    assert.deepEqual(now, JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
  it('is deterministic: the same sentences give byte-identical output (GV-05)', () => {
    assert.equal(JSON.stringify(snapshot()), JSON.stringify(snapshot()));
  });
});

describe('CL-01, CL-02, NG-01, NG-02: clauses and negation', () => {
  const LOGIN_NOT_PERFORMED = [
    'Login is not performed and the system displays a validation message',
    'Login is not performed and a validation message is displayed',
    'Login is not performed, and the system displays a validation message',
    'The login is not performed and the system shows a validation message',
    'User should not log in and a validation message should be displayed',
    'User is not logged in and a validation message is displayed',
    'User cannot log in and a validation message should be displayed',
    'Login is rejected and a validation message is displayed',
    'Login does not succeed and a validation message is displayed',
    'User should not log in and an error message should be displayed',
  ];
  it('splits a compound phrase into clauses, each its own expectation with its own verdict', () => {
    for (const s of LOGIN_NOT_PERFORMED) {
      const r = line(s, 'expected');
      assert.equal(r.expectations.length, 2, s);
    }
  });
  it('"Login is not performed and the system displays a message": E1 is negated, E2 is not, in every variant (NG-02)', () => {
    for (const s of LOGIN_NOT_PERFORMED) {
      const [e1, e2] = line(s, 'expected').expectations;
      assert.equal(e1?.condition.type, 'AUTHENTICATION', s);
      assert.equal(e1?.negated, true, `${s}: the login must be denied`);
      assert.equal(e2?.condition.type, 'VISIBILITY', s);
      assert.equal(e2?.negated, false, `${s}: the message must be shown, the "not" must not reach it`);
    }
  });
  it('a negation in the second clause stays in the second clause', () => {
    const [e1, e2] = line('The user is logged in and no error message is displayed', 'expected').expectations;
    assert.equal(e1?.negated, false);
    assert.equal(e2?.negated, true);
    assert.equal(e2?.condition.type, 'VISIBILITY');
    const [a, b] = line('An error message is displayed and the user is not logged in', 'expected').expectations;
    assert.equal(a?.negated, false);
    assert.equal(b?.negated, true);
  });
  it('NG-01: each negation term turns its clause around', () => {
    for (const s of [
      'The Save button is not displayed',
      'No error message is displayed',
      'The Save button should not be displayed',
      'The Save button cannot be displayed',
      'The Save button is displayed never',
    ]) {
      assert.equal(line(s, 'expected').expectations[0]?.negated, true, s);
    }
    assert.equal(line('The Save button is displayed', 'expected').expectations[0]?.negated, false);
  });
  it('state words set the expectation of their own clause (hidden, disabled, rejected)', () => {
    assert.equal(line('The Save button is hidden', 'expected').expectations[0]?.condition.expect, 'HIDDEN');
    assert.equal(line('The Save button is disabled', 'expected').expectations[0]?.condition.expect, 'DISABLED');
    const rejected = line('Login is rejected', 'expected').expectations[0];
    assert.equal(rejected?.condition.type, 'AUTHENTICATION');
    assert.equal(rejected?.negated, true);
  });
  it('"visible or not" asks whether it is visible, it does not say it is not', () => {
    assert.equal(line('The Admin tab is visible or not', 'expected').expectations[0]?.negated, false);
  });
  it('keeps "and" inside a list: "Enter username and password", "Terms and Conditions"', () => {
    assert.equal(line('Enter username and password').steps.length, 2);
    assert.equal(line('Click Terms and Conditions').steps.length, 1);
    assert.equal(line("Click the 'Terms and Conditions' link").steps[0]?.target?.name, 'Terms and Conditions');
  });
});

describe('CD-01, CD-02: conditionals', () => {
  it('separates the condition from its expectation, and marks an unknown branch for review', () => {
    const r = line('It should display an appropriate error message if spaces are not accepted', 'expected');
    assert.equal(r.conditionals.length, 1);
    assert.equal(r.conditionals[0]?.given, 'UNKNOWN');
    assert.equal(r.expectations[0]?.guard, 0, 'the expectation is held by the condition');
    assert.ok(r.issues.some((i) => i.code === 'UNKNOWN_BRANCH' && i.severity === 'review'));
  });
  it('TC_LOGIN_010: the whitespace condition is separated, never chosen, and the vague sentence is flagged', async () => {
    const wb = await readWorkbook(fixture('OrangeHRM_Login_Test_Cases_Updated.xlsx'));
    const c = wb.cases.find((x) => x.raw.id === 'TC_LOGIN_010');
    const l = understandCase((c as { raw: RawTestCase }).raw);
    assert.equal(l.ir?.conditionals.length, 1);
    assert.equal(l.ir?.conditionals[0]?.given, 'UNKNOWN');
    assert.equal(l.ir?.expectations.filter((e) => e.guard === 'C1').length, 1, 'only the message depends on the condition');
    assert.ok(l.issues.some((i) => i.code === 'UNKNOWN_BRANCH'));
    assert.ok(
      l.issues.some((i) => i.code === 'NOT_UNDERSTOOD' && i.original.includes('whitespace')),
      'the vague sentence is reported, not guessed',
    );
    const compiled = await compileCase(c?.raw);
    assert.equal(compiled.status, 'needs-review');
  });
  it('chooses the branch from known facts: the test case says the password is invalid', async () => {
    const base = { steps: '1. Open the Login page\n2. Enter invalid password in the Password text box\n3. Click the Login button' };
    const yes = await compileCase(raw({ ...base, expected: 'If the password is invalid, an error message is displayed' }));
    assert.equal(yes.ir?.conditionals[0]?.given, 'TRUE');
    assert.ok(!yes.issues.some((i) => i.code === 'UNKNOWN_BRANCH'));
    assert.deepEqual(
      yes.plan?.items.filter((i) => i.kind === 'expect').map((i) => i.ref),
      ['E1'],
      'the expectation runs when its condition is known to be true',
    );
    const no = await compileCase(raw({ ...base, expected: 'If the password is valid, an error message is displayed' }));
    assert.equal(no.ir?.conditionals[0]?.given, 'FALSE');
    assert.deepEqual(
      no.plan?.items.filter((i) => i.kind === 'expect'),
      [],
      'a branch known not to apply is left out',
    );
    const unknown = await compileCase(raw({ ...base, expected: 'If the Email field is empty, an error message is displayed' }));
    assert.equal(unknown.ir?.conditionals[0]?.given, 'UNKNOWN');
    assert.equal(unknown.plan?.passAllowed, false, 'an unknown branch can never end in a clean PASS');
    assert.deepEqual(
      unknown.plan?.items.filter((i) => i.kind === 'expect'),
      [],
      'and is never chosen',
    );
  });
  it('"unless" turns the condition around, "otherwise" needs a condition before it', () => {
    assert.equal(line("Enter 'abc' in the Email field unless the Email field is disabled").conditionals[0]?.conditional.negated, true);
    assert.ok(line('Otherwise an error message is displayed', 'expected').issues.some((i) => i.severity === 'blocking'));
  });
});

describe('VD-04, VD-05: unsupported and paradox', () => {
  it('flags "Click Save while Save stays disabled" before execution', async () => {
    for (const s of ['Click Save while Save stays disabled', "Click the 'Save' button while the Save button is disabled"]) {
      const r = line(s);
      const issue = r.issues.find((i) => i.code === 'PARADOX');
      assert.ok(issue, s);
      assert.equal(issue.severity, 'blocking');
      assert.ok(issue.suggestion);
    }
    const compiled = await compileCase(
      raw({ steps: '1. Open the Login page\n2. Click Save while Save stays disabled', expected: 'The Login page is displayed' }),
    );
    assert.equal(compiled.status, 'needs-review');
    assert.equal(compiled.plan, undefined, 'nothing was planned, so nothing can run');
  });
  it('reports "Do the needful" and "Complete the process" as UNSUPPORTED, with the reason', () => {
    for (const s of ['Do the needful', 'Complete the process']) {
      const i = line(s).issues[0];
      assert.equal(i?.code, 'UNSUPPORTED');
      assert.ok(i.message.includes('not understood'));
    }
  });
});

const loadWorkbooks = async (): Promise<{ login: Array<{ raw: RawTestCase }>; employee: Array<{ raw: RawTestCase }> }> => ({
  login: (await readWorkbook(fixture('OrangeHRM_Login_Test_Cases_Updated.xlsx'))).cases,
  employee: (await readWorkbook(fixture('Add_Employee.xlsx'))).cases,
});

describe('the real workbooks, offline', () => {
  it('compiles every Login test case to QA-IR, or gives it a clear pre-flight reason', async () => {
    const { login } = await loadWorkbooks();
    assert.equal(login.length, 10);
    const cases = login.map((c) => ({ c, l: understandCase(c.raw) }));
    for (const { c, l } of cases) {
      const p = preflightOf(c.raw.title, l);
      if (p.status === 'ready') assert.ok(l.ir, `${c.raw.id} is ready, so it has a document`);
      else
        assert.ok(
          p.issues.some((i) => i.severity !== 'info' && i.suggestion),
          `${c.raw.id} has a clear reason and a clearer wording`,
        );
    }
    assert.equal(cases.filter(({ l }) => l.ir).length, 10);
    assert.equal(cases.filter(({ c, l }) => preflightOf(c.raw.title, l).status === 'ready').length, 9, 'only TC_LOGIN_010 needs the tester');
  });
  it('compiles every Add Employee test case to QA-IR, or gives it a clear pre-flight reason', async () => {
    const { employee } = await loadWorkbooks();
    assert.equal(employee.length, 19);
    for (const c of employee) {
      const l = understandCase(c.raw);
      const p = preflightOf(c.raw.title, l);
      assert.ok(l.ir || p.issues.some((i) => i.severity === 'blocking'), String(c.raw.id));
      for (const i of p.issues)
        if (i.severity === 'blocking' || i.severity === 'review') assert.ok(i.suggestion, `${c.raw.id}: ${i.message} has a suggested wording`);
    }
  });
  it('shows the pre-flight report to the owner: every test case that needs something is named, with its words and a better wording', async () => {
    const { login } = await loadWorkbooks();
    const report = preflightReport(login.map((c) => preflightOf(c.raw.title, understandCase(c.raw))));
    const text = preflightText(report);
    assert.ok(text.includes('TC_LOGIN_010'));
    assert.ok(text.includes('The system handles the whitespace'), "the tester's own words");
    assert.ok(text.includes('→'), 'and a clearer way to write it');
    assert.equal(report.blocked, 1);
    assert.ok(!text.includes('TC_LOGIN_001'), 'ready test cases are not listed unless asked');
  });
});

describe('T5: the wrong-PASS traps of 5 Oct (TC_LOGIN_004 to TC_LOGIN_007), compile part', () => {
  it('give correct expectations: the login is denied and the message is checked, in its own clause', async () => {
    const { login } = await loadWorkbooks();
    const byId = (id: string) => understandCase((login.find((c) => c.raw.id === id) as { raw: RawTestCase }).raw);
    for (const id of ['TC_LOGIN_004', 'TC_LOGIN_005', 'TC_LOGIN_006', 'TC_LOGIN_007']) {
      const ir = byId(id).ir;
      assert.ok(ir, id);
      const [e1, e2] = ir.expectations;
      assert.equal(ir.expectations.length, 2, id);
      assert.deepEqual([e1?.condition.type, e1?.negated, e1?.condition.expect], ['AUTHENTICATION', true, 'LOGGED_IN'], `${id}: the "not" lands on the login`);
      assert.deepEqual(
        [e2?.condition.type, e2?.negated, e2?.condition.fresh],
        ['VISIBILITY', false, true],
        `${id}: the message is checked, and it must be new`,
      );
      // An expectation that checks nothing could never fail: each one names what it checks.
      for (const e of ir.expectations) assert.ok(e.condition.target || e.condition.expect, `${id} ${e.id} would never fail`);
    }
    assert.equal(byId('TC_LOGIN_004').ir?.expectations[1]?.condition.target?.ontology, 'Error');
    assert.equal(byId('TC_LOGIN_005').ir?.expectations[1]?.condition.target?.near, 'username');
    assert.equal(byId('TC_LOGIN_006').ir?.expectations[1]?.condition.target?.near, 'password');
    assert.equal(byId('TC_LOGIN_007').ir?.expectations[1]?.condition.target?.ontology, 'Validation');
  });
});

describe('coverage and the first T6 measurement', () => {
  it('prints the coverage per category and records the understood rate and the top review reasons', async () => {
    const { login, employee } = await loadWorkbooks();
    const coverage = {
      login: coverageOf(login.map((c) => understandCase(c.raw))),
      employee: coverageOf(employee.map((c) => understandCase(c.raw))),
    };
    const text = `${coverageText('Login', coverage.login)}\n${coverageText('Add Employee', coverage.employee)}`;
    assert.ok(text.includes('steps understood') && text.includes('by category') && text.includes('top review reasons'));
    assert.equal(coverage.login.steps.total, 39);
    assert.equal(coverage.login.steps.understood, 39);
    assert.equal(coverage.login.expectations.understood, 10);
    assert.ok(coverage.login.topReasons.length >= 1);
    assert.ok(coverage.employee.topReasons.length >= 1);
    assert.ok(Object.keys(coverage.login.byCategory).includes('AUTHENTICATION'));

    // The numbers of this version were recorded in test/baseline/e04-t6.json. Each later version records its own file and is
    // compared with the one before (E0.5 does), so this file is history: it must stay, with the numbers it was made with.
    assert.ok(existsSync(T6), 'the E0.4 measurement is kept in test/baseline/e04-t6.json');
    const recorded = JSON.parse(readFileSync(T6, 'utf8'));
    assert.equal(recorded.version, 'E0.4');
    assert.equal(recorded.workbooks['OrangeHRM_Login_Test_Cases_Updated.xlsx'].steps.total, 39);
    assert.ok(recorded.workbooks['Add_Employee.xlsx'].topReasons.length >= 1);
  });
});

describe('BP-5: suggested wording in the results workbook', () => {
  it('gives every test case with a pre-flight issue a suggested wording, and writes it to the workbook', async () => {
    const imported = await readWorkbook(fixture('OrangeHRM_Login_Test_Cases_Updated.xlsx'));
    const compiled: Array<{ row: number; wording: string }> = [];
    for (const c of imported.cases) {
      const l = understandCase(c.raw);
      const withIssue = l.issues.some((i) => i.severity !== 'info');
      const wording = wordingOf(l.issues);
      assert.equal(wording.length > 0, withIssue, `${c.raw.id}: a suggestion exactly when there is an issue`);
      if (wording) compiled.push({ row: c.row, wording });
    }
    assert.equal(compiled.length, 1);
    const dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-e04-'));
    const out = path.join(dir, 'login.results.xlsx');
    await writeResults(
      imported,
      compiled.map((x) => ({ row: x.row, problem: 'Not run', suggestedWording: x.wording })),
      { finishedAt: new Date(0).toISOString(), totals: { PASS: 0, FAIL: 0, BLOCKED: 0, 'NEEDS REVIEW': 1, 'NOT VERIFIED': 0 }, review: [] },
      out,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet(imported.sheet) ?? wb.worksheets[0];
    const header = sheet.getRow(imported.headerRow);
    let col = 0;
    header.eachCell((cell, n) => {
      if (String(cell.value) === 'Suggested Wording') col = n;
    });
    assert.ok(col > 0, 'the column is there');
    assert.ok(String(sheet.getRow(compiled[0]?.row as number).getCell(col).value).includes('→'), 'with the suggestion');
  });
});

describe('determinism (GV-05)', () => {
  it('gives an identical QA-IR, issue list and decision list on every run', async () => {
    const { login, employee } = await loadWorkbooks();
    const once = [...login, ...employee].map((c) => JSON.stringify(understandCase(c.raw)));
    const twice = [...login, ...employee].map((c) => JSON.stringify(understandCase(c.raw)));
    assert.deepEqual(once, twice);
  });
  it('never writes a secret into the document or the decisions', async () => {
    const { login } = await loadWorkbooks();
    const secret = 'selenium';
    for (const c of login) {
      const l: CaseLanguage = understandCase(c.raw);
      assert.ok(!JSON.stringify(l).includes(secret), String(c.raw.id));
    }
    const wrong = understandCase(
      raw({ steps: "1. Open the Login page\n2. Enter 'hunter2' in the Password text box\n3. Click the Login button", expected: 'The Login page is displayed' }),
    );
    assert.ok(!JSON.stringify(wrong).includes('hunter2'), 'a value typed for a password in a step is kept masked');
  });
});

describe('real wording of the rewritten Employee workbook', () => {
  const read = (sentence: string) => understandLine(sentence, { data: parseTestData(''), facts: new Map(), mode: 'step' });
  const conditions = (sentence: string) => read(sentence).expectations.map((e) => e.condition);

  it('reads "the browser opens successfully" as the application starting, not as a page to land on', () => {
    assert.deepEqual(conditions('Verify The browser opens successfully'), [{ type: 'STATE', expect: 'APPLICATION_STARTED' }]);
    assert.deepEqual(read('Verify The browser opens successfully').issues, []);
  });
  it('keeps a list of names with one shared predicate in one clause: "Verify the A, B (C) and D tabs are visible"', () => {
    const r = read('Verify that the Admin, PIM (Personal Information Management), Leave, Time, Benefits and Help tabs are visible');
    assert.deepEqual(
      r.expectations.map((e) => e.condition.target?.name),
      ['Admin', 'PIM', 'Leave', 'Time', 'Benefits', 'Help'],
    );
    assert.ok(r.expectations.every((e) => e.condition.type === 'VISIBILITY' && e.condition.target?.ontology === 'Tab'));
    assert.deepEqual(r.issues, []);
  });
  it('still cuts at "and" when the right side is a check of its own', () => {
    const r = read('Verify the Login button and verify the Reset button is displayed');
    assert.equal(r.expectations.length, 1);
    assert.equal(r.expectations[0]?.condition.target?.name, 'Reset');
  });
  it('reads "PIM is the default page" as a check on the page PIM, and leaves "as a default page" to the noun phrase', () => {
    assert.deepEqual(conditions('PIM is the default page'), [{ type: 'STATE', target: { ontology: 'Page', name: 'PIM' }, expect: 'DEFAULT_PAGE' }]);
    const old = read('Verify User Should see tabs and PIM as a default page');
    // It is kept as written and listed, but it no longer stops the case (D3).
    assert.ok(old.issues.some((i) => i.code === 'AMBIGUOUS' && i.severity === 'info' && i.message.includes('as a default page')));
  });
  it('reads "form or page" as two words for one thing: one check on the name, and no question', () => {
    const r = read('Verify The Add Employee form or page is displayed');
    assert.equal(r.expectations.length, 1);
    assert.equal(r.expectations[0]?.condition.target?.name, 'Add Employee');
    assert.deepEqual(r.issues, []);
  });
  it('does not pick one of two alternatives when one is a message: that is a question for the tester, with no check made', () => {
    const r = read('Verify The Success message or the Employee List page is displayed');
    assert.equal(r.expectations.length, 0);
    assert.ok(r.issues.some((i) => i.code === 'AMBIGUOUS' && i.message.includes('alternatives')));
  });
  it('reads "selected image is uploaded and displayed in the photo area" as an uploaded image that is visible, not a ticked box', () => {
    const r = read('Verify The selected image is uploaded and displayed in the photo area');
    assert.deepEqual(
      r.expectations.map((e) => [e.condition.type, e.condition.expect]),
      [
        ['STATE', 'UPLOADED'],
        ['VISIBILITY', 'VISIBLE'],
      ],
    );
  });
  it('reads "the application saves the employee details" as a check that the data was saved', () => {
    assert.deepEqual(
      conditions('Verify The application saves the employee details').map((c) => c.expect),
      ['SAVED'],
    );
  });
  it('reads "the username is entered successfully" as a check on the value entered earlier, which a reference then settles', () => {
    const r = read('Verify The username is entered successfully');
    assert.deepEqual(
      r.expectations.map((e) => [e.condition.type, e.condition.target?.name, e.condition.expect]),
      [['VALUE', 'username', '$ref.entered']],
    );
    assert.ok(r.issues.some((i) => i.code === 'NEEDS_REFERENCE'));
  });
  it('does not take "entered" in "the entered username is displayed" for the check: the check is that it is displayed', () => {
    const r = read('Verify the entered username is displayed');
    assert.deepEqual(
      r.expectations.map((e) => e.condition.type),
      ['VISIBILITY'],
    );
  });
  it('puts what comes after "after" first: "Click Reset after entering X and selecting Y" is enter, select, then click', () => {
    const r = read('Click Reset after entering employee details and selecting a photo');
    assert.deepEqual(
      r.steps.map((s) => s.action),
      ['ENTER_VALUE', 'SELECT', 'CLICK'],
    );
    assert.equal(r.steps[2]?.target?.name, 'Reset');
  });
  it('keeps "Verify the A field, B field, and Login button are visible" in one clause, though "Login" is also a command', () => {
    const r = read('Verify that the Username field, Password field, and Login button are visible within the panel');
    assert.deepEqual(r.steps, []);
    assert.deepEqual(
      r.expectations.map((e) => e.condition.target?.name),
      ['Username', 'Password', 'Login'],
    );
    assert.equal(read('Verify the Username field is displayed and click Login').steps[0]?.action, 'CLICK');
  });
});
