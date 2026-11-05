import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RawTestCase } from '../../model/test-model.js';
import { buildReport, compileItems } from '../../pipeline/review-report.js';
import { understandCase } from '../language/case.js';
import { compileCase } from '../pipeline/compile.js';
import { buildLedger, describeRecord, entityOf, pageBefore, recordBefore } from './ledger.js';

/** E0.16 item 2: the data ledger. The sentences are those of the OrangeHRM Add Employee workbook, shortened. */

const kase = (steps: string[], expected: string, testData?: string): RawTestCase => ({
  id: 'TC_LEDGER',
  title: 'ledger',
  steps: steps.join('\n'),
  expected,
  ...(testData ? { testData } : {}),
});
const ADD = ['Open the Add Employee page', 'Enter valid First name in First name text box', 'Enter valid Last name in Last name text box', 'Click on Save'];
const read = (steps: string[], expected: string) => {
  const r = understandCase(kase(steps, expected));
  assert.ok(r.ir, `no IR: ${r.irProblems.join('; ')}`);
  return r;
};

describe('data ledger', () => {
  it('writes down each value entered and makes a record at the Save, of the kind of thing the page adds', () => {
    const r = read([...ADD, 'Click on Back Button'], 'User should see the employee list');
    const ir = r.ir as NonNullable<typeof r.ir>;
    const ledger = buildLedger(ir.steps, ir.expectations);
    assert.deepEqual(
      ledger.values.map((v) => v.step),
      ['S2', 'S3'],
    );
    assert.equal(ledger.records.length, 1);
    const [record] = ledger.records;
    assert.equal(record?.entity, 'Employee');
    assert.equal(record?.kind, 'created');
    assert.equal(record?.savedBy, 'S4');
    assert.match(describeRecord(record as NonNullable<typeof record>), /the employee this case created in S2-S3, saved by S4 \(First name, Last name\)/);
  });

  it('names the kind of thing from the page, not from words that only say what is done there', () => {
    assert.equal(entityOf('Add Employee'), 'Employee');
    assert.equal(entityOf('Edit Employee Details'), 'Employee');
    assert.equal(entityOf('Personal Information'), undefined);
  });

  it('notes a Reset between the values and the Save: the record was probably saved without them', () => {
    const r = read([ADD[0] as string, ADD[1] as string, 'Click on Reset', 'Click on Save'], 'User should see the employee list');
    const ir = r.ir as NonNullable<typeof r.ir>;
    const [record] = buildLedger(ir.steps, ir.expectations).records;
    assert.equal(record?.wipedBy, 'S3');
  });

  it('a later save of the same thing on another page updates the record', () => {
    const r = read(
      [...ADD, 'Click on Back Button', 'Open the Job page', 'Select valid Job Title in Job Title dropdown', 'Click on Save'],
      'User should see the employee list',
    );
    const ir = r.ir as NonNullable<typeof r.ir>;
    const ledger = buildLedger(ir.steps, ir.expectations);
    assert.deepEqual(
      ledger.records.map((d) => [d.entity, d.kind]),
      [
        ['Employee', 'created'],
        ['Employee', 'updated'],
      ],
    );
    assert.equal(recordBefore(ledger, ir.steps, ir.steps.length, 'employee')?.id, 'D2');
    assert.equal(recordBefore(ledger, ir.steps, 4, 'employee')?.id, 'D1');
    assert.equal(recordBefore(ledger, ir.steps, ir.steps.length, 'department'), undefined);
  });

  it('knows the page before the current one', () => {
    const r = read(['Open the Add Employee page', 'Open the Job page'], 'User should see the Job page');
    const ir = r.ir as NonNullable<typeof r.ir>;
    assert.equal(pageBefore(buildLedger(ir.steps, ir.expectations), ir.steps, ir.steps.length)?.page, 'Add Employee');
  });
});

describe('references through the ledger', () => {
  it('"the entered details" are everything entered on the page, not only the last field', () => {
    const r = read(ADD.slice(0, 3), 'User should see the entered details');
    const checks = r.ir?.expectations.filter((e) => e.clause === 'User should see the entered details') ?? [];
    assert.deepEqual(
      checks.map((e) => [e.condition.type, e.condition.target?.name]),
      [
        ['VALUE', 'First name'],
        ['VALUE', 'Last name'],
      ],
    );
  });

  it('"Text box should accept values" stays the field of its own step (gold row 7)', () => {
    const r = read(ADD.slice(0, 3), 'Text box should accept values');
    assert.deepEqual(
      r.ir?.expectations.map((e) => e.condition.target?.name),
      ['Last name'],
    );
  });

  it('"the added employee in the list" is the record the case saved, read in the list as text', () => {
    const r = read([...ADD, 'Click on Back Button'], 'User should see the added employee in the employee list');
    assert.deepEqual(
      r.ir?.expectations.map((e) => [e.condition.type, e.condition.expect]),
      [
        ['TEXT', '$data.First_name_valid'],
        ['TEXT', '$data.Last_name_valid'],
      ],
    );
    assert.ok(r.ir?.references.some((x) => x.status === 'RESOLVED' && /the employee this case created/.test(x.because)));
  });

  it('"the added employee" is left as written when the case saved no employee', () => {
    const r = read(['Open the Employee List page', 'Click on Search'], 'User should see the added employee in the employee list');
    assert.equal(r.ir?.expectations[0]?.condition.type, 'STATE');
  });

  it('"the previous page" is the page before, not a page called "previous"', () => {
    const r = read(['Open the Add Employee page', 'Open the Job page', 'Click on Cancel'], 'User should navigate to the previous page');
    const url = r.ir?.expectations.find((e) => e.condition.type === 'URL');
    assert.equal(url?.condition.target?.name, 'Add Employee');
  });

  it('"the previous page" is asked about when the case was on no other page', () => {
    const r = read(['Open the Add Employee page', 'Click on Cancel'], 'User should navigate to the previous page');
    assert.ok(r.issues.some((i) => i.code === 'NEEDS_REFERENCE' && i.reference === 'previous'));
  });
});

describe('which record: a person decides, the ledger suggests (owner, 4 Nov 2026)', () => {
  const steps = [...ADD, 'Click on Back Button', 'Click on Employee Name', 'Select preferred Employee and Click on Delete Button'];

  it('"Click on Employee Name" stays a question, with the employee this case created as the suggestion', () => {
    const r = read(steps, 'User Should succesfully Deleted Employee Data');
    const click = r.issues.find((i) => i.original === 'Click on Employee Name');
    assert.equal(click?.severity, 'review');
    assert.equal(click?.record, 'employee');
    assert.match(click?.suggested?.answer ?? '', /the employee this case created in S2-S3, saved by S4/);
    assert.deepEqual(click?.suggested?.steps, ['S2', 'S3']);
    const deleted = r.issues.find((i) => i.original === 'User Should succesfully Deleted Employee Data');
    assert.equal(deleted?.suggested?.record, 'D1');
  });

  it('"the same updated records" stays unresolved, is the tester\'s, and is offered the record', () => {
    const r = read(steps.slice(0, 6), 'User should see the same updated records');
    const ref = r.issues.find((i) => i.code === 'NEEDS_REFERENCE');
    assert.equal(ref?.record, 'record');
    assert.ok(ref?.suggested);
  });

  it('no suggestion when the case saved nothing', () => {
    const r = read(['Open the Employee List page', 'Click on Employee Name'], 'User should see the Personal Details page');
    const click = r.issues.find((i) => i.original === 'Click on Employee Name');
    assert.ok(click);
    assert.equal(click?.suggested, undefined);
  });

  it('the review report asks a "which record" sentence once, for every case that has it', async () => {
    const items = [];
    for (const id of ['TC15', 'TC16', 'TC17']) {
      const compiled = await compileCase({ ...kase(steps.slice(0, 6), 'User should see the Personal Details page'), id });
      items.push(...compileItems('Add_Employee.xlsx', id, compiled));
    }
    const report = buildReport(
      items,
      ['TC15', 'TC16', 'TC17'].map((caseId) => ({ workbook: 'Add_Employee.xlsx', caseId })),
    );
    const group = report.groups.find((g) => g.cause.includes('names no employee'));
    assert.equal(group?.owner, 'tester');
    assert.equal(group?.count, 1);
    assert.equal(group?.cases.length, 3);
    assert.match(group?.examples[0]?.message ?? '', /suggested: the employee this case created/);
  });
});
