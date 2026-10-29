import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { compileCase, type ExecutionSession, executePlan, isSecret, judge, openExecutionSession, planActions, Secret } from '../engine/index.js';
import { readWorkbook } from '../importer/workbook.js';
import type { RawTestCase } from '../model/test-model.js';
import { parseTestCase } from '../parser/index.js';
import { engineInputOf } from '../parser/original.js';

/**
 * E0.12 (S4): the engine reads the test case the tester wrote, not the masked copy the model keeps for storage. The bug these guard:
 * the product gave the engine `Password: ••••`, and the engine typed four bullet characters, so a valid login failed on the real site
 * while every test passed, because the tests handed the engine the raw sheet and the product never does. These tests go through the
 * product's own path: the parser's model first, then what the engine is given, then the compile and the run.
 */

const fixture = (name: string) => path.join(process.cwd(), 'test', 'fixtures', name);
const sheet = async (name: string): Promise<RawTestCase[]> => (await readWorkbook(fixture(name))).cases.map((c) => c.raw);

/** The password a sheet's Test Data gives, or undefined. */
const passwordOf = (testData?: string): string | undefined => {
  const value = /(?:^|\n)\s*password\s*[:=]\s*(.+)/i.exec(testData ?? '')?.[1]?.trim();
  // "Blank" and "empty" say the field is left empty: they are not a password.
  return value && !['blank', 'empty'].includes(value.toLowerCase()) ? value : undefined;
};
const secretOf = (r: { values?: Record<string, { field: string; value: unknown }> }, field: string): string | undefined => {
  const v = Object.values(r.values ?? {}).find((x) => x.field.toLowerCase() === field);
  return isSecret(v?.value) ? v.value.reveal() : typeof v?.value === 'string' ? v.value : undefined;
};

describe('what the engine is given is what the tester wrote', () => {
  it('for every real case, the engine gets the original test data and steps; the stored model keeps them masked', async () => {
    const all = [...(await sheet('OrangeHRM_Login_Test_Cases_Updated.xlsx')), ...(await sheet('Add_Employee.xlsx'))];
    assert.ok(all.length >= 29);
    let withPassword = 0;
    for (const raw of all) {
      const model = parseTestCase(raw);
      const input = engineInputOf(model);
      assert.equal(input.fromOriginal, true, `${raw.id}: the original is kept beside the model`);
      assert.equal(input.raw.testData, raw.testData, `${raw.id}: the test data is as written`);
      assert.equal(input.raw.steps, raw.steps, `${raw.id}: the steps are as written`);
      const secret = passwordOf(raw.testData);
      if (!secret) continue;
      withPassword++;
      // The model is made to be stored and shown: no secret in it, in any field (FR-EV-03).
      assert.ok(!JSON.stringify(model).includes(secret), `${raw.id}: the model holds the password`);
      assert.ok(model.source.rawTestData?.includes('••••'), `${raw.id}: the stored test data shows a mask`);
    }
    assert.ok(withPassword >= 5, `${withPassword} cases with a password`);
  });

  it('the original is not part of the model: it is not stored, not exported, not in the JSON', async () => {
    const [raw] = await sheet('OrangeHRM_Login_Test_Cases_Updated.xlsx');
    const model = parseTestCase(raw as RawTestCase);
    const clone = JSON.parse(JSON.stringify(model));
    assert.deepEqual(clone, JSON.parse(JSON.stringify(model)));
    assert.equal(engineInputOf(clone).fromOriginal, false, 'a model read back from storage has no original');
  });

  it("TC_LOGIN_001 types the sheet's password, and TC_LOGIN_003 (a wrong password on purpose) types its own, which is not the valid one", async () => {
    const cases = await sheet('OrangeHRM_Login_Test_Cases_Updated.xlsx');
    const compile = (id: string) =>
      compileCase(engineInputOf(parseTestCase(cases.find((c) => c.id === id) as RawTestCase)).raw, { env: { TEST_PASSWORD: 'the-projects-password' } });
    const valid = await compile('TC_LOGIN_001');
    const wrong = await compile('TC_LOGIN_003');
    const validPassword = secretOf(valid, 'password');
    const wrongPassword = secretOf(wrong, 'password');
    assert.equal(validPassword, passwordOf(cases.find((c) => c.id === 'TC_LOGIN_001')?.testData), "the valid login uses the sheet's value");
    assert.equal(wrongPassword, passwordOf(cases.find((c) => c.id === 'TC_LOGIN_003')?.testData), 'the wrong-password test uses its own value');
    assert.notEqual(wrongPassword, validPassword, 'the wrong-password test must not log in with the valid password (S4)');
    assert.notEqual(wrongPassword, 'the-projects-password', 'nor with the one the project sets');
    assert.ok(valid.ir && valid.plan && wrong.ir && wrong.plan);
  });

  it('what the engine writes about the case holds no secret: the compile, its log and its document', async () => {
    const cases = await sheet('OrangeHRM_Login_Test_Cases_Updated.xlsx');
    for (const raw of cases) {
      const secret = passwordOf(raw.testData);
      if (!secret) continue;
      const result = await compileCase(engineInputOf(parseTestCase(raw)).raw, { env: {} });
      assert.ok(!JSON.stringify(result).includes(secret), `${raw.id}: the compile result holds the password`);
    }
  });

  it('a model without its original is not run on its masked text: the password is "not there", never four bullets', async () => {
    const [raw] = (await sheet('OrangeHRM_Login_Test_Cases_Updated.xlsx')).filter((c) => c.id === 'TC_LOGIN_001');
    const stored = JSON.parse(JSON.stringify(parseTestCase(raw as RawTestCase)));
    const input = engineInputOf(stored);
    assert.equal(input.fromOriginal, false);
    const result = await compileCase(input.raw, { env: {} });
    const typed = secretOf(result, 'password');
    assert.notEqual(typed, '••••', 'the mask is never a value');
    assert.equal(typed, undefined, 'there is no password to type');
    assert.ok(
      result.issues.some((i) => i.message.includes('mask')),
      JSON.stringify(result.issues.map((i) => i.message)),
    );
  });

  it('a value that is only a mask is refused wherever it comes from', async () => {
    for (const mask of ['••••', '****', '●●●●']) {
      const result = await compileCase(
        {
          id: 'T',
          title: 'T',
          steps: '1. Open the Login page\n2. Enter password in the Password text box',
          expected: 'The Login page is displayed',
          testData: `Password: ${mask}`,
        },
        { env: {} },
      );
      assert.equal(secretOf(result, 'password'), undefined, mask);
    }
    // A password that merely contains such characters is a password.
    const real = await compileCase(
      {
        id: 'T',
        title: 'T',
        steps: '1. Open the Login page\n2. Enter password in the Password text box',
        expected: 'The Login page is displayed',
        testData: 'Password: ab•cd*ef',
      },
      { env: {} },
    );
    assert.equal(secretOf(real, 'password'), 'ab•cd*ef');
  });
});

describe("the product path on a real page: a login with the sheet's password", { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let session: ExecutionSession;
  before(async () => {
    app = await startDemoApp();
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  const steps = (): string =>
    [`Open ${app.url}/`, "Enter 'demo' in the Username field", 'Enter password in the Password field', "Click the 'Login' button"]
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n');

  async function run(testData: string, expected: string, tamper?: (values: Record<string, { value: unknown }>) => void) {
    const model = parseTestCase({ id: 'T-IN', title: 'Login from the sheet', steps: steps(), expected, testData });
    const compile = await compileCase(engineInputOf(model).raw, { env: {} });
    assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
    if (tamper) tamper((compile.values ?? {}) as Record<string, { value: unknown }>);
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
      { mcp: session.port, page: session.page, baseUrl: app.url },
    );
    await session.reset();
    return { trace, verdict: judge({ compile, trace }) };
  }

  it('a valid login from the sheet logs in: the password that is typed is the one the sheet gives', async () => {
    const r = await run('Password: demo123', 'The Dashboard heading is displayed');
    assert.equal(r.trace.status, 'completed', JSON.stringify(r.trace.stoppedAt));
    assert.equal(r.verdict.verdict, 'PASS', r.verdict.reason);
  });

  it('a wrong password from the sheet is rejected, and that is what the case checks', async () => {
    const r = await run('Password: wrongpassword', 'Error message "Invalid username or password" is displayed');
    assert.equal(r.verdict.verdict, 'PASS', r.verdict.reason);
  });

  it('a mask handed to the executor is not typed: the run stops with the reason, and nothing is entered', async () => {
    const r = await run('Password: demo123', 'The Dashboard heading is displayed', (values) => {
      for (const v of Object.values(values)) if (isSecret(v.value)) v.value = new Secret('••••');
    });
    assert.equal(r.trace.stoppedAt?.code, 'VALUE_UNRESOLVED');
    assert.ok(r.trace.stoppedAt?.reason.includes('mask'), r.trace.stoppedAt?.reason);
    assert.equal(r.verdict.verdict, 'TEST_DATA_ERROR', 'the data is at fault, not the application');
  });
});
