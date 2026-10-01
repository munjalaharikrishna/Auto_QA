import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Assertion, RawTestCase, Step } from '../model/test-model.js';
import { executionOrder, parseTestCase } from './index.js';
import { splitNumbered } from './text.js';

const tc = (over: Partial<RawTestCase>) => parseTestCase({ title: 'T', steps: '1. Open Home page', expected: 'Home page is displayed', ...over });
const step = (text: string, testData?: string): Step => tc({ steps: `1. ${text}`, testData }).steps[0];
const check = (text: string): Assertion => tc({ expected: text }).assertions[0];
const pick = <T extends object>(o: T, keys: Array<keyof T>) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

describe('step splitting (FR-IN-03)', () => {
  it('splits numbered steps in one line and across lines', () => {
    assert.deepEqual(splitNumbered('1. Open Home 2) Click Login\n3. Enter Email'), [
      { n: 1, text: 'Open Home' },
      { n: 2, text: 'Click Login' },
      { n: 3, text: 'Enter Email' },
    ]);
  });
  it('does not read "step" at the end of a line as a step marker', () => {
    assert.deepEqual(
      splitNumbered('1. Reach the payment step\n2. Click Pay').map((l) => l.text),
      ['Reach the payment step', 'Click Pay'],
    );
  });
  it('only splits on the next number in sequence', () => {
    assert.deepEqual(
      splitNumbered('1. Enter 5. Then wait\n2. Click Go').map((l) => l.text),
      ['Enter 5. Then wait', 'Click Go'],
    );
  });
  it('joins wrapped lines in a numbered cell and splits plain lines', () => {
    assert.deepEqual(
      splitNumbered('1. Click the\nLogin button\n2. Go').map((l) => l.text),
      ['Click the Login button', 'Go'],
    );
    assert.deepEqual(
      splitNumbered('- Open Home\n- Click Login').map((l) => l.n),
      [1, 2],
    );
  });
  it('keeps the tester numbers as step ids (FR-GE-03)', () => {
    assert.deepEqual(
      tc({ steps: 'Step 1: Open Home page\nStep 2: Click Login' }).steps.map((s) => s.id),
      ['S1', 'S2'],
    );
  });
});

describe('action lexicon and targets (FR-PA-02, FR-PA-03)', () => {
  it('maps verbs and verb forms to actions', () => {
    assert.equal(step('Go to Login page').action, 'navigate');
    assert.equal(step('User clicks Login').action, 'click');
    assert.equal(step('Tap on Menu').action, 'click');
    assert.equal(step('Tick Remember me').action, 'check');
    assert.equal(step('Untick Remember me').action, 'uncheck');
    assert.equal(step('Hover over Profile').action, 'hover');
    assert.equal(step('Then clear Search').action, 'clear');
  });
  it('removes role words and keeps them as roleHint', () => {
    assert.deepEqual(pick(step('Click the Login button'), ['action', 'target', 'roleHint']), { action: 'click', target: 'Login', roleHint: 'button' });
    assert.deepEqual(pick(step('Check the Remember me checkbox'), ['target', 'roleHint']), { target: 'Remember me', roleHint: 'checkbox' });
    assert.equal(step('Click Page Title').target, 'Page Title');
    assert.deepEqual(pick(step('Select "Option 2" from the dropdown list'), ['target', 'roleHint']), { target: 'dropdown list', roleHint: 'combobox' });
  });
  it('treats quoted names as exact', () => {
    assert.deepEqual(pick(step("Click the 'Browse Opportunities' link"), ['target', 'exact', 'roleHint']), {
      target: 'Browse Opportunities',
      exact: true,
      roleHint: 'link',
    });
  });
  it('reads press as a key or a click', () => {
    assert.deepEqual(pick(step('Press Enter'), ['action', 'key']), { action: 'press', key: 'Enter' });
    assert.equal(step('Press Ctrl + A').key, 'Control+A');
    assert.deepEqual(pick(step('Press Continue'), ['action', 'target']), { action: 'click', target: 'Continue' });
  });
  it('reads select from a dropdown, or as choosing a radio/checkbox', () => {
    assert.deepEqual(pick(step('Select "India" from Country dropdown'), ['action', 'target', 'roleHint', 'value']), {
      action: 'select',
      target: 'Country',
      roleHint: 'combobox',
      value: { kind: 'literal', value: 'India' },
    });
    assert.deepEqual(pick(step('Select Male'), ['action', 'target']), { action: 'check', target: 'Male' });
    assert.equal(step('Select Country dropdown').reason?.code, 'NO_VALUE');
  });
  it('reads navigate targets as page, URL or the base URL', () => {
    assert.equal(step('Open Home page').page, 'Home');
    assert.equal(step('Navigate to https://www.saucedemo.com/inventory.html').url, 'https://www.saucedemo.com/inventory.html');
    assert.equal(step('Open /login').url, '/login');
    // The environment's BASE_URL exactly, path included (not the site root).
    assert.deepEqual(pick(step('Launch the application'), ['action', 'baseUrl', 'url']), { action: 'navigate', baseUrl: true });
  });
});

describe("testers' own wording (real test cases)", () => {
  it('reads "Enter the URL" as opening the application', () => {
    for (const s of ['Enter url for Orange Hrm server', 'Enter the URL', 'Type the application URL', 'Open the application URL']) {
      assert.deepEqual(pick(step(s), ['action', 'baseUrl']), { action: 'navigate', baseUrl: true }, s);
    }
    // An address field is still a field.
    assert.equal(step('Enter "a@b.com" in Email address field').action, 'fill');
  });

  it('reads "Enter <value> in <field>" with the value named first', () => {
    assert.deepEqual(pick(step('Enter user name in Login Name text box'), ['action', 'target', 'roleHint', 'value']), {
      action: 'fill',
      target: 'Login Name',
      roleHint: 'textbox',
      value: { kind: 'env', name: 'TEST_USERNAME' },
    });
    assert.deepEqual(pick(step('Enter password in Password  text box'), ['target', 'value']), {
      target: 'Password',
      value: { kind: 'env', name: 'TEST_PASSWORD' },
    });
    assert.deepEqual(pick(step('Enter Email into the Login field', 'Email=a@b.com'), ['target', 'value']), {
      target: 'Login',
      value: { kind: 'data', key: 'Email' },
    });
    // Something that is not a known value is not guessed.
    assert.equal(step('Enter John in First name').reason?.code, 'NO_VALUE');
  });

  it('needs no step for opening the browser', () => {
    const m = tc({ steps: '1. Open Browser\n2. Open Home page' });
    assert.deepEqual(
      m.steps.map((s) => s.id),
      ['S2'],
    );
    assert.ok(m.warnings.some((w) => w.at === 'S1' && w.code === 'NO_STEP_NEEDED'));
    assert.ok(!m.warnings.some((w) => w.code === 'NO_START'));
  });

  it('reads a step written inside quotes', () => {
    const m = tc({ steps: '1. Open Home page\n2. "Checking the login section at middle of the page"' });
    const a = m.assertions.find((x) => x.step === 'S2')!;
    // Where something is on the page is a check of its own now (VAL-F01): the login section must be in the middle.
    assert.deepEqual(pick(a, ['type', 'target', 'status', 'container']), { type: 'centered', target: 'login', status: 'parsed', container: true });
    assert.ok(!m.warnings.some((w) => w.code === 'POSITION_IGNORED'));
  });

  it('reads "able to navigate to X" as a redirect check', () => {
    assert.deepEqual(pick(check('User able to navigate to PIM page'), ['type', 'expected', 'match']), { type: 'url', expected: 'PIM', match: 'page' });
    assert.deepEqual(pick(check('User should be able to open the Reports page'), ['type', 'expected']), { type: 'url', expected: 'Reports' });
    assert.equal(check('User is unable to navigate to Admin page').negated, true);
  });

  it('explains how to split an action and a check', () => {
    const s = step('Click on the login button and validate the title');
    assert.equal(s.reason?.code, 'MULTIPLE_ACTIONS');
    assert.match(s.reason?.text ?? '', /starts a check inside an action/);
  });
});

describe('alternatives and noise (FR-PA-04, FR-PA-05)', () => {
  it('reads alternative names', () => {
    assert.deepEqual(step('Click Apply to the Network (or Apply)').alternatives, ['Apply']);
    assert.deepEqual(pick(step('Enter Email Address (Email)', 'Email=a@b.com'), ['target', 'alternatives']), {
      target: 'Email Address',
      alternatives: ['Email'],
    });
    assert.deepEqual(pick(step('Click Login / Sign in'), ['target', 'alternatives']), { target: 'Login', alternatives: ['Sign in'] });
  });
  it('ignores arrows, fillers and note brackets, with a warning', () => {
    const m = tc({ steps: '1. Click Apply → as applicable\n2. Click Save (optional)' });
    assert.deepEqual(
      m.steps.map((s) => s.target),
      ['Apply', 'Save'],
    );
    assert.ok(m.warnings.some((w) => w.at === 'S1' && w.code === 'FILLER_REMOVED'));
    assert.ok(m.warnings.some((w) => w.at === 'S2' && w.code === 'BRACKET_IGNORED'));
  });
});

describe('browser actions (FR-PA-09)', () => {
  it('reads back, forward and refresh', () => {
    assert.equal(step('Use browser Back').action, 'back');
    assert.equal(step('Go back').action, 'back');
    assert.equal(step('Refresh the page').action, 'refresh');
    assert.equal(step('Click Back').action, 'click');
  });
});

describe('data binding (FR-PA-10, FR-TD-01, FR-TD-02)', () => {
  it('binds the test user to env vars', () => {
    assert.deepEqual(step('Enter valid username').value, { kind: 'env', name: 'TEST_USERNAME' });
    assert.deepEqual(step('Enter password').value, { kind: 'env', name: 'TEST_PASSWORD' });
    assert.deepEqual(step('Enter valid email').value, { kind: 'env', name: 'TEST_USERNAME' });
  });
  it('reads quoted and inline literals', () => {
    assert.deepEqual(step('Enter "a@b.com" in Email field').value, { kind: 'literal', value: 'a@b.com' });
    assert.deepEqual(step('Enter Name as Asha').value, { kind: 'literal', value: 'Asha' });
    assert.deepEqual(step('Type a@b.com into Email').value, { kind: 'literal', value: 'a@b.com' });
  });
  it('reads values from the Test Data column, by name or synonym', () => {
    assert.deepEqual(step('Enter Email', 'Email=a@b.com').value, { kind: 'data', key: 'Email' });
    assert.deepEqual(step('Enter E-mail address', 'Username=u1').value, { kind: 'data', key: 'Username' });
    assert.deepEqual(step('Enter Email', 'Email={{unique.email}}').value, { kind: 'generator', name: 'unique.email' });
  });
  it('asks instead of guessing a value', () => {
    assert.equal(step('Enter Email').reason?.code, 'NO_VALUE');
    assert.equal(step('Enter invalid password', 'Password=x').reason?.code, 'NO_VALUE');
    assert.equal(step('Fill the form with valid data').reason?.code, 'VAGUE_VALUE');
  });
  it('never stores a secret as a literal', () => {
    const m = tc({ steps: '1. Enter wrong password', testData: 'Email=a@b.com; Password=secret_sauce\nWrong Password=abc' });
    assert.deepEqual(m.data, { Email: 'a@b.com' });
    assert.deepEqual(m.steps[0].value, { kind: 'env', name: 'TEST_WRONG_PASSWORD' });
    assert.ok(!JSON.stringify(m).includes('secret_sauce'));
    assert.ok(!JSON.stringify(m).includes('abc'));
    const literal = tc({ steps: '1. Enter "wrong1" in Password' });
    assert.equal(literal.steps[0].reason?.code, 'SECRET_LITERAL');
    assert.ok(!JSON.stringify(literal).includes('wrong1'));
  });
  it('warns about data it cannot read', () => {
    assert.ok(tc({ testData: 'just words' }).warnings.some((w) => w.code === 'DATA_UNPARSED'));
  });
});

describe('checks (FR-PA-06, FR-PA-07, FR-PA-08)', () => {
  const shape = (a: Assertion) => pick(a, ['type', 'target', 'roleHint', 'expected', 'match', 'negated', 'exact']);

  it('turns check steps into assertions linked to their step', () => {
    const m = tc({ steps: '1. Open Home page\n2. Observe Registration page\n3. Click Next' });
    assert.deepEqual(
      m.steps.map((s) => s.id),
      ['S1', 'S3'],
    );
    assert.deepEqual(pick(m.assertions[0], ['type', 'target', 'roleHint', 'step']), { type: 'visible', target: 'Registration', roleHint: 'page', step: 'S2' });
    // A2 is the Expected Result check, A3 the built-in health check: both run after the last step.
    assert.deepEqual(
      executionOrder(m).map((i) => i.id),
      ['S1', 'A1', 'S3', 'A2', 'A3'],
    );
  });
  it('reads url checks', () => {
    assert.deepEqual(shape(check('User is redirected to Dashboard')), { type: 'url', expected: 'Dashboard', match: 'page', negated: false });
    assert.deepEqual(shape(check('URL contains "/inventory"')), { type: 'url', expected: '/inventory', match: 'url', negated: false });
    assert.deepEqual(shape(check('User remains on the Login page')), { type: 'url-unchanged', expected: 'Login', match: 'page', negated: false });
    assert.equal(check('User stays on the same page').expected, undefined);
  });
  it('reads text, visible, state and value checks', () => {
    assert.deepEqual(shape(check('Error "This email is already registered" is shown')), {
      type: 'text',
      expected: 'This email is already registered',
      negated: false,
    });
    assert.deepEqual(shape(check('Error message: Invalid credentials')), { type: 'text', expected: 'Invalid credentials', negated: false });
    assert.deepEqual(shape(check('Error message: Username and password do not match')), {
      type: 'text',
      expected: 'Username and password do not match',
      negated: false,
    });
    assert.deepEqual(shape(check('"Required" is displayed under Email field')), {
      // An error under a field belongs to that field (VAL-D04).
      type: 'field-error',
      target: 'Email',
      roleHint: 'textbox',
      expected: 'Required',
      negated: false,
    });
    assert.deepEqual(shape(check("The 'Save' button should be displayed")), {
      type: 'visible',
      target: 'Save',
      roleHint: 'button',
      exact: true,
      negated: false,
    });
    assert.deepEqual(shape(check('Continue button is disabled')), { type: 'disabled', target: 'Continue', roleHint: 'button', negated: false });
    assert.deepEqual(shape(check('Remember me is unchecked')), { type: 'checked', target: 'Remember me', negated: true });
    assert.deepEqual(shape(check('Email field contains "a@b.com"')), {
      type: 'value',
      target: 'Email',
      roleHint: 'textbox',
      expected: 'a@b.com',
      negated: false,
    });
  });
  it('reads negative checks', () => {
    assert.deepEqual(shape(check('User cannot open Personal')), { type: 'url', expected: 'Personal', match: 'page', negated: true });
    assert.deepEqual(shape(check('Error is not displayed')), { type: 'visible', target: 'Error', negated: true });
    assert.deepEqual(shape(check('User is not redirected to Dashboard')), { type: 'url', expected: 'Dashboard', match: 'page', negated: true });
  });
  it('never reads negation words inside quoted text', () => {
    assert.deepEqual(shape(check('Error "You cannot proceed" is shown')), { type: 'text', expected: 'You cannot proceed', negated: false });
  });
  it('splits joined checks only when every part is a check', () => {
    assert.deepEqual(
      tc({ expected: 'User is redirected to Dashboard and Welcome is displayed' }).assertions.map((a) => a.type),
      ['url', 'visible', 'health'],
    );
    assert.deepEqual(check('Terms and Conditions link is displayed').target, 'Terms and Conditions');
    assert.deepEqual(
      tc({ expected: 'Error is shown. User stays on Login page; Save is disabled' }).assertions.map((a) => a.type),
      ['visible', 'url-unchanged', 'disabled', 'health'],
    );
  });
  it('adds the health check to every test (FR-VAL-04)', () => {
    assert.deepEqual(pick(tc({}).assertions.at(-1)!, ['type', 'source']), { type: 'health', source: 'builtin' });
  });
});

describe('unparsed steps (FR-PA-11)', () => {
  it('marks steps no rule matches, with a reason and a warning', () => {
    const m = tc({
      steps: '1. Login with valid credentials\n2. Enter email and click Continue\n3. Enter username and password',
      expected: 'User is logged in successfully',
    });
    assert.deepEqual(
      m.steps.map((s) => [s.status, s.reason?.code]),
      [
        ['unparsed', 'NO_ACTION'],
        ['unparsed', 'MULTIPLE_ACTIONS'],
        ['unparsed', 'MULTIPLE_FIELDS'],
      ],
    );
    assert.equal(m.assertions[0].reason?.code, 'VAGUE_CHECK');
    assert.equal(m.warnings.filter((w) => w.code === 'UNPARSED').length, 4);
  });
});

describe('preconditions (FR-PF-01)', () => {
  it('reads fresh context, login state and flows', () => {
    const m = tc({ preconditions: 'Unauthenticated visitor; Logged in as "admin" user\nUser is on Registration page\nApplication is accessible' });
    assert.deepEqual(
      m.preconditions.map((p) => ({ ...p, raw: undefined })),
      [
        { kind: 'fresh-context', raw: undefined },
        { kind: 'logged-in', user: 'admin', raw: undefined },
        { kind: 'flow', name: 'On Registration page', raw: undefined },
        { kind: 'note', raw: undefined },
      ],
    );
  });
});

describe('quality check (FR-QC-01, FR-QC-02)', () => {
  it('flags vague steps and a missing start', () => {
    const m = tc({ steps: '1. Reach the payment step\n2. Click Pay', expected: 'Receipt is shown' });
    assert.ok(m.warnings.some((w) => w.code === 'VAGUE_STEP' && w.at === 'S1'));
    assert.ok(m.warnings.some((w) => w.code === 'NO_START'));
    assert.ok(!tc({}).warnings.some((w) => w.code === 'NO_START'));
    assert.ok(!tc({ steps: '1. Click Pay', preconditions: 'On Payment page' }).warnings.some((w) => w.code === 'NO_START'));
  });
});

describe('model', () => {
  it('is deterministic, with a stable generated id (NFR-02)', () => {
    const input = { title: 'Login works', steps: '1. Open Login page\n2. Enter username', expected: 'Dashboard is shown' };
    assert.deepEqual(parseTestCase(input), parseTestCase(input));
    assert.match(parseTestCase(input).id, /^TC-[0-9A-F]{8}$/);
    assert.equal(parseTestCase({ ...input, row: 7 }).id, 'TC-007');
    assert.equal(parseTestCase({ ...input, id: 'TC-REG-014' }).id, 'TC-REG-014');
  });
  it('keeps known test types only', () => {
    assert.equal(tc({ type: 'Negative' }).type, 'negative');
    assert.ok(tc({ type: 'smoke' }).warnings.some((w) => w.code === 'UNKNOWN_TYPE'));
  });
});
