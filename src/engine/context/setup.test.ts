import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '../../importer/workbook.js';
import type { RawTestCase } from '../../model/test-model.js';
import { buildReport, compileItems } from '../../pipeline/review-report.js';
import { compileCase } from '../pipeline/compile.js';
import { DEFAULT_LOGIN, findSetupBlock, loginOf, setupOf, suiteSetups } from './setup.js';

/** E0.16 item 1: setup blocks. The sentences are those of the real OrangeHRM Add Employee and Login workbooks. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SETUP = [
  'Open Browser',
  'Verify User should open browser',
  'Enter url for Orange Hrm server',
  'Verify User should navigate to login page',
  'Checking the login section at middle of the page',
  'Verify User should see the login section at the middle of the page',
  'Checking the tabs of Admin, PIM, Leave are visible or not.',
  'Verify User Should see tabs and PIM as a default page',
  'Under Employee Information Section there should be add button. Which should be in PIM page',
  'Verify User should add  button in employee information section',
];
const numbered = (lines: string[]): string => lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
const kase = (id: string, lines: string[], expected = 'The Add Employee page is displayed', testData?: string): RawTestCase => ({
  id,
  title: id,
  steps: numbered(lines),
  expected,
  ...(testData ? { testData } : {}),
});

const SUITE = [
  kase('TC01', SETUP.slice(0, 6), 'User should see the login section at the middle of the page'),
  kase('TC04', [...SETUP, 'Click on the Add Button']),
  kase('TC05', [...SETUP, 'Click on the Add Button', 'Enter the valid code/id in code text box']),
  kase('TC06', [...SETUP, 'Click on the Add Button', 'Enter valid Last name in Last name text box']),
];

describe('setup blocks: found once per suite (E0.16, U4)', () => {
  it('is the leading setup lines the cases share, and stops before the first line that is not setup', () => {
    const block = findSetupBlock('Add Employee', SUITE);
    assert.ok(block);
    assert.deepEqual(block.lines, SETUP);
    assert.deepEqual(block.members, ['TC04', 'TC05', 'TC06']);
  });

  it('a case that ends inside the block tests those lines itself: it is not a member', () => {
    const block = findSetupBlock('Add Employee', SUITE);
    assert.deepEqual(setupOf(block, SUITE[0] as RawTestCase, DEFAULT_LOGIN), { suite: 'Add Employee', lines: 6, member: false, login: DEFAULT_LOGIN });
    assert.equal(setupOf(block, SUITE[1] as RawTestCase)?.member, true);
  });

  it('a shared data-entry line is never setup', () => {
    const cases = [0, 1, 2].map((n) =>
      kase(`T${n}`, [...SETUP.slice(0, 3), 'Click on the Add Button', 'Enter valid Last name in Last name text box', `Step ${n}`]),
    );
    assert.deepEqual(findSetupBlock('s', cases)?.lines, SETUP.slice(0, 3));
  });

  it('a login step that takes its value from the Test Data is not setup: the same words with other data are another test (TC_LOGIN_003)', () => {
    const login = [
      'Open the OrangeHRM login page.',
      'Enter username in the Login Name text box.',
      'Enter password in the Password text box.',
      "Click the 'Login' button.",
    ];
    const cases = [
      kase('TC_LOGIN_001', login, 'User is logged in', 'Username: cypress\nPassword: selenium'),
      kase('TC_LOGIN_003', login, 'An error message is shown', 'Username: cypress\nPassword: wrong'),
      kase('TC_LOGIN_004', login, 'An error message is shown', 'Username: nobody\nPassword: selenium'),
    ];
    assert.deepEqual(findSetupBlock('Login', cases)?.lines, ['Open the OrangeHRM login page.']);
  });

  it('cases that do not start alike have no block', () => {
    assert.equal(findSetupBlock('s', [kase('A', ['Open the Login page', 'Click Login']), kase('B', ['Open the Home page', 'Click Help'])]), undefined);
  });
});

describe('setup blocks: what a member reads (E0.16)', () => {
  const setups = suiteSetups('Add Employee', SUITE);

  it('a setup line that cannot be read and only restates the line before it is set aside, not asked about', async () => {
    const c = await compileCase(SUITE[1] as RawTestCase, { env: {}, setup: setups.get('TC04') });
    const line = c.issues.find((i) => i.original.startsWith('Verify User should add'));
    assert.equal(line?.severity, 'info');
    assert.ok(line?.message.includes('set aside: the line before it already checks'));
    // The check of the line before still runs.
    assert.ok(c.ir?.expectations.some((e) => e.condition.target?.name === 'add' && e.condition.type === 'VISIBILITY'));
  });

  it('without the suite, the same line is a question, as before: the gold readings of single cases do not change', async () => {
    const c = await compileCase(SUITE[1] as RawTestCase, { env: {} });
    assert.equal(c.issues.find((i) => i.original.startsWith('Verify User should add'))?.severity, 'review');
  });

  it('logs in with the project login after the login page checks and before the tabs are checked, when no line logs in (E7)', async () => {
    const c = await compileCase(SUITE[1] as RawTestCase, { env: {}, setup: setups.get('TC04') });
    const ir = c.ir;
    assert.ok(ir);
    const ids = ir.steps.map((s) => `${s.id} ${s.action} ${s.target?.name ?? ''}`);
    assert.deepEqual(ids.slice(0, 4), ['S3 NAVIGATE Application', 'S3.2 ENTER_VALUE Username', 'S3.3 ENTER_VALUE Password', 'S3.4 CLICK Login']);
    assert.equal(ir.data.test_username?.value, '$env.TEST_USERNAME');
    assert.equal(ir.data.test_password?.secret, true);
    // The login page is checked before the login; the tabs after it.
    const after = (name: string) => ir.expectations.find((e) => e.condition.target?.name === name)?.afterStep;
    assert.equal(after('login'), 'S3');
    assert.equal(after('Admin'), 'S3.4');
    // The tester's own login button is not one of their names: no conflict with "the login section".
    assert.ok(!c.issues.some((i) => i.message.includes('more than one kind of element')));
  });

  it('the fields and button come from the project login case when there is one', async () => {
    const login = await compileCase(
      kase(
        'TC_LOGIN_001',
        [
          'Open the OrangeHRM login page.',
          'Enter username in the Login Name text box.',
          'Enter password in the Password text box.',
          "Click the 'Login' button.",
        ],
        'User is logged in',
        'Username: cypress\nPassword: selenium',
      ),
      { env: {} },
    );
    const from = loginOf(login.ir);
    assert.equal(from?.username.name, 'Login Name');
    const c = await compileCase(SUITE[1] as RawTestCase, { env: {}, setup: suiteSetups('Add Employee', SUITE, from).get('TC04') });
    assert.equal(c.ir?.steps[1]?.target?.name, 'Login Name');
    // The Excel credentials of the login case are not used: the setup logs in with the project's (S4).
    assert.equal(c.ir?.data.test_password?.value, '$env.TEST_PASSWORD');
  });

  it('a case that writes its own login is not logged in again', async () => {
    const own = kase('TC', [
      'Open the OrangeHRM login page.',
      'Verify User should navigate to login page',
      'Enter valid username in the Login Name text box.',
      'Enter valid password in the Password text box.',
      "Click the 'Login' button.",
      'Verify User Should see tabs and PIM as a default page',
      'Click on the Add Button',
    ]);
    const twin = { ...own, id: 'TC2', steps: `${own.steps}\n8. Click on Save` };
    const c = await compileCase(own, { env: {}, setup: suiteSetups('s', [own, twin, { ...twin, id: 'TC3' }]).get('TC') });
    assert.equal(c.ir?.steps.filter((s) => s.action === 'CLICK' && s.target?.name === 'Login').length, 1);
  });
});

describe('setup blocks on the real Add Employee sheet (E0.16 exit test: repeated setup lines raise no review)', () => {
  it('the setup line asked about in 16 cases is asked about in none of them, and the report counts a block question once', async () => {
    const imported = await readWorkbook(path.join(root, 'test/fixtures/Add_Employee.xlsx'));
    const setups = suiteSetups(
      'Add_Employee.xlsx',
      imported.cases.map((c) => c.raw),
    );
    const members = [...setups.entries()].filter(([, s]) => s.member).map(([id]) => id);
    assert.equal(members.length, 16);
    const items = [];
    for (const c of imported.cases) {
      const setup = setups.get(c.raw.id ?? '');
      const compiled = await compileCase(c.raw, { env: {}, ...(setup ? { setup } : {}) });
      // No question is raised by a setup line of a member.
      if (setup?.member)
        assert.deepEqual(
          compiled.issues.filter((i) => i.severity !== 'info' && i.block),
          [],
        );
      items.push(...compileItems('Add_Employee.xlsx', c.raw.id ?? '', compiled));
    }
    const report = buildReport(
      items,
      imported.cases.map((c) => ({ workbook: 'Add_Employee.xlsx', caseId: c.raw.id ?? '' })),
    );
    const unreadable = report.groups.find((g) => g.cause.startsWith('not understood: no check could be read'));
    // Only TC03's own expected result is left: the case that tests that line.
    assert.deepEqual(unreadable?.cases, ['Add_Employee.xlsx/21022024_3']);
  });
});
