import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileCase } from '../index.js';

/** D5 (audit U6): sentences the parser read wrongly, each with the real wording that showed it. */

async function compile(steps: string[], expected: string, testData = '') {
  const c = await compileCase({ id: 'T', title: 'T', steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), expected, testData }, { env: {} });
  return c;
}
const base = ['Open the Add Employee page'];

describe('D5: parser defects', () => {
  it('"The entered details are cleared" is about the fields that were entered, not cut at "entered"', async () => {
    const c = await compile(
      [...base, 'Enter First Name', 'Enter Last Name', 'Click the Reset button'],
      'The entered details are cleared',
      'First Name: Asha\nLast Name: Rao',
    );
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    assert.deepEqual(
      c.ir?.expectations.map((e) => [e.condition.type, e.condition.target?.name, e.condition.expect]),
      [
        ['VALUE', 'First Name', ''],
        ['VALUE', 'Last Name', ''],
      ],
    );
  });

  it('does not turn "entered details are removed" into a check that they are still there', async () => {
    const c = await compile([...base, 'Enter First Name', 'Click the Reset button'], 'The entered details are removed', 'First Name: Asha');
    assert.ok(!c.ir?.expectations.some((e) => e.condition.type === 'VALUE' && e.condition.expect === '$data.First_Name'));
  });

  it('"(masked)" after a step becomes a check that the field is masked', async () => {
    const c = await compile([...base, 'Enter the password (masked)', 'Click Save'], 'Employee is saved', 'Password: x1');
    const masked = c.ir?.expectations.find((e) => e.condition.type === 'MASKED');
    assert.ok(masked, 'the aside is a check');
    assert.equal(masked.condition.target?.name, 'password');
  });

  it('"Upload Photo to the Photo field" is the Photo field, not a field called "Photo to the Photo"', async () => {
    const c = await compile([...base, 'Upload Photo to the Photo field'], 'The Photo field is displayed', 'Photo: a.png');
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    const upload = c.ir?.steps.find((s) => s.action === 'UPLOAD');
    assert.equal(upload?.target?.name, 'Photo');
    assert.equal(upload?.value, '$data.Photo');
  });

  it('"In the Employment section, enter Job Title" is a step done in that section, not a check', async () => {
    const c = await compile(
      [...base, 'In the Employment section, enter Job Title', 'In the Employment section, click Save'],
      'The Employment heading is displayed',
    );
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    const [, enter, save] = c.ir?.steps ?? [];
    assert.equal(enter?.action, 'ENTER_VALUE');
    assert.equal(enter?.target?.within, 'employment');
    assert.equal(save?.action, 'CLICK');
    assert.equal(save?.target?.within, 'employment');
  });
});

describe('D3: setup lines and sentence shapes', () => {
  it('"Open a web browser" and "Launch the browser" are no step: the run opens its own browser', async () => {
    const c = await compile(['Open a web browser', 'Launch the browser', 'Open the Add Employee page'], 'The Add Employee heading is displayed');
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    assert.deepEqual(
      c.ir?.steps.map((s) => s.target?.name),
      ['Add Employee'],
    );
  });

  it('"Navigate to the application" opens the application, however it is spelled', async () => {
    const c = await compile(['Navigate to the application'], 'The Dashboard heading is displayed');
    assert.deepEqual(
      c.ir?.steps.map((s) => [s.action, s.target?.name]),
      [['NAVIGATE', 'Application']],
    );
  });

  it('"… PIM as a default page" does not stop the case: what is shown is checked, the tail is kept as written', async () => {
    const c = await compile([...base, 'Click the Save button'], 'User should see tabs and PIM as a default page');
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    assert.ok(c.issues.some((i) => i.severity === 'info' && i.message.includes('as a default page')));
  });

  it('"The Personal Details form or page is displayed" is one check on one name', async () => {
    const c = await compile([...base, 'Click the Save button'], 'The Personal Details form or page is displayed');
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    assert.equal(c.ir?.expectations.filter((e) => e.condition.type === 'VISIBILITY').length, 1);
    assert.equal(c.ir?.expectations[0]?.condition.target?.name, 'Personal Details');
  });

  it('"A or B is displayed" with two names is one check that holds when either is shown', async () => {
    const c = await compile([...base, 'Click the Save button'], 'The Employee List heading or the Dashboard heading is displayed');
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    const cond = c.ir?.expectations[0]?.condition;
    assert.deepEqual([cond?.target?.name, ...(cond?.alternatives ?? []).map((a) => a.name)], ['Employee List', 'Dashboard']);
  });

  it('a message among the alternatives still goes to review: what it says cannot be a list of names', async () => {
    const c = await compile([...base, 'Click the Save button'], 'The Success message or the Employee List page is displayed');
    assert.equal(c.status, 'needs-review');
  });
});

describe('D4: references to records, rows and saved data', () => {
  const saved = [...base, 'Enter First Name', 'Enter Last Name', 'Click the Save button'];
  const data = 'First Name: Asha\nLast Name: Rao';
  const shape = (c: Awaited<ReturnType<typeof compile>>) => c.ir?.expectations.map((e) => [e.condition.type, e.condition.target?.name, e.condition.expect]);

  it('"The added record is displayed in the table" looks for what was entered as text in the table', async () => {
    const c = await compile(saved, 'The added record is displayed in the table', data);
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    assert.deepEqual(shape(c), [
      ['TEXT', undefined, '$data.First_Name'],
      ['TEXT', undefined, '$data.Last_Name'],
    ]);
  });

  it('"The newly added employee is displayed in the employee list" is what was entered, not a name that nothing resolves', async () => {
    const c = await compile(saved, 'The newly added employee is displayed in the employee list', data);
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    assert.deepEqual(
      shape(c)?.map((x) => x[0]),
      ['TEXT', 'TEXT'],
    );
  });

  it('"Verify the saved details are shown" is what was entered before the Save', async () => {
    const c = await compile(saved, 'Verify the saved details are shown', data);
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
    assert.deepEqual(
      shape(c)?.map((x) => x[1]),
      ['First Name', 'Last Name'],
    );
  });

  it('keeps the field checks for a page, where the data was typed in', async () => {
    const c = await compile(saved, 'The added data is displayed on the Personal Information page', data);
    assert.deepEqual(
      shape(c)?.map((x) => x[0]),
      ['VALUE', 'VALUE'],
    );
  });
});
