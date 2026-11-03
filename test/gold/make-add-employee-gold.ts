/**
 * Builds the DRAFT gold readings of the 19 OrangeHRM Add Employee cases (E0.15 exit test: at least 90% of sentences read as approved).
 *
 * Each distinct sentence of the workbook is read once below, from the tester's words and the OrangeHRM 2.5 screens, never from the
 * engine's output; the cases are then built from those readings, in the order the sentences appear. A person checks the readings, then
 * fills in `review` in the output file.
 *
 *   npx tsx test/gold/make-add-employee-gold.ts      writes test/gold/orangehrm-add-employee.gold.json
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldExpectation, GoldSet, GoldStep } from '../../src/engine/governance/gold.js';
import { readWorkbook } from '../../src/importer/workbook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = 'test/fixtures/Add_Employee.xlsx';
const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

type Reading<T> = Array<Omit<T, 'original'>>;
/** Placeholders for readings that depend on where the sentence stands in the case (see `inContext`). */
const FIELD_OF_STEP = '<field of its step>';
const FIELDS_BEFORE = '<every field filled in before>';
const CHECK_AS_STEP = 'a check written as a step: its reading is the expected result that goes with it';

/** Steps: one entry per action the sentence holds, in order. */
const STEPS: Record<string, Reading<GoldStep>> = {
  'Open Browser': [{ abstain: true, why: 'opening a browser is the test setup, not something the application does' }],
  'Enter url for Orange Hrm server': [
    {
      action: 'NAVIGATE',
      target: 'application',
      why: "'Enter url' means go to the application's address (the project's base URL), not type into a field; no address is written",
    },
  ],
  'Checking the login section at middle of the page': [{ abstain: true, why: CHECK_AS_STEP }],
  'Checking the tabs of Admin,PIM (Personal Information Manager), Leave, Time, Benfits, Recruitment, Reports, Bug Tracker, Help are visible or not. Note:The PIM should be as Default Page.':
    [
      {
        abstain: true,
        why: `${CHECK_AS_STEP}. The tabs show only after a login that no step writes: the case assumes it (E0.16 setup block)`,
      },
    ],
  'Under Employee Information Section there should be add button. Which should be in PIM page': [{ abstain: true, why: CHECK_AS_STEP }],
  'Click on the Add Button': [{ action: 'CLICK', target: 'Add' }],
  'Enter the valid code/id in code text box Note: Text box should accept only numbers': [
    {
      action: 'ENTER_VALUE',
      target: 'Code',
      value: { class: 'VALID' },
      why: 'the Note is a rule of the field (digits only), not the value to type',
    },
  ],
  'Enter valid Last name in Last name text box. Note: Text box should accept only alphabets': [
    { action: 'ENTER_VALUE', target: 'Last Name', value: { class: 'VALID' }, why: 'the Note is a rule of the field (letters only), not the value' },
  ],
  'Enter valid First name in First name text box. Note: Text box should accept only alphabets': [
    { action: 'ENTER_VALUE', target: 'First Name', value: { class: 'VALID' }, why: 'the Note is a rule of the field (letters only), not the value' },
  ],
  'Enter valid Middle name in Middle name text box. Note:Text box should accept only alphabets': [
    { action: 'ENTER_VALUE', target: 'Middle Name', value: { class: 'VALID' }, why: 'the Note is a rule of the field (letters only), not the value' },
  ],
  'Enter valid Nick name in Nick name text box. Note:Text box should accept only alphabets': [
    { action: 'ENTER_VALUE', target: 'Nick Name', value: { class: 'VALID' }, why: 'the Note is a rule of the field (letters only), not the value' },
  ],
  'upload a photo by clicking upload button': [
    { action: 'UPLOAD', target: 'Photograph', why: "the photo file input; 'by clicking upload button' is how a person does it. No file is named: a valid image is needed" },
  ],
  'Entered text boxes and uploaded photo should empty by clicking reset': [
    {
      action: 'CLICK',
      target: 'Reset',
      why: 'the action inside a sentence written as a check; the check is the expected result that goes with it',
    },
  ],
  'Click on Save': [
    {
      action: 'CLICK',
      target: 'Save',
      why: 'TRAP: in these cases Reset (the step before) has just emptied the form, so this Save sends an empty form. The reading is still a click on Save',
    },
  ],
  'To checking the added data in personal information page': [{ abstain: true, why: CHECK_AS_STEP }],
  'Click on Back Button': [{ action: 'CLICK', target: 'Back' }],
  'Click on Employee Name': [
    {
      action: 'CLICK',
      target: 'Employee Name',
      why: 'the name of the employee added earlier, a link in the Employee Information list (a row: E0.16 ledger, E0.17 rows)',
    },
  ],
  'Enter/update the Job Title, Employement Status, Sub-Division and Supervisor in respective fileds on Employment section': [
    { action: 'SELECT', target: 'Job Title', value: { class: 'VALID' }, why: "a dropdown on the employee's Job page; no value is given" },
    { action: 'SELECT', target: 'Employment Status', value: { class: 'VALID' }, why: 'a dropdown; no value is given' },
    { action: 'SELECT', target: 'Sub Division', value: { class: 'VALID' }, why: "OrangeHRM 2.5 calls it 'Sub Unit'; a dropdown; no value is given" },
    {
      abstain: true,
      why: "OrangeHRM 2.5 sets a supervisor under 'Report-to', not on the Job page: a person must say what is meant",
    },
  ],
  'checking the same updated records in Employee information page': [{ abstain: true, why: CHECK_AS_STEP }],
  'Select preferred Enployee/Employees and Click on Delete Button': [
    {
      action: 'CHECK',
      target: 'the added employee',
      why: "'preferred employee' is the one this case added: its row's checkbox in the list (E0.16 ledger). Never any other employee",
    },
    { action: 'CLICK', target: 'Delete' },
  ],
};

/** Expected results, per step and for the case: one entry per check the sentence holds. */
const EXPECTATIONS: Record<string, Reading<GoldExpectation>> = {
  'User should open browser': [{ abstain: true, why: "an environment fact (the test's own browser), not something the application shows" }],
  'User should navigate to login section of Oragne Hrm': [
    { type: 'URL', negated: false, target: 'login', why: "a page name, not address text. 'section' and 'of Oragne Hrm' are not part of the name (the application's name, misspelt)" },
  ],
  'Login section should be middle of the page': [
    { type: 'LAYOUT', negated: false, target: 'login', why: "where the login box sits on the page ('middle'): a layout check. 'section' is the kind of thing, not its name" },
  ],
  'User Should see tabs and PIM as a default page': [
    {
      type: 'VISIBILITY',
      negated: false,
      target: 'tabs',
      why: 'the tabs named in the step: Admin, PIM, Leave, Time, Benefits, Recruitment, Reports, Bug Tracker, Help',
    },
    { type: 'STATE', negated: false, target: 'PIM', why: "PIM is the page shown first after login: the engine's 'default page' check, as for 'PIM is the default page'" },
  ],
  'User should add  button in employee information section': [
    {
      type: 'VISIBILITY',
      negated: false,
      target: 'Add',
      why: "'should add button' is a slip for 'should see the Add button', in the Employee Information section",
    },
  ],
  'User should add button in employee information section': [
    {
      type: 'VISIBILITY',
      negated: false,
      target: 'Add',
      why: "'should add button' is a slip for 'should see the Add button', in the Employee Information section",
    },
  ],
  'User should navigate to Add Employee page/popup': [
    { type: 'URL', negated: false, target: 'Add Employee', why: "a screen name ('page/popup': whichever it is)" },
  ],
  // Placeholder: replaced per case by the field of the step it belongs to (see `inContext`).
  'Text box should accept values': [{ type: 'VALUE', negated: false, target: FIELD_OF_STEP, why: 'the field of the step it belongs to holds the value typed' }],
  'Upload button should accept photo': [
    { type: 'VALUE', negated: false, target: 'Photograph', why: 'the photo file input holds the chosen file' },
  ],
  // Placeholder: replaced per case by one "is empty" check per field filled in before Reset (see `inContext`).
  'User should see the empty text boxes and uploaded photo': [
    { type: 'VALUE', negated: false, target: FIELDS_BEFORE, why: 'every field filled in and the photo chosen earlier is empty after Reset (E0.16 ledger)' },
  ],
  'User should naviagte to Personal Information page': [
    { type: 'URL', negated: false, target: 'Personal Information', why: "a page name ('naviagte' is a typo)" },
  ],
  'User should see added data': [
    {
      type: 'TEXT',
      negated: false,
      target: 'Personal Information',
      why: 'the values entered earlier are shown (E0.16 ledger). TRAP: Reset emptied them before Save, so there is no added data to see',
    },
  ],
  'User should navigate to Employee Information page': [
    { type: 'URL', negated: false, target: 'Employee Information', why: 'a page name' },
  ],
  'User should naviagte to Employment section': [
    {
      type: 'URL',
      negated: false,
      target: 'Employment',
      why: "a section of the employee's details (Job in OrangeHRM 2.5): a screen name",
    },
  ],
  'Respective fileds should accept the values': [
    { type: 'VALUE', negated: false, target: 'Job Title', why: 'each field of the step holds the value chosen' },
    { type: 'VALUE', negated: false, target: 'Employment Status', why: 'each field of the step holds the value chosen' },
    { type: 'VALUE', negated: false, target: 'Sub Division', why: 'each field of the step holds the value chosen' },
  ],
  'User should updated the data': [
    {
      abstain: true,
      why: "says the data was updated without saying what shows it (a message? the values kept after Save?): a person must say what to check",
    },
  ],
  'User should see the same updated records': [
    {
      type: 'TEXT',
      negated: false,
      target: "the employee's row",
      why: "the list row of the employee shows the values updated earlier (E0.16 ledger, a row: E0.17). 'same' points back to them",
    },
  ],
  'User Should succesfully Deleted Employee Data': [
    {
      type: 'VISIBILITY',
      negated: true,
      target: "the deleted employee's row",
      why: 'the employee is no longer in the list. OrangeHRM asks to confirm the delete first',
    },
  ],
};

/** The fields a step puts a value in. */
const fieldsOf = (steps: GoldStep[]) =>
  steps.flatMap((s) => ((s.action === 'ENTER_VALUE' || s.action === 'UPLOAD') && s.target ? [s.target] : []));

/** Fills in the placeholders: `step` is the step line the expected result belongs to, `before` the steps up to it. */
function inContext(e: Omit<GoldExpectation, 'original'>, step: GoldStep[], before: GoldStep[]): Array<Omit<GoldExpectation, 'original'>> {
  if (e.target === FIELD_OF_STEP) return fieldsOf(step).map((target) => ({ ...e, target }));
  if (e.target === FIELDS_BEFORE) return fieldsOf(before).map((target) => ({ ...e, target }));
  return [e];
}

const lookup = <T>(table: Record<string, Reading<T>>, text: string): Reading<T> => {
  const found = Object.entries(table).find(([k]) => key(k) === key(text));
  if (!found) throw new Error(`no reading drafted for: ${text}`);
  return found[1];
};
const stepText = (line: string) => line.replace(/^\s*\d+\.\s*/, '').trim();

const book = await readWorkbook(path.join(root, SOURCE));
const set: GoldSet = {
  version: 'G0.2',
  review: null,
  about:
    'DRAFT by Claude (3 Nov 2026), for the E0.15 exit test. What each step and expected result of the OrangeHRM Add Employee workbook means, worked out from the tester\'s words and the OrangeHRM 2.5 screens, never from the engine\'s output. Not reviewed: the owner checks each reading (above all the abstains and the "why"), corrects it, then fills in `review`. Built by test/gold/make-add-employee-gold.ts. Run: npm run engine:gold -- test/gold/orangehrm-add-employee.gold.json --draft',
  cases: book.cases.map((c) => {
    const lines = c.raw.steps.split('\n').map(stepText).filter(Boolean);
    const perLine: GoldStep[][] = lines.map((original) => lookup(STEPS, original).map((r) => ({ original, ...r })));
    const steps = perLine.flat();
    // Each expected result belongs to a step line: a step's own, or, for the case's, the last step.
    const perStep: Array<[number, string]> = Object.entries(c.raw.stepExpected ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([n, text]) => [Number(n) - 1, text]);
    const expected = (c.raw.expected ?? '').trim();
    const all: Array<[number, string]> = expected ? [...perStep, [lines.length - 1, expected]] : perStep;
    const expectations: GoldExpectation[] = all.flatMap(([at, original]) =>
      lookup(EXPECTATIONS, original).flatMap((r) => inContext(r, perLine[at] ?? [], perLine.slice(0, at).flat()).map((x) => ({ original, ...x }))),
    );
    return { id: c.raw.id, module: 'orangehrm-add-employee', source: { file: SOURCE }, status: 'single' as const, gold: { steps, expectations } };
  }),
};
const out = path.join(root, 'test/gold/orangehrm-add-employee.gold.json');
await writeFile(out, `${JSON.stringify(set, null, 2)}\n`);
console.log(`wrote ${out}: ${set.cases.length} cases`);

// The page the owner reviews: each distinct sentence once, with its reading and why.
const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const stepRow = (r: Omit<GoldStep, 'original'>) =>
  r.abstain ? '**a person decides**' : `${r.action} **${cell(r.target)}**${r.value ? ` (value: ${r.value.class}${r.value.value ? ` "${r.value.value}"` : ''})` : ''}`;
const expRow = (r: Omit<GoldExpectation, 'original'>) =>
  r.abstain
    ? '**a person decides**'
    : `${r.type}${r.negated ? ' NOT' : ''} **${r.target === FIELD_OF_STEP ? 'the field of its step' : r.target === FIELDS_BEFORE ? 'each field filled in before (empty)' : cell(r.target)}**`;
const table = <T>(rows: Record<string, Reading<T>>, show: (r: Omit<T, 'original'>) => string) =>
  Object.entries(rows)
    .filter(([k], i, all) => all.findIndex(([x]) => key(x) === key(k)) === i)
    .map(([text, rs], i) =>
      rs.map((r, j) => `| ${j ? '' : i + 1} | ${j ? '〃' : cell(text)} | ${show(r)} | ${cell((r as { why?: string }).why)} | |`).join('\n'),
    )
    .join('\n');
const review = `# Gold readings to review: OrangeHRM Add Employee (E0.15)

DRAFT by Claude, 3 Nov 2026. The E0.15 exit test measures the engine against these readings (at least 90% of sentences read as approved), so they must be **yours**, not mine. Each distinct sentence of the 19 cases is below once; the 19 cases are built from them by \`test/gold/make-add-employee-gold.ts\`.

**How to review:** for each row, write OK in the last column, or what it should be. "A person decides" means the engine must not guess: it asks. When you are done, the readings are corrected and \`review\` is filled in with your name.

Readings follow the earlier gold sets: a browser-opening line is set aside; a check written as a step ("Checking…") is set aside as a step, and its reading is the expected result that goes with it; a page name ("navigate to … page") is a URL check on that page.

## Steps

| # | The tester wrote | Reading | Why | Your verdict |
|---|---|---|---|---|
${table(STEPS, stepRow)}

## Expected results

| # | The tester wrote | Reading | Why | Your verdict |
|---|---|---|---|---|
${table(EXPECTATIONS, expRow)}

## Two things in the cases themselves (not readings)

1. From TC12 on, step 13 (Reset) empties the form and step 14 saves it: the Save sends an empty form, so "User should see added data" cannot hold. The tester probably meant Reset to be its own case (TC11).
2. No step logs in, yet the tabs (step 4) show only after a login: the cases assume one. E0.16 turns these setup lines into one setup block that logs in.
`;
await writeFile(path.join(root, 'test/gold/orangehrm-add-employee.REVIEW.md'), review);
console.log('wrote test/gold/orangehrm-add-employee.REVIEW.md');
