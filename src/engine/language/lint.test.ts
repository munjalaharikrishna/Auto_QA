import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { writeResults } from '../../importer/results.js';
import { readWorkbook } from '../../importer/workbook.js';
import type { Screen } from '../knowledge/screens.js';
import { understandCase } from './case.js';
import { lintCase, lintCounts, lintText } from './lint.js';

const screen = (p: Partial<Screen> & { key: string }): Screen => ({
  headings: [],
  tables: [],
  elements: [],
  source: 'run',
  cases: [],
  words: [],
  ...p,
});
const el = (name: string, role = 'textbox') => ({ id: name, role, name, frame: [], inside: [] });

const login = screen({
  key: '/login',
  title: 'Login',
  headings: ['Login'],
  elements: [el('Username'), el('Password'), el('Login', 'button')],
  cases: ['TC1'],
});
const raw = (steps: string, expected = 'The Dashboard heading is displayed', testData = 'Username: Admin\nPassword: admin123') => ({
  id: 'TC1',
  title: 'Login',
  steps,
  expected,
  testData,
});
const statuses = (lines: ReturnType<typeof lintCase>) => lines.map((l) => [l.where, l.status]);

describe('lint before a run (E0.15)', () => {
  it('without learned screens, a line that was read is "understood"', () => {
    const lines = lintCase(understandCase(raw('1. Open the Login page\n2. Enter Username\n3. Click Login')));
    assert.deepEqual(statuses(lines), [
      ['step 1', 'understood'],
      ['step 2', 'understood'],
      ['step 3', 'understood'],
      ['expected result', 'understood'],
    ]);
  });

  it('with learned screens: matched, and "not found" with the closest names when this case reached the screen', () => {
    const lines = lintCase(understandCase(raw('1. Open the Login page\n2. Enter Username\n3. Click Logn')), { screens: [login] });
    assert.deepEqual(statuses(lines).slice(0, 3), [
      ['step 1', 'matched'],
      ['step 2', 'matched'],
      ['step 3', 'not found'],
    ]);
    assert.equal(lines[2]?.suggestion, "Did you mean 'Login'? Write the name as the screen shows it.");
  });

  it('a name with every word of the screen\'s name is matched: "Email" is the "Email address" field', () => {
    const s = screen({ key: '/login', title: 'Login', elements: [el('Email address')], cases: ['TC1'] });
    const lines = lintCase(understandCase(raw('1. Open the Login page\n2. Enter Email', undefined, 'Email: a@b.c')), { screens: [s] });
    assert.equal(lines[1]?.status, 'matched');
  });

  it('a screen no run or walkthrough has reached is "screen not learned yet", not "not found", and points to the walkthrough', () => {
    const lines = lintCase(understandCase(raw('1. Open the Add Employee page\n2. Enter First Name', undefined, 'First Name: Asha')), { screens: [login] });
    assert.deepEqual(statuses(lines).slice(0, 2), [
      ['step 1', 'screen not learned yet'],
      ['step 2', 'screen not learned yet'],
    ]);
    assert.ok(lines[1]?.suggestion?.includes('walkthrough'));
  });

  it('a value the engine must make up, or a kind of element with no name, is "vague", with a suggestion', () => {
    const lines = lintCase(understandCase(raw('1. Open the Login page\n2. Enter valid Last name\n3. Click the button', undefined, '')));
    assert.equal(lines[1]?.status, 'vague');
    assert.ok(lines[1]?.suggestion?.includes('Test Data'));
    assert.equal(lines[2]?.status, 'vague');
    assert.ok(lines[2]?.suggestion);
  });

  it('a line that could not be read is "not understood", and one that points at something earlier is "ambiguous"', () => {
    const lines = lintCase(understandCase(raw('1. Open the Login page\n2. Frobnicate the widget', 'Verify the added data is shown')));
    assert.equal(lines[1]?.status, 'not understood');
    assert.equal(lines[2]?.status, 'ambiguous');
  });

  it("as text, every line shows the tester's words and its status; counts add up", () => {
    const lines = lintCase(understandCase(raw('1. Open the Login page\n2. Enter Username\n3. Click Logn')), { screens: [login] });
    const text = lintText(lines);
    assert.ok(text.includes('✗ step 3 "Click Logn": not found'));
    assert.equal(
      Object.values(lintCounts(lines)).reduce((a, b) => a + b, 0),
      lines.length,
    );
  });
});

describe('the lint in the results workbook (E0.15)', () => {
  it('writes the status of every line of a case into a Lint column', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const imported = await readWorkbook(path.join(root, 'test/fixtures/Add_Employee.xlsx'));
    const first = imported.cases[0];
    assert.ok(first);
    const text = lintText(lintCase(understandCase(first.raw)));
    const dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-lint-'));
    const out = path.join(dir, 'add.results.xlsx');
    await writeResults(
      imported,
      [{ row: first.row, problem: 'Not run', lint: text }],
      { finishedAt: new Date(0).toISOString(), totals: { PASS: 0, FAIL: 0, BLOCKED: 0, 'NEEDS REVIEW': 1, 'NOT VERIFIED': 0 }, review: [] },
      out,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet(imported.sheet) ?? wb.worksheets[0];
    let col = 0;
    sheet?.getRow(imported.headerRow).eachCell((cell, n) => {
      if (String(cell.value) === 'Lint') col = n;
    });
    assert.ok(col > 0, 'the column is there');
    const cell = String(sheet?.getRow(first.row).getCell(col).value);
    assert.equal(cell, text);
    assert.ok(cell.includes('step 1 "Open Browser"'));
  });
});
