import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { readWorkbook } from '../../importer/workbook.js';
import type { RawTestCase } from '../../model/test-model.js';
import {
  buildContexts,
  CredentialStore,
  canMove,
  classOfWords,
  compileCase,
  coverageOf,
  coverageText,
  DATA_CLASS_DEFS,
  fieldKindOf,
  generate,
  keyFromEnv,
  LIFECYCLE_STATES,
  maskSecrets,
  newKey,
  type ResolvedValue,
  redactProduction,
  resolveData,
  Secret,
  SOURCE_ORDER,
  scanForSecrets,
  seedOf,
  understandCase,
  understandLine,
  validateStates,
} from '../index.js';
import type { IrData } from '../ir/schema.js';
import { parseTestData, preflightOf, preflightReport, preflightText } from '../language/index.js';

/** E0.5 exit tests: context, references, states, data classes, the data resolver, the generator and data safety. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name: string): string => path.join(root, 'test', 'fixtures', name);
const raw = (over: Partial<RawTestCase> & { steps: string; expected: string }): RawTestCase => ({ id: 'T-1', title: 'A test case', ...over });
const load = (file: string): RawTestCase[] => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const loginCase = async (id: string): Promise<RawTestCase> => {
  const wb = await readWorkbook(fixture('OrangeHRM_Login_Test_Cases_Updated.xlsx'));
  return (wb.cases.find((c) => c.raw.id === id) as { raw: RawTestCase }).raw;
};
/** For assert.throws and assert.rejects: the error says this. */
const hasMessage =
  (text: string) =>
  (e: unknown): boolean =>
    e instanceof Error && e.message.includes(text);
const reveal = (v: ResolvedValue | undefined): string | undefined => (v === undefined ? undefined : typeof v.value === 'string' ? v.value : v.value.reveal());

describe('DR-01: the data resolver and its fixed order', () => {
  it('lists the sources in the documented order', () => {
    assert.deepEqual([...SOURCE_ORDER], ['EXCEL', 'ENV', 'CONFIG', 'STORE', 'FILE', 'GENERATOR', 'STEP', 'APPLICATION']);
  });

  it('TC_LOGIN_002 uses invaliduser and selenium exactly, and makes up nothing (the 5 Oct mistake)', async () => {
    const r = await compileCase(await loginCase('TC_LOGIN_002'));
    assert.equal(r.status, 'compiled');
    const username = r.values?.Username;
    const password = r.values?.Password;
    assert.deepEqual([username?.source, username?.class, reveal(username)], ['EXCEL', 'EXPLICIT', 'invaliduser']);
    assert.deepEqual([password?.source, password?.class, reveal(password)], ['EXCEL', 'EXPLICIT', 'selenium']);
    assert.ok(password?.value instanceof Secret, 'the password is a Secret');
    assert.ok(!Object.values(r.ir?.data ?? {}).some((d) => d.source === 'GENERATOR'), 'nothing was generated');
    assert.ok(!r.log.some((l) => l.message.includes('GENERATOR')));
    assert.deepEqual(r.ir?.data.Password, { class: 'EXPLICIT', source: 'EXCEL', secret: true, value: '***' }, 'and the document never holds it');
  });

  it('an EXPLICIT value always wins over everything else, whatever the other sources hold', async () => {
    const r = await compileCase(await loginCase('TC_LOGIN_002'), {
      env: { TEST_USERNAME: 'env_user', TEST_PASSWORD: 'env_pass', TEST_USERNAME_INVALID: 'env_invalid' },
      dataConfig: { 'username.valid': 'config_user', 'username.invalid': 'config_invalid', username: 'config_user' },
      dataFiles: { 'username.invalid': 'file_invalid' },
    });
    assert.equal(reveal(r.values?.Username), 'invaliduser');
    assert.equal(reveal(r.values?.Password), 'selenium');
    assert.equal(r.values?.Username?.source, 'EXCEL');
  });

  it('for a kind of value with no explicit one, the first source that has it wins, in order', async () => {
    const step = {
      id: 'S1',
      action: 'ENTER_VALUE',
      target: { ontology: 'Field', name: 'Nickname' },
      value: '$data.nickname_valid',
      original: 'Enter a valid nickname',
    } as const;
    const data = (): Record<string, IrData> => ({ nickname_valid: { class: 'VALID', source: 'UNRESOLVED' } });
    const base = { testId: 'T', excel: [], steps: [step] };
    const store = new CredentialStore(path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-e05-')), 'store.json'), newKey());
    await store.set('nickname.valid', 'from_store');

    const all = { ...base, env: { TEST_NICKNAME: 'from_env' }, config: { 'nickname.valid': 'from_config' }, store, files: { 'nickname.valid': 'from_file' } };
    assert.equal(
      reveal(
        (await resolveData(data(), { ...base, excel: parseTestData('Nickname: from_excel'), env: all.env, config: all.config, store, files: all.files })).values
          .nickname_valid,
      ),
      'from_excel',
    );
    assert.equal(reveal((await resolveData(data(), all)).values.nickname_valid), 'from_env');
    assert.equal(reveal((await resolveData(data(), { ...all, env: {} })).values.nickname_valid), 'from_config');
    assert.equal(reveal((await resolveData(data(), { ...all, env: {}, config: {} })).values.nickname_valid), 'from_store');
    assert.equal(reveal((await resolveData(data(), { ...all, env: {}, config: {}, store: undefined })).values.nickname_valid), 'from_file');
    const generated = (await resolveData(data(), base)).values.nickname_valid;
    assert.equal(generated?.source, 'GENERATOR', 'the generator is the last resort');
    assert.equal(generated?.rule, 'person.name');
  });

  it('never makes up a credential: a valid username or password with no source is asked for', async () => {
    const r = await compileCase(
      raw({ steps: '1. Open the Login page\n2. Enter valid username in the Login Name text box\n3. Click the Login button', expected: 'User is logged in' }),
      { env: {} },
    );
    assert.equal(r.status, 'needs-review');
    const issue = r.issues.find((i) => i.code === 'MISSING_DATA');
    assert.ok(issue?.message.includes('TEST_USERNAME is not set'), String(issue?.message));
    assert.ok(issue?.suggestion);
    assert.equal(Object.keys(r.values ?? {}).length, 0, 'no value was made up for it');
  });

  it('keeps an environment reference when no environment is given: it is read when the test runs', async () => {
    const r = await compileCase(
      raw({ steps: '1. Open the Login page\n2. Enter valid password in the Password text box\n3. Click the Login button', expected: 'User is logged in' }),
    );
    assert.equal(r.status, 'compiled');
    assert.deepEqual(r.ir?.data.test_password, { class: 'REFERENCE', source: 'ENV', value: '$env.TEST_PASSWORD', secret: true });
    const withEnv = await compileCase(
      raw({ steps: '1. Open the Login page\n2. Enter valid password in the Password text box\n3. Click the Login button', expected: 'User is logged in' }),
      { env: { TEST_PASSWORD: 'p4ss-word' } },
    );
    assert.equal(reveal(withEnv.values?.test_password), 'p4ss-word');
    assert.equal(withEnv.ir?.data.test_password?.value, '$env.TEST_PASSWORD', 'the document holds a reference, not the value');
    assert.ok(!JSON.stringify(withEnv).includes('p4ss-word'));
  });
});

describe('TD-01: data classes', () => {
  const SPEC = [
    'EXPLICIT',
    'VALID',
    'INVALID',
    'EMPTY',
    'BLANK',
    'MISSING',
    'NULL',
    'BOUNDARY',
    'MAXIMUM',
    'MINIMUM',
    'EXISTING',
    'NON_EXISTING',
    'DUPLICATE',
    'GENERATED',
    'RANDOM',
    'CREDENTIAL',
    'ENVIRONMENT',
  ];
  it('has the 17 classes of the specification, each with a meaning', () => {
    const names = DATA_CLASS_DEFS.map((d) => d.cls);
    for (const c of SPEC) assert.ok(names.includes(c as never), c);
    for (const d of DATA_CLASS_DEFS) assert.ok(d.meaning.length > 10, d.cls);
  });
  const value = (sentence: string, data = '') => {
    const r = understandLine(sentence, { data: parseTestData(data), facts: new Map(), mode: 'step' });
    return r.steps[0]?.value;
  };
  it('reads the right class from the text: blank, invalid, existing, maximum length', () => {
    assert.deepEqual(value('Leave the Login Name text box blank'), { kind: 'blank' });
    assert.deepEqual(value('Enter an invalid username in the Login Name text box'), { kind: 'class', dataClass: 'INVALID', field: 'username' });
    assert.deepEqual(value('Enter an existing user in the Username field'), { kind: 'class', dataClass: 'EXISTING', field: 'user' });
    assert.deepEqual(value('Enter a max length username in the Login Name text box'), { kind: 'class', dataClass: 'MAXIMUM', field: 'username' });
    assert.equal((value('Enter a minimum value in the Age field') as { dataClass: string }).dataClass, 'MINIMUM');
    assert.equal((value('Enter a boundary value in the Age field') as { dataClass: string }).dataClass, 'BOUNDARY');
    assert.equal((value('Enter a duplicate email in the Email field') as { dataClass: string }).dataClass, 'DUPLICATE');
    assert.equal((value('Enter a random name in the Name field') as { dataClass: string }).dataClass, 'RANDOM');
    assert.equal((value('Enter a non-existing user in the Username field') as { dataClass: string }).dataClass, 'NON_EXISTING');
    assert.equal((value('Enter an empty string in the Name field') as { dataClass: string }).dataClass, 'EMPTY');
    assert.deepEqual(classOfWords(['max', 'length', 'username']), { cls: 'MAXIMUM', at: [0, 1] });
  });
  it('`Username: cypress` is EXPLICIT; with a word like "invalid" it keeps the kind that was asked for', async () => {
    const l = understandCase(
      raw({
        steps: '1. Open the Login page\n2. Enter invalid username in the Login Name text box\n3. Click the Login button',
        testData: 'Username: invaliduser',
        expected: 'Login is rejected',
      }),
    );
    assert.deepEqual(l.ir?.data.Username, { class: 'EXPLICIT', source: 'EXCEL', value: 'invaliduser', intent: 'INVALID' });
    const plain = understandCase(
      raw({
        steps: '1. Open the Login page\n2. Enter username in the Login Name text box\n3. Click the Login button',
        testData: 'Username: cypress',
        expected: 'Login is rejected',
      }),
    );
    assert.deepEqual(plain.ir?.data.Username, { class: 'EXPLICIT', source: 'EXCEL', value: 'cypress' });
  });
  it('shows the class in the document: BLANK for "leave blank"', async () => {
    const r = await compileCase(await loginCase('TC_LOGIN_005'));
    const blank = Object.values(r.ir?.data ?? {}).find((d) => d.class === 'BLANK');
    assert.deepEqual(blank, { class: 'BLANK', source: 'EXCEL', value: '' });
  });
  it('settles the kinds a generator can make: invalid, maximum length, minimum, random, non-existing; and keeps the class asked for', async () => {
    const r = await compileCase(
      raw({
        steps: [
          '1. Open the Application',
          '2. Enter an invalid email in the Email field',
          '3. Enter a max length name in the Name field',
          '4. Enter a minimum value in the Age field',
          '5. Enter a random value in the Notes field',
          '6. Enter a non-existing user in the Account field',
        ].join('\n'),
        expected: 'An error message is displayed',
      }),
      { maxLengths: { Name: 30 } },
    );
    const byIntent = (cls: string) => Object.values(r.ir?.data ?? {}).find((d) => d.intent === cls);
    assert.equal(byIntent('INVALID')?.rule, 'invalid.email');
    assert.equal(byIntent('MAXIMUM')?.rule, 'long.string(30)');
    assert.equal(reveal(r.values?.name_maximum)?.length, 30, 'the limit of the field is used when it is known');
    assert.equal(byIntent('MINIMUM')?.rule, 'short.string(1)');
    assert.equal(byIntent('RANDOM')?.rule, 'random.string(8)');
    assert.equal(byIntent('NON_EXISTING')?.rule, 'nonexistent.name');
    assert.ok(Object.values(r.ir?.data ?? {}).every((d) => d.class === 'GENERATED' && d.source === 'GENERATOR'));
  });
  it('asks for an existing value: only the application knows it', async () => {
    const r = await compileCase(
      raw({ steps: '1. Open the Application\n2. Enter an existing user in the Account field', expected: 'An error message is displayed' }),
    );
    const issue = r.issues.find((i) => i.code === 'MISSING_DATA');
    assert.ok(issue?.message.includes('already has'), String(issue?.message));
  });
  it('infers what a field is for from its name', () => {
    const kinds: Record<string, string> = {
      'Login Name': 'username',
      Password: 'password',
      'Email Address': 'email',
      'First name': 'personName',
      'code/id': 'code',
      'Phone number': 'phone',
      'Date of birth': 'date',
      Photo: 'file',
      Notes: 'text',
      Age: 'number',
    };
    for (const [name, kind] of Object.entries(kinds)) assert.equal(fieldKindOf(name), kind, name);
  });
});

describe('DG-01: the deterministic generator', () => {
  const KINDS = ['username', 'password', 'email', 'personName', 'number', 'code', 'phone', 'date', 'file', 'text'] as const;
  const CLASSES = ['VALID', 'INVALID', 'MAXIMUM', 'MINIMUM', 'BOUNDARY', 'RANDOM', 'NON_EXISTING', 'GENERATED', 'BLANK'] as const;
  it('gives the same value for the same seed, on every call, for every class and kind', () => {
    for (const kind of KINDS) {
      for (const cls of CLASSES) {
        const seed = seedOf('TC-1', 'S3', 'run-1', `${kind}${cls}`);
        assert.deepEqual(generate(cls, kind, seed), generate(cls, kind, seed), `${cls} ${kind}`);
      }
    }
  });
  it('gives different values for different seeds: another step, another test, another run', () => {
    const base = generate('VALID', 'email', seedOf('TC-1', 'S3', 'run-1')).value;
    assert.notEqual(base, generate('VALID', 'email', seedOf('TC-1', 'S4', 'run-1')).value);
    assert.notEqual(base, generate('VALID', 'email', seedOf('TC-2', 'S3', 'run-1')).value);
    assert.notEqual(base, generate('VALID', 'email', seedOf('TC-1', 'S3', 'run-2')).value);
    assert.equal(seedOf('TC-1', 'S3', 'run-1'), seedOf('TC-1', 'S3', 'run-1'));
  });
  it('depends on nothing but the seed: not the clock, not the machine', () => {
    const realNow = Date.now;
    const seed = seedOf('TC-1', 'S1');
    const a = generate('VALID', 'date', seed).value;
    Date.now = () => 4_102_444_800_000;
    const b = generate('VALID', 'date', seed).value;
    Date.now = realNow;
    assert.equal(a, b);
    assert.ok(a >= '2024-02-21' && a <= '2025-02-21', 'dates are counted from a fixed day, never from today');
  });
  it('makes values that suit the kind', () => {
    const v = (cls: (typeof CLASSES)[number], kind: (typeof KINDS)[number]) => generate(cls, kind, seedOf('T', 'S1', 'r', `${cls}${kind}`));
    assert.ok(v('VALID', 'email').value.includes('@'));
    assert.ok(v('INVALID', 'email').value.includes('@') === false);
    assert.ok(Array.from(v('VALID', 'number').value).every((c) => c >= '0' && c <= '9'));
    assert.ok(
      Array.from(v('VALID', 'personName').value).every((c) => c.toLowerCase() !== c.toUpperCase()),
      'a name has letters only',
    );
    assert.equal(v('MAXIMUM', 'text').value.length, 255);
    assert.equal(v('BOUNDARY', 'text').value.length, 256);
    assert.equal(v('BLANK', 'text').value, '');
    assert.equal(v('VALID', 'password').secret, true);
    assert.throws(() => generate('EXISTING', 'username', 'ab'.repeat(8)), hasMessage('no generator'));
  });
  it('logs every generated value with its rule and seed, and never the value of a secret', async () => {
    const c = raw({
      id: 'TC-G',
      steps:
        '1. Open the Application\n2. Enter valid First name in the First name field\n3. Enter valid code in the Code field\n4. Enter a random password in the Password field',
      expected: 'An error message is displayed',
    });
    const r = await compileCase(c);
    const logged = r.log.filter((l) => l.stage === 'ResolveData' && l.data && 'rule' in l.data);
    assert.equal(logged.length, 3);
    for (const l of logged) {
      assert.ok(l.message.includes('rule '), l.message);
      assert.equal(typeof l.data?.seed, 'string');
    }
    const name = r.values?.First_name_valid;
    assert.ok(reveal(name));
    assert.ok(logged.some((l) => l.message.includes('First_name_valid') && l.message.includes('person.name')));
    assert.ok(!JSON.stringify(r.log).includes(`"${reveal(name)}"`), 'the value is in the values; the log holds the rule and the seed');
    const password = r.values?.password_random;
    assert.ok(password?.value instanceof Secret);
    assert.ok(!JSON.stringify(r).includes(reveal(password) as string), 'a generated secret is never written');
    // The same run gives the same values; another run gives others.
    const again = await compileCase(c);
    assert.equal(reveal(again.values?.First_name_valid), reveal(name));
    const other = await compileCase(c, { run: 'run-2' });
    assert.notEqual(reveal(other.values?.First_name_valid), reveal(name));
    assert.equal(JSON.stringify(again.log), JSON.stringify(r.log), 'and the decision log is identical');
  });
});

describe('RF-01: reference resolution', () => {
  const steps = (...lines: string[]): string => lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const read = (lines: string[], expected = 'The Login page is displayed') => understandCase(raw({ steps: steps(...lines), expected }));

  it('"it": the target of the step before', () => {
    const l = read(['Open the Login page', "Click the 'Save' button", 'Click it again']);
    assert.deepEqual(l.ir?.steps[2]?.target, l.ir?.steps[1]?.target);
    assert.equal(l.ir?.steps[2]?.target?.name, 'Save');
    const ref = l.ir?.references[0];
    assert.deepEqual([ref?.kind, ref?.status, ref?.steps], ['PREVIOUS_TARGET', 'RESOLVED', ['S2']]);
    assert.ok(!l.issues.some((i) => i.code === 'NEEDS_REFERENCE'), 'a resolved reference is no longer a question');
  });
  it('"the same field": the field used last', () => {
    const l = read(['Open the Login page', "Enter 'abc' in the Email field", 'Clear the same field']);
    assert.equal(l.ir?.steps[2]?.action, 'CLEAR');
    assert.equal(l.ir?.steps[2]?.target?.name, 'Email');
    assert.deepEqual(l.ir?.references[0]?.steps, ['S2']);
  });
  it('"the same value": the value entered last', () => {
    const l = read(['Open the Login page', "Enter 'John' in the First name field", 'Enter the same value in the Last name field']);
    assert.equal(l.ir?.steps[2]?.value, 'John');
    assert.equal(l.ir?.references[0]?.kind, 'PREVIOUS_VALUE');
  });
  it('"same username": the earlier step that acted on it', () => {
    const l = read(
      ['Open the Login page', 'Enter username in the Login Name text box', 'Click the Login button', 'Clear the same Login Name'],
      'The Login page is displayed',
    );
    assert.ok(
      l.ir?.references.some((r) => r.status === 'RESOLVED' && r.steps.includes('S2')),
      JSON.stringify(l.ir?.references),
    );
  });
  it('Add_Employee TC18: "checking the same updated records" is what was entered in the steps before the Save', async () => {
    const wb = await readWorkbook(fixture('Add_Employee.xlsx'));
    const tc18 = (wb.cases.find((c) => c.raw.id === '21022024_18') as { raw: RawTestCase }).raw;
    const l = understandCase(tc18);
    const ref = l.ir?.references.find((r) => r.phrase.includes('same updated records'));
    assert.equal(ref?.status, 'RESOLVED');
    assert.deepEqual(ref?.steps, ['S35', 'S35.2', 'S35.3', 'S35.4'], 'the four fields entered in step 35, saved by step 37');
    assert.ok(ref?.because.includes('saved by S37'));
    // The sentence also stands in the expected result; the one of step 39 is the one asked about.
    const checks = l.ir?.expectations.filter((e) => e.clause.startsWith('checking the same updated records')) ?? [];
    assert.equal(checks.length, 4, 'one check for each field');
    assert.deepEqual(
      checks.map((c) => c.condition.target?.name),
      ['Job Title', 'Employement Status', 'Sub-Division', 'Supervisor'],
    );
    for (const c of checks) assert.ok(c.condition.expect?.startsWith('$data.'), 'each field holds what was entered');
    assert.ok(!l.issues.some((i) => i.code === 'NEEDS_REFERENCE' && i.original.includes('same updated records')));
  });
  it('a check after each field is about the field before it, and one step that fills several fields is about all of them', async () => {
    const wb = await readWorkbook(fixture('Add_Employee.xlsx'));
    const tc18 = (wb.cases.find((c) => c.raw.id === '21022024_18') as { raw: RawTestCase }).raw;
    const l = understandCase(tc18);
    const accepts = (l.ir?.expectations ?? []).filter((e) => e.clause.includes('Text box should accept values'));
    assert.deepEqual(
      accepts.map((e) => e.afterStep),
      ['S13', 'S15', 'S17', 'S19', 'S21'],
      'each repeated sentence is resolved on its own',
    );
    const fields = (l.ir?.expectations ?? []).filter((e) => e.clause.includes('Respective fileds should accept the values'));
    assert.equal(fields.length, 4);
  });
  it('never guesses: nothing before "it" → the reference stays a question and the step is left as written', () => {
    const l = read(['Click it', 'Open the Login page']);
    assert.equal(l.ir?.steps[0]?.target?.name, 'it');
    assert.ok(l.issues.some((i) => i.code === 'NEEDS_REFERENCE' && i.severity === 'review'));
    assert.equal(l.ir?.references[0]?.status, 'UNRESOLVED');
  });
  it('never guesses: "above", "corresponding", "newly opened" need the page, so they stay questions', () => {
    const l = read(['Open the Login page', "Enter 'x' in the above field"]);
    assert.ok(l.issues.some((i) => i.code === 'NEEDS_REFERENCE'));
    assert.equal(l.ir?.references[0]?.status, 'UNRESOLVED');
    assert.ok(l.ir?.references[0]?.because.includes('page'));
  });
  it('never guesses: "added data" with no Save before it, or a reset in between, is not resolved', async () => {
    const none = read(['Open the Login page', "Enter 'a' in the Email field"], 'The added data is displayed');
    assert.equal(none.ir?.references.find((r) => r.kind === 'ENTERED_DATA')?.status, 'UNRESOLVED');
    assert.ok(none.issues.some((i) => i.code === 'NEEDS_REFERENCE'));
    const wb = await readWorkbook(fixture('Add_Employee.xlsx'));
    const tc13 = (wb.cases.find((c) => c.raw.id === '21022024_13') as { raw: RawTestCase }).raw;
    const l = understandCase(tc13);
    const added = l.ir?.references.find((r) => r.phrase.includes('added data'));
    assert.equal(added?.status, 'UNRESOLVED');
    assert.ok(added?.because.includes('may have emptied'), added?.because);
  });
  it('keeps the checks of a conditional pointing at the right expectations after one check became several', () => {
    const l = understandCase(
      raw({
        steps: steps('Open the Login page', "Enter 'a' in the Email field", "Enter 'b' in the Name field", "Click the 'Save' button"),
        expected: 'The added data is displayed. If the Email field is empty, an error message is displayed',
      }),
    );
    for (const c of l.ir?.conditionals ?? [])
      for (const id of [...c.whenTrue, ...c.whenFalse])
        assert.ok(
          l.ir?.expectations.some((e) => e.id === id),
          `${c.id} → ${id}`,
        );
    const ids = (l.ir?.expectations ?? []).map((e) => e.id);
    assert.deepEqual(
      ids,
      ids.map((_, i) => `E${i + 1}`),
    );
  });
});

describe('CX-01 to CX-10: the context engine', () => {
  it('knows what the test case has done at every step', () => {
    const l = understandCase(
      raw({
        steps: [
          '1. Open the Login page',
          '2. Enter username in the Login Name text box',
          '3. Enter password in the Password text box',
          "4. Click the 'Login' button",
          '5. Verify the user is logged in',
          '6. Open the Employee page',
          "7. Enter 'John' in the First name field",
          '8. Click the Save button',
        ].join('\n'),
        testData: 'Username: cypress\nPassword: selenium',
        expected: 'User is logged in',
      }),
    );
    const ir = l.ir;
    assert.ok(ir);
    const contexts = buildContexts(ir.testCase.id, ir.steps, ir.expectations);
    const at = (id: string) => contexts.get(id);
    assert.equal(at('S1')?.previousStep, undefined, 'CX-01: nothing before the first step');
    assert.equal(at('S4')?.previousStep?.id, 'S3', 'CX-01: the step before');
    assert.equal(at('S4')?.previousTarget?.name, 'Password', 'CX-02: what the step before acted on');
    assert.equal(at('S4')?.previousValue, '$data.Password', 'CX-03: the last value entered');
    assert.equal(at('S3')?.page, 'Login', 'CX-04: the page the test case is on');
    assert.equal(at('S7')?.page, 'Employee');
    assert.equal(at('S6')?.authentication.loggedIn, true, 'CX-10: logged in after the login check');
    assert.equal(at('S3')?.authentication.loggedIn, false);
    assert.equal(at('S3')?.user, 'Username', 'CX-07: who is logging in');
    assert.equal(at('S8')?.testId, ir.testCase.id, 'CX-08: the test');
    assert.deepEqual(at('S8')?.variables, ['Username', 'Password'], 'CX-09: the data the steps have used');
    assert.equal(at('S8')?.entered.length, 3, 'what was entered so far');
  });
  it('CX-05, CX-06: a form and a dialog that are open', () => {
    const steps = [
      { id: 'S1', action: 'NAVIGATE', target: { ontology: 'Page', name: 'Employees' }, original: 'Open Employees' },
      { id: 'S2', action: 'ENTER_VALUE', target: { ontology: 'Field', name: 'Name', within: 'Add Employee form' }, value: 'x', original: 'Enter x in Name' },
      { id: 'S3', action: 'CLICK', target: { ontology: 'Modal', name: 'Confirm' }, original: 'Click Confirm dialog' },
      { id: 'S4', action: 'CLOSE', target: { ontology: 'Modal', name: 'Confirm' }, original: 'Close the dialog' },
      { id: 'S5', action: 'CLICK', target: { ontology: 'Button', name: 'Save' }, original: 'Click Save' },
    ] as never;
    const c = buildContexts('T', steps, []);
    assert.equal(c.get('S3')?.form, 'Add Employee form');
    assert.equal(c.get('S4')?.modal, 'Confirm');
    assert.equal(c.get('S5')?.modal, undefined, 'the dialog was closed');
    assert.equal(c.get('S5')?.form, 'Add Employee form');
  });
  it('knows a precondition: logged in before the first step', () => {
    const c = buildContexts('T', [{ id: 'S1', action: 'CLICK', target: { ontology: 'Button', name: 'X' }, original: 'Click X' }] as never, [], {
      loggedIn: true,
      user: 'admin',
    });
    assert.equal(c.get('S1')?.authentication.loggedIn, true);
    assert.equal(c.get('S1')?.user, 'admin');
  });
});

describe('ST-01, ST-02: the test state machine', () => {
  it('has the ten lifecycle states of the specification', () => {
    assert.deepEqual(
      [...LIFECYCLE_STATES],
      [
        'APPLICATION_STARTED',
        'LOGIN_PAGE',
        'USERNAME_ENTERED',
        'PASSWORD_ENTERED',
        'LOGIN_SUBMITTED',
        'LOGIN_SUCCESS',
        'LOGIN_FAILED',
        'DASHBOARD',
        'ERROR_DISPLAYED',
        'LOGGED_OUT',
      ],
    );
  });
  it('records the state each step is expected to leave the application in', () => {
    const ir = understandCase(
      raw({
        steps: "1. Open the Login page\n2. Enter username in the Login Name text box\n3. Enter password in the Password text box\n4. Click the 'Login' button",
        expected: 'User is successfully logged in and redirected to the OrangeHRM home/dashboard page.',
      }),
    ).ir;
    assert.deepEqual(
      ir?.steps.map((s) => s.expectedState),
      ['LOGIN_PAGE', 'USERNAME_ENTERED', 'PASSWORD_ENTERED', 'LOGIN_SUBMITTED'],
    );
  });
  it('flags an impossible move at compile time: LOGIN_SUCCESS without LOGIN_SUBMITTED', async () => {
    const r = await compileCase(
      raw({ steps: '1. Open the Login page\n2. Enter username in the Login Name text box', expected: 'User is successfully logged in' }),
    );
    const issue = r.issues.find((i) => i.code === 'PARADOX');
    assert.ok(issue, JSON.stringify(r.issues));
    assert.equal(issue.severity, 'blocking');
    assert.ok(issue.message.includes('LOGIN_SUCCESS cannot follow USERNAME_ENTERED'), issue.message);
    assert.ok(issue.message.includes('never submitted'));
    assert.equal(r.status, 'needs-review');
    assert.equal(r.stage, 'Validate', 'stopped before anything could run');
    assert.equal(r.plan, undefined);
  });
  it('flags the dashboard without a login, and a login form filled after the user is in', async () => {
    const noLogin = await compileCase(
      raw({ steps: '1. Open the Application\n2. Click the Reports link', expected: 'User is redirected to the Dashboard page' }),
    );
    assert.ok(
      noLogin.issues.some((i) => i.code === 'PARADOX' && i.message.includes('DASHBOARD')),
      JSON.stringify(noLogin.issues),
    );
    const already = validateStates(
      understandCase(raw({ steps: '1. Open the Login page\n2. Click the Login button', expected: 'User is logged in' })).ir?.steps as never,
      [{ id: 'E1', clause: 'in', negated: false, condition: { type: 'AUTHENTICATION', expect: 'LOGGED_IN' }, afterStep: 'S2' }] as never,
    );
    assert.deepEqual(already.issues, []);
  });
  it('accepts every flow of the real workbooks and the examples: no false alarm', async () => {
    const login = (await readWorkbook(fixture('OrangeHRM_Login_Test_Cases_Updated.xlsx'))).cases.map((c) => c.raw);
    const employee = (await readWorkbook(fixture('Add_Employee.xlsx'))).cases.map((c) => c.raw);
    const examples = ['examples/test-cases.json', 'examples/demo-app/test-cases.json', 'examples/real-world/login-cases.json'].flatMap(load);
    for (const c of [...login, ...employee, ...examples]) {
      const paradox = understandCase(c).issues.filter((i) => i.code === 'PARADOX');
      assert.deepEqual(paradox, [], String(c.id));
    }
  });
  it('knows what may follow what', () => {
    assert.ok(canMove('LOGIN_SUBMITTED', 'LOGIN_SUCCESS'));
    assert.ok(canMove('LOGIN_SUBMITTED', 'LOGIN_FAILED'));
    assert.ok(!canMove('APPLICATION_STARTED', 'LOGIN_SUCCESS'));
    assert.ok(!canMove('LOGGED_OUT', 'DASHBOARD'));
    assert.ok(!canMove('DASHBOARD', 'USERNAME_ENTERED'));
    assert.ok(canMove('DASHBOARD', 'DASHBOARD'), 'a state may repeat');
  });
});

describe('DS-01 to DS-04: data safety', () => {
  it('DS-02: a Secret cannot be written by accident', () => {
    const s = new Secret('hunter2-value');
    assert.equal(String(s), '***');
    assert.equal(`${s}`, '***');
    assert.equal(JSON.stringify({ s }), '{"s":"***"}');
    assert.equal(inspect(s), 'Secret(***)');
    assert.equal(s.reveal(), 'hunter2-value');
  });
  it('DS-02: masks secrets in text, longest first', () => {
    assert.equal(maskSecrets('login with abc123 and abc', ['abc', 'abc123']), 'login with •••• and ••••');
    assert.equal(maskSecrets('nothing here', ['x-secret']), 'nothing here');
  });
  it('DS-01: removes production identifiers that are configured, and says how many', () => {
    const r = redactProduction('customer CUST-123456 paid, then CUST-999999 refunded', [{ name: 'customer', source: 'CUST-\\d{6}' }]);
    assert.equal(r.text, 'customer [redacted] paid, then [redacted] refunded');
    assert.equal(r.redacted, 2);
    assert.throws(() => redactProduction('x', [{ name: 'broken', source: '(' }]), hasMessage('broken'));
  });
  it('DS-01: a production identifier in a test case appears in no output of the compile', async () => {
    const c = raw({
      steps: '1. Open the Login page\n2. Click the Save button for account ACCT-445566',
      expected: 'The message "Saved ACCT-445566" is displayed',
    });
    const plain = JSON.stringify(await compileCase(c));
    assert.ok(plain.includes('ACCT-445566'), 'it is in the text of the test case');
    const clean = JSON.stringify(await compileCase(c, { productionPatterns: [{ name: 'account', source: 'ACCT-\\d{6}' }] }));
    assert.ok(!clean.includes('ACCT-445566'));
    assert.ok(clean.includes('[redacted]'));
  });
  it('DS-04: the credential store is encrypted at rest, with the key outside it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-store-'));
    const file = path.join(dir, 'credentials.json');
    const key = newKey();
    const store = new CredentialStore(file, key);
    await store.set('password.valid', 'Tr0ub4dor&3-not-in-file');
    await store.set('username.valid', 'qa_admin');
    assert.equal((await store.get('password.valid'))?.reveal(), 'Tr0ub4dor&3-not-in-file');
    assert.equal(await store.get('nothing.here'), undefined);
    assert.deepEqual(await store.names(), ['password.valid', 'username.valid']);
    const onDisk = await readFile(file, 'utf8');
    for (const plain of ['Tr0ub4dor&3-not-in-file', 'qa_admin']) assert.ok(!onDisk.includes(plain), 'no clear text in the file');
    assert.ok(!onDisk.includes(key.toString('base64')), 'the key is not in the store');
    // A new random IV each time: the same value does not give the same bytes.
    await store.set('again', 'qa_admin');
    const entries = JSON.parse(await readFile(file, 'utf8')).entries;
    assert.notEqual(entries.again.data, entries['username.valid'].data);
    // The wrong key, a changed file, and an entry moved under another name do not open.
    await assert.rejects(() => new CredentialStore(file, newKey()).get('password.valid'), hasMessage('cannot be opened'));
    const moved = JSON.parse(onDisk);
    moved.entries['username.other'] = moved.entries['username.valid'];
    const movedFile = path.join(dir, 'moved.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(movedFile, JSON.stringify(moved)));
    await assert.rejects(() => new CredentialStore(movedFile, key).get('username.other'), hasMessage('cannot be opened'));
    assert.throws(() => new CredentialStore(file, Buffer.alloc(16)), hasMessage('32 bytes'));
  });
  it('DS-04: the key comes from the environment, 32 bytes in base64', () => {
    const key = newKey();
    assert.deepEqual(keyFromEnv({ AUTO_QA_KEY: key.toString('base64') }), key);
    assert.throws(() => keyFromEnv({}), hasMessage('AUTO_QA_KEY is not set'));
    assert.throws(() => keyFromEnv({ AUTO_QA_KEY: Buffer.alloc(8).toString('base64') }), hasMessage('32 bytes'));
  });
  it('DR-01 and DS-04 together: a value from the store reaches the run and is never written', async () => {
    const store = new CredentialStore(path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-store-')), 's.json'), newKey());
    await store.set('password.valid', 'FromTheStore-777');
    const r = await compileCase(
      raw({ steps: '1. Open the Login page\n2. Enter valid password in the Password text box\n3. Click the Login button', expected: 'User is logged in' }),
      { env: {}, store },
    );
    assert.equal(reveal(r.values?.test_password) ?? reveal(r.values?.password_valid), 'FromTheStore-777');
    assert.ok(!JSON.stringify(r).includes('FromTheStore-777'));
  });

  it('DS-03: a scan of every output of a run of all fixtures finds no secret', async () => {
    const login = (await readWorkbook(fixture('OrangeHRM_Login_Test_Cases_Updated.xlsx'))).cases.map((c) => c.raw);
    const employee = (await readWorkbook(fixture('Add_Employee.xlsx'))).cases.map((c) => c.raw);
    const examples = ['examples/test-cases.json', 'examples/demo-app/test-cases.json', 'examples/real-world/login-cases.json'].flatMap(load);
    const typed = raw({
      id: 'TC-TYPED',
      steps: "1. Open the Login page\n2. Enter 'hunter2-typed' in the Password text box\n3. Click the Login button",
      expected: 'Login is rejected',
    });
    const generated = raw({
      id: 'TC-GEN',
      steps: '1. Open the Application\n2. Enter an invalid password in the Password field',
      expected: 'An error message is displayed',
    });
    const env = { TEST_USERNAME: 'env_user_name', TEST_PASSWORD: 'Env-P@ss-9931' };
    const outputs: Record<string, string> = {};
    const secrets = new Set<string>(['selenium', 'wrongpassword', 'Env-P@ss-9931', 'hunter2-typed']);
    const results = [];
    for (const c of [...login, ...employee, ...examples, typed, generated]) {
      const r = await compileCase(c, { env });
      results.push(r);
      outputs[`${c.id}`] = JSON.stringify({ ...r });
      // Every secret the engine resolved is also searched for.
      for (const v of Object.values(r.values ?? {})) if (v.value instanceof Secret && v.value.reveal().length >= 3) secrets.add(v.value.reveal());
    }
    const compact = results.map((r, i) => preflightOf(`case ${i}`, r));
    outputs.preflight = preflightText(preflightReport(compact), { all: true });
    outputs.coverage = coverageText('all', coverageOf(results));
    assert.ok(secrets.size >= 5, 'the scan searches for the passwords of the sheet, the environment, a typed one and generated ones');
    const { findings, skipped } = scanForSecrets(outputs, [...secrets]);
    assert.deepEqual(findings, []);
    assert.deepEqual(skipped, []);
    assert.ok(Object.keys(outputs).length > 40, 'a lot of output was scanned');
    // The scan itself works: it finds a secret that is there.
    assert.equal(scanForSecrets({ x: 'the password is selenium' }, ['selenium']).findings.length, 1);
  });
});

describe('E0.5 progress against E0.4 (T6)', () => {
  it('records its numbers and shows the review reasons the new layers removed', async () => {
    const e04 = JSON.parse(readFileSync(path.join(root, 'test', 'baseline', 'e04-t6.json'), 'utf8')).workbooks['Add_Employee.xlsx'];
    const file = path.join(root, 'test', 'baseline', 'e05-t6.json');
    assert.ok(existsSync(file), 'run: npm run engine:report -- --write');
    const e05 = JSON.parse(readFileSync(file, 'utf8')).workbooks['Add_Employee.xlsx'];
    const count = (w: { topReasons: Array<{ reason: string; count: number }> }, start: string) =>
      w.topReasons.filter((r) => r.reason.startsWith(start)).reduce((n, r) => n + r.count, 0);
    assert.ok(count(e04, 'missing data') >= 80);
    assert.ok(count(e05, 'missing data') <= 10, 'the generator settles what it can make; a file to upload still has to be given');
    assert.ok(count(e04, 'unresolved reference') >= 90);
    assert.ok(count(e05, 'unresolved reference') < count(e04, 'unresolved reference') / 2, 'references are resolved from what the test case did');
    assert.ok(e05.steps.understood >= e04.steps.understood * 0.9);
  });
});
