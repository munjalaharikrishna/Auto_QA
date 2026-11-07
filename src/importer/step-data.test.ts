import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { understandCase } from '../engine/language/case.js';
import { stepDataOfLines, stepsWithChecks } from '../model/test-model.js';
import { readWorkbook } from './workbook.js';

/** E0.16 item 3 (audit P2): Test Data kept per step; rows with only an expected result or only data continue the step above. */

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-e016-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sheet(rows: Array<Array<string | undefined>>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Login');
  ws.addRow(['Test Case Id', 'Test Case Name', 'Step No', 'Test Steps', 'Test Data', 'Expected Results']);
  for (const r of rows) ws.addRow(r);
  const file = path.join(dir, `s${Math.random().toString(36).slice(2)}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

describe('continuation rows (P2)', () => {
  it('a row with only an expected result is the check of the step above, not a case of its own', async () => {
    const file = await sheet([
      ['T-1', 'Login', 'Step 1', 'Open the Login page', undefined, undefined],
      [undefined, undefined, undefined, undefined, undefined, 'Login page is displayed'],
      [undefined, undefined, 'Step 2', 'Click Login', undefined, 'User is redirected to Dashboard page'],
    ]);
    const r = await readWorkbook(file);
    assert.deepEqual(r.problems, []);
    assert.equal(r.cases.length, 1);
    assert.deepEqual(r.cases[0]?.raw.stepExpected, { '1': 'Login page is displayed' });
    assert.equal(r.cases[0]?.raw.expected, 'User is redirected to Dashboard page');
    assert.ok(r.warnings.some((w) => /row 3 has no step of its own: its expected result belong to the step of row 2/.test(w)));
  });

  it('a row with only test data is the data of the step above, not a heading', async () => {
    const file = await sheet([
      ['T-1', 'Login', 'Step 1', 'Enter username', 'Username: admin', undefined],
      [undefined, undefined, undefined, undefined, 'Password: secret1', undefined],
      [undefined, undefined, 'Step 2', 'Click Login', undefined, 'Dashboard is displayed'],
    ]);
    const r = await readWorkbook(file);
    assert.deepEqual(r.problems, []);
    assert.ok(!r.warnings.some((w) => /heading/.test(w)), r.warnings.join('\n'));
    assert.equal(r.cases.length, 1);
    assert.equal(r.cases[0]?.raw.testData, 'Username: admin; Password: secret1');
  });

  it('a row that is only a heading is still a heading', async () => {
    const file = await sheet([['LOGIN MODULE'], ['T-1', 'Login', 'Step 1', 'Open the Login page', undefined, 'Login page is displayed']]);
    const r = await readWorkbook(file);
    assert.ok(r.warnings.some((w) => /LOGIN MODULE.*heading/.test(w)));
    assert.equal(r.cases.length, 1);
  });
});

describe('Test Data per step (P2)', () => {
  const rows: Array<Array<string | undefined>> = [
    ['T-1', 'Wrong then right password', 'Step 1', 'Open the Login page', undefined, 'Login page is displayed'],
    [undefined, undefined, 'Step 2', 'Enter username', 'Username: Admin', undefined],
    [undefined, undefined, 'Step 3', 'Enter password', 'Password: wrong123', undefined],
    [undefined, undefined, 'Step 4', 'Click Login', undefined, 'An error message is displayed'],
    [undefined, undefined, 'Step 5', 'Enter password', 'Password: admin123', undefined],
    [undefined, undefined, 'Step 6', 'Click Login', undefined, 'User is redirected to Dashboard page'],
  ];

  it('each row keeps its own data, by the number of its step', async () => {
    const r = await readWorkbook(await sheet(rows));
    const raw = r.cases[0]?.raw;
    assert.deepEqual(raw?.stepData, { '2': 'Username: Admin', '3': 'Password: wrong123', '5': 'Password: admin123' });
    // A step's own check is a line of its own when read: it sees the data of the step it follows.
    const lines = stepsWithChecks(raw as NonNullable<typeof raw>).split('\n');
    const data = stepDataOfLines(raw as NonNullable<typeof raw>);
    assert.equal(lines.length, data.length);
    assert.equal(data[lines.findIndex((l) => l.endsWith('Enter password'))], 'Password: wrong123');
  });

  it("two steps with the same key type each their own row's value; the secrets are kept apart", async () => {
    const r = await readWorkbook(await sheet(rows));
    const language = understandCase(r.cases[0]?.raw as NonNullable<(typeof r.cases)[0]>['raw']);
    const ir = language.ir;
    assert.ok(ir, language.irProblems.join('; '));
    const passwords = ir.steps.filter((s) => s.action === 'ENTER_VALUE' && s.target?.ontology === 'Password').map((s) => s.value);
    assert.equal(passwords.length, 2);
    assert.notEqual(passwords[0], passwords[1]);
    const [first, second] = passwords.map((v) => (v as string).replace('$data.', ''));
    assert.equal(language.excelSecrets[first as string]?.reveal(), 'wrong123');
    assert.equal(language.excelSecrets[second as string]?.reveal(), 'admin123');
    // Never as text anywhere in the result.
    assert.ok(!JSON.stringify({ ir, issues: language.issues, decisions: language.decisions }).includes('admin123'));
  });

  it('a case without per-step data reads as before', () => {
    const language = understandCase({
      id: 'T-2',
      title: 'one row',
      steps: '1. Enter username\n2. Enter password\n3. Click Login',
      testData: 'Username: Admin; Password: admin123',
      expected: 'User is redirected to Dashboard page',
    });
    assert.deepEqual(language.ir?.steps.map((s) => s.value).filter(Boolean), ['$data.Username', '$data.Password']);
    assert.equal(language.excelSecrets.Password?.reveal(), 'admin123');
  });
});
