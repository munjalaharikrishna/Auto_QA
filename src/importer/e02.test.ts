import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { Store } from '../db/store.js';
import { type RawTestCase, stepsWithChecks } from '../model/test-model.js';
import { describeChange, diffCases } from './diff.js';
import { orderNumbered, orderParts } from './numbering.js';
import { readWorkbook } from './workbook.js';

/** E0.2 exit tests: one fixture per workbook layout, the two real workbooks, a broken one, and a re-import with a changed step. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name: string) => path.join(root, 'test', 'fixtures', name);

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-e02-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function workbook(name: string, build: (wb: ExcelJS.Workbook) => void): Promise<string> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const file = path.join(dir, name);
  await wb.xlsx.writeFile(file);
  return file;
}

/** The fields a test says it expects, so one fixture is compared field by field without the row numbers. */
const fields = (c: { raw: RawTestCase }) => {
  const { row: _row, ...rest } = c.raw;
  return JSON.parse(JSON.stringify(rest)) as typeof rest;
};

describe('layouts (IN-04, IN-05, IN-16 to IN-19)', () => {
  it('one row per test case, with every optional column (IN-12 to IN-14) and empty cells (IN-15)', async () => {
    const file = await workbook('flat.xlsx', (wb) => {
      const ws = wb.addWorksheet('Cases');
      ws.addRow(['TC ID', 'Test Case Name', 'Pre-requisites', 'Steps', 'Test Data', 'Expected Outcome', 'Actual Result', 'Severity', 'Labels']);
      ws.addRow([
        'A-1',
        'Search',
        'Logged in',
        '1. Open Search page\n2. Enter "shoes" in the Search box',
        'Query: shoes',
        'Results are displayed',
        'it works',
        'High',
        'smoke, search',
      ]);
      ws.addRow(['A-2', 'Empty optional cells', undefined, '1. Open Home page', undefined, 'Home page is displayed']);
    });
    const r = await readWorkbook(file);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.cases.map(fields), [
      {
        id: 'A-1',
        title: 'Search',
        preconditions: 'Logged in',
        steps: '1. Open Search page\n2. Enter "shoes" in the Search box',
        testData: 'Query: shoes',
        expected: 'Results are displayed',
        actual: 'it works',
        priority: 'High',
        tags: ['smoke', 'search'],
      },
      { id: 'A-2', title: 'Empty optional cells', steps: '1. Open Home page', expected: 'Home page is displayed' },
    ]);
  });

  it("one row per step: continuation rows, a title merged over the rows, and each step's own expected result", async () => {
    const file = await workbook('steps.xlsx', (wb) => {
      const ws = wb.addWorksheet('Steps');
      ws.addRow(['Test Case Id', 'Test Case Name', 'Step No', 'Test Steps', 'Expected Results']);
      ws.addRow(['T-1', 'Login', 'Step 1', 'Open Login page', 'Login page is displayed']);
      ws.addRow([undefined, undefined, 'Step 2', 'Enter username Admin', undefined]);
      ws.addRow([undefined, undefined, 'Step 3', 'Click Login', 'User is redirected to Dashboard page']);
      ws.addRow(['T-2', 'Merged', 'Step 1', 'Open Login page', 'Page shown']);
      ws.addRow(['T-2', 'Merged', 'Step 2', 'Click\nLogin', 'Dashboard is displayed']);
      ws.mergeCells('A5:A6');
      ws.mergeCells('B5:B6');
    });
    const r = await readWorkbook(file);
    assert.deepEqual(r.problems, []);
    // The steps hold only the actions. A step's own expected result is kept beside it and read back as a check right after the step.
    assert.deepEqual(
      r.cases.map((c) => ({ ...fields(c), stepExpected: undefined })).map(({ stepExpected: _s, ...rest }) => rest),
      [
        { id: 'T-1', title: 'Login', steps: '1. Open Login page\n2. Enter username Admin\n3. Click Login', expected: 'User is redirected to Dashboard page' },
        { id: 'T-2', title: 'Merged', steps: '1. Open Login page\n2. Click Login', expected: 'Dashboard is displayed' },
      ],
    );
    assert.deepEqual(r.cases[0].raw.stepExpected, { '1': 'Login page is displayed' });
    assert.deepEqual(r.cases[1].raw.stepExpected, { '1': 'Page shown' });
    assert.equal(stepsWithChecks(r.cases[0].raw), '1. Open Login page\n2. Verify Login page is displayed\n3. Enter username Admin\n4. Click Login');
    assert.equal(stepsWithChecks(r.cases[1].raw), '1. Open Login page\n2. Verify Page shown\n3. Click Login');
  });

  it('a multi-line cell gives one step per numbered or bulleted line', async () => {
    const file = await workbook('multiline.xlsx', (wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['ID', 'Title', 'Steps', 'Expected']);
      ws.addRow(['M-1', 'Numbered', '1) Open Home page\n2) Click Login\n3) Enter username', 'Ok']);
      ws.addRow(['M-2', 'Bulleted', '- Open Home page\n- Click Login', 'Ok']);
      ws.addRow(['M-3', 'Step words', 'Step 1: Open Home page\nStep 2: Click Login', 'Ok']);
    });
    const r = await readWorkbook(file);
    const { splitNumbered } = await import('../parser/text.js');
    assert.deepEqual(
      r.cases.map((c) => splitNumbered(c.raw.steps).map((l) => l.text)),
      [
        ['Open Home page', 'Click Login', 'Enter username'],
        ['Open Home page', 'Click Login'],
        ['Open Home page', 'Click Login'],
      ],
    );
  });

  it('steps out of order are put in order, and a skipped number is reported (IN-18)', async () => {
    const file = await workbook('order.xlsx', (wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['ID', 'Title', 'Step No', 'Steps', 'Expected']);
      ws.addRow(['O-1', 'Rows', 'Step 2', 'Click Login', 'Dashboard is displayed']);
      ws.addRow([undefined, undefined, 'Step 1', 'Open Login page', undefined]);
      ws.addRow([undefined, undefined, 'Step 4', 'Click Logout', 'Login page is displayed']);
      const cell = wb.addWorksheet('Cell');
      cell.addRow(['ID', 'Title', 'Steps', 'Expected']);
      cell.addRow(['O-2', 'One cell', '2. Click Login\n1. Open Login page\n4. Click Logout', 'Ok']);
    });
    const r = await readWorkbook(file, { allSheets: true });
    assert.equal(r.cases[0].raw.steps, '1. Open Login page\n2. Click Login\n3. Click Logout');
    assert.deepEqual(r.cases[0].raw.stepExpected, { '2': 'Dashboard is displayed' });
    assert.equal(stepsWithChecks(r.cases[0].raw), '1. Open Login page\n2. Click Login\n3. Verify Dashboard is displayed\n4. Click Logout');
    assert.equal(r.cases[1].raw.steps, '1. Open Login page\n2. Click Login\n3. Click Logout');
    assert.ok(
      r.warnings.some((w) => /O-1.*out of order/.test(w)),
      r.warnings.join(' | '),
    );
    assert.ok(r.warnings.some((w) => /O-1.*jump from 2 to 4/.test(w)));
    assert.ok(r.warnings.some((w) => /O-2.*out of order/.test(w)));
    assert.ok(r.warnings.some((w) => /O-2.*jump from 2 to 4/.test(w)));
  });

  it('reads every sheet that has test cases, skips the others, and finds an id used on two sheets (IN-04, IN-20)', async () => {
    const file = await workbook('sheets.xlsx', (wb) => {
      const head = ['ID', 'Title', 'Steps', 'Expected'];
      wb.addWorksheet('Login').addRows([head, ['L-1', 'Login', 'Open Login page', 'Page shown']]);
      wb.addWorksheet('Notes').addRows([['Remember to review'], ['Nothing here']]);
      wb.addWorksheet('Empty');
      wb.addWorksheet('Admin').addRows([head, ['A-1', 'Admin', 'Open Admin page', 'Page shown'], ['L-1', 'Same id', 'Open Home page', 'Home shown']]);
    });
    const one = await readWorkbook(file);
    assert.deepEqual(
      one.cases.map((c) => c.raw.id),
      ['L-1'],
    );
    assert.ok(one.warnings.some((w) => /Other sheets.*Admin/.test(w)));

    const all = await readWorkbook(file, { allSheets: true });
    assert.deepEqual(all.sheets, ['Login', 'Admin']);
    assert.deepEqual(
      all.cases.map((c) => [c.sheet, c.raw.id]),
      [
        ['Login', 'L-1'],
        ['Admin', 'A-1'],
        ['Admin', 'L-1-R3'],
      ],
    );
    assert.deepEqual(
      all.duplicates.filter((d) => d.kind === 'id').map((d) => d.ids),
      [['L-1', 'L-1-R3']],
    );
  });

  it('flags different ids with identical content before anything runs (IN-20)', async () => {
    const file = await workbook('dupes.xlsx', (wb) => {
      wb.addWorksheet('S').addRows([
        ['ID', 'Title', 'Steps', 'Expected'],
        ['D-1', 'Login', 'Open Login page', 'Page shown'],
        ['D-2', 'login', 'open  login page', 'Page  shown'],
        ['D-3', 'Other', 'Open Home page', 'Home shown'],
      ]);
    });
    const r = await readWorkbook(file);
    assert.deepEqual(r.duplicates, [{ kind: 'content', ids: ['D-1', 'D-2'], rows: [2, 3] }]);
    assert.ok(r.warnings.some((w) => /D-1 and D-2.*same title, steps and expected result/.test(w)));
  });

  it('reads a CSV with quoted fields and a newline inside one (IN-03)', async () => {
    const file = path.join(dir, 'quoted.csv');
    await writeFile(file, 'ID,Title,Steps,Expected\r\nC-1,"Login, with comma","1. Open Login page\n2. Click ""Login""",Dashboard is displayed\r\n');
    const r = await readWorkbook(file);
    assert.deepEqual(r.cases.map(fields), [
      { id: 'C-1', title: 'Login, with comma', steps: '1. Open Login page\n2. Click "Login"', expected: 'Dashboard is displayed' },
    ]);
  });
});

describe('numbering helpers (IN-18)', () => {
  it('leaves what is already in order exactly as written', () => {
    assert.equal(orderNumbered('1. a\n2. b').text, '1. a\n2. b');
    assert.equal(orderNumbered('1) a\n2) b').text, '1) a\n2) b');
    assert.equal(orderNumbered('just one line').text, 'just one line');
    assert.equal(orderNumbered('1. a\ncontinues here\n2. b').text, '1. a\ncontinues here\n2. b', 'a line without a number continues the one above');
    assert.deepEqual(orderParts([{ stepNo: 'Step 1' }, { stepNo: 'Step 2' }]), {
      parts: [{ stepNo: 'Step 1' }, { stepNo: 'Step 2' }],
      reordered: false,
      gaps: [],
    });
  });
  it('orders, renumbers and reports', () => {
    assert.deepEqual(orderNumbered('3. c\n1. a\n2. b'), { text: '1. a\n2. b\n3. c', reordered: true, gaps: [] });
    assert.deepEqual(orderNumbered('1. a\n2. b\n4. d').gaps, ['the step numbers jump from 2 to 4.']);
    assert.deepEqual(orderParts([{ stepNo: '2' }, { stepNo: '2' }]).gaps, ['the first step is numbered 2, not 1.', 'step number 2 is used twice.']);
    assert.equal(orderParts([{ stepNo: 'Step 1' }, {}]).reordered, false, 'no number on a row: nothing to order by');
  });
});

describe('real workbooks', () => {
  it('Add_Employee.xlsx: 228 rows are exactly 19 test cases, with the steps and per-step expected results in order', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fixture('Add_Employee.xlsx'));
    assert.equal(wb.worksheets[0].rowCount - 1, 228, 'the sheet has 228 rows under its header');

    const r = await readWorkbook(fixture('Add_Employee.xlsx'));
    assert.deepEqual(r.problems, []);
    assert.equal(r.cases.length, 19);
    assert.deepEqual(
      r.cases.map((c) => c.raw.id),
      Array.from({ length: 19 }, (_, i) => `21022024_${i + 1}`),
    );
    assert.deepEqual(r.duplicates, []);

    // Step rows per case, as the sheet has them: TC01 has 3 (rows 2 to 4), TC04 has 6, and so on. Each step is followed by its own check.
    const stepsOf = (c: (typeof r.cases)[number]) => c.raw.steps.split('\n');
    const first = stepsOf(r.cases[0]);
    assert.deepEqual(first, ['1. Open Browser', '2. Enter url for Orange Hrm server', '3. Checking the login section at middle of the page']);
    assert.deepEqual(r.cases[0].raw.stepExpected, { '1': 'User should open browser', '2': 'User should navigate to login section of Oragne Hrm' });
    assert.deepEqual(stepsWithChecks(r.cases[0].raw).split('\n'), [
      '1. Open Browser',
      '2. Verify User should open browser',
      '3. Enter url for Orange Hrm server',
      '4. Verify User should navigate to login section of Oragne Hrm',
      '5. Checking the login section at middle of the page',
    ]);
    assert.equal(r.cases[0].raw.expected, 'Login section should be middle of the page');
    assert.equal(r.cases[3].raw.expected, 'User should navigate to Add Employee page/popup');
    assert.match(stepsOf(r.cases[3]).at(-1) as string, /^\d+\. Click on the Add Button$/);
    // A multi-line step cell is one step: "Checking the login section at middle of / the page" is not two.
    assert.ok(stepsOf(r.cases[3]).includes('3. Checking the login section at middle of the page'));
    // Every case repeats the same opening steps and then adds its own, so each has at least as many steps as the one before it plus its own.
    for (const c of r.cases) assert.match(c.raw.steps, /^1\. Open Browser\n2\. Enter url/);
    // Every step is numbered 1..n without a gap.
    for (const c of r.cases)
      assert.deepEqual(
        stepsOf(c).map((l) => Number.parseInt(l, 10)),
        stepsOf(c).map((_, i) => i + 1),
      );
    assert.deepEqual(r.unmatched, ['Test Case Description'], 'only the description is left as it is');
  });

  it('OrangeHRM_Login_Test_Cases_Updated.xlsx: 10 test cases, Test Data read as Username: cypress / Password: selenium', async () => {
    const r = await readWorkbook(fixture('OrangeHRM_Login_Test_Cases_Updated.xlsx'));
    assert.equal(r.cases.length, 10);
    assert.deepEqual(r.problems, []);
    assert.equal(r.cases[0].raw.id, 'TC_LOGIN_001');
    assert.equal(r.cases[0].raw.testData, 'Username: cypress\nPassword: selenium');
    assert.equal(r.cases[2].raw.testData, 'Username: cypress\nPassword: wrongpassword');
  });

  it('a workbook with no Steps column stops, and the message names the column (IN-21)', async () => {
    const file = await workbook('nosteps.xlsx', (wb) => {
      wb.addWorksheet('S').addRows([
        ['Testcase ID', 'Testcase Name', 'Expected Results'],
        ['X-1', 'Login', 'Page shown'],
      ]);
    });
    await assert.rejects(
      readWorkbook(file),
      (e: Error) => /no column for steps/.test(e.message) && !/for steps, expected|expected/.test(e.message.split('Headers')[0]),
    );
    const neither = await workbook('nothing.xlsx', (wb) => {
      wb.addWorksheet('S').addRows([['Testcase ID', 'Testcase Name', 'Remarks']]);
    });
    await assert.rejects(readWorkbook(neither), /no sheet has a header row|no column for steps, expected/);
  });
});

describe('versions of a re-imported test case (IN-23)', () => {
  it('a changed step makes a new version, and the diff shows only that step', async () => {
    const make = async (clickText: string) =>
      workbook(`v-${clickText.replace(/\W/g, '')}.xlsx`, (wb) => {
        wb.addWorksheet('S').addRows([
          ['ID', 'Title', 'Steps', 'Expected'],
          ['V-1', 'Login', `1. Open Login page\n2. Enter username Admin\n3. ${clickText}`, 'User is redirected to Dashboard page'],
        ]);
      });
    const store = await Store.open(':memory:');
    await store.createProject({
      id: 'p',
      name: 'P',
      baseUrl: 'http://x',
      testIdAttribute: 'data-testid',
      browser: 'chromium',
      workspace: path.join(dir, 'ws'),
    });
    const importFile = async (file: string, reason: string) => {
      const r = await readWorkbook(file);
      for (const c of r.cases)
        await store.upsertTestCase('p', { ...c.raw, id: c.raw.id as string }, { kind: 'workbook', ref: path.basename(file), row: c.row }, reason);
    };

    await importFile(await make('Click Login'), 'imported v1');
    await importFile(await make('Click Login'), 'imported again, nothing changed');
    assert.equal((await store.testCase('p', 'V-1'))?.version, 1, 'nothing changed: no new version');

    await importFile(await make('Click Sign in'), 'imported v2');
    const record = (await store.testCase('p', 'V-1'))!;
    assert.equal(record.version, 2);
    const [newer, older] = await store.testCaseVersions(record.id);
    const changes = diffCases(older.raw, newer.raw);
    assert.deepEqual(changes, [{ field: 'steps', kind: 'changed', line: 3, before: 'Click Login', after: 'Click Sign in' }]);
    assert.equal(describeChange(changes[0]), 'Step 3: "Click Login" → "Click Sign in"');
    await store.close();
  });

  it('describes every kind of change, and nothing when nothing changed', () => {
    const base: RawTestCase = { id: 'X', title: 'T', steps: '1. a\n2. b', expected: 'ok' };
    assert.deepEqual(diffCases(base, { ...base, steps: '1. a  \n2. b' }), [], 'whitespace is not a change');
    assert.deepEqual(diffCases(base, { ...base, steps: '1. a\n2. b\n3. c' }).map(describeChange), ['Step 3 added: "c"']);
    assert.deepEqual(diffCases(base, { ...base, steps: '1. a' }).map(describeChange), ['Step 2 removed: "b"']);
    assert.deepEqual(diffCases(base, { ...base, title: 'T2', expected: 'fine' }).map(describeChange), ['title: "T" → "T2"', 'Expected 1: "ok" → "fine"']);
    assert.deepEqual(diffCases(base, { ...base, preconditions: 'Logged in' }).map(describeChange), ['preconditions added: "Logged in"']);
  });
});
