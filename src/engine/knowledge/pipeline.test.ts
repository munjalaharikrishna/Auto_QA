import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '../../importer/workbook.js';
import type { RawTestCase } from '../../model/test-model.js';
import { type Application, ApplicationSchema, compileCase } from '../index.js';

/** E0.6: the application knowledge in the compilation (ResolvePage, ResolveTarget). */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const orange = (): Application => ApplicationSchema.parse(JSON.parse(readFileSync(path.join(root, 'test', 'knowledge', 'orangehrm.kb.json'), 'utf8')));
const loginCase = async (id: string): Promise<RawTestCase> => {
  const wb = await readWorkbook(path.join(root, 'test', 'fixtures', 'OrangeHRM_Login_Test_Cases_Updated.xlsx'));
  return (wb.cases.find((c) => c.raw.id === id) as { raw: RawTestCase }).raw;
};

describe('the knowledge in the compilation', () => {
  it('brings each target of the login cases to its one component, and says so in the decision log', async () => {
    const r = await compileCase(await loginCase('TC_LOGIN_001'), { knowledge: orange() });
    assert.equal(r.status, 'compiled');
    const byName = (n: string) => r.ir?.steps.find((s) => s.target?.name === n)?.target;
    assert.deepEqual([byName('Login Name')?.component, byName('Login Name')?.page, byName('Login Name')?.ontology], ['Username', 'Login', 'Username']);
    assert.deepEqual([byName('Password')?.component, byName('Password')?.page], ['Password', 'Login']);
    assert.deepEqual([byName('Login')?.component, byName('Login')?.page], ['Login', 'Login']);
    const decisions = r.log.filter((l) => l.stage === 'ResolveTarget').map((l) => l.message);
    assert.ok(
      decisions.some((m) => m.includes('"Login Name" is the component "Username" of the page "Login"')),
      decisions.join(' | '),
    );
    assert.ok(decisions.some((m) => m.includes('"OrangeHRM" knowledge, version 1')));
  });
  it('resolves the page of a step to the stored page', async () => {
    const r = await compileCase(await loginCase('TC_LOGIN_001'), { knowledge: orange() });
    const page = r.log.find((l) => l.stage === 'ResolvePage' && l.message.includes('stored page'));
    assert.ok(page?.message.includes('OrangeHRM login is the stored page "Login"'), String(page?.message));
    const without = await compileCase(await loginCase('TC_LOGIN_001'));
    assert.ok(without.log.some((l) => l.stage === 'ResolvePage' && l.message.includes('no known address')));
  });
  it('joins the base address and the route of a stored page', async () => {
    const kb = { ...orange(), baseUrl: 'https://hr.example.test', pages: orange().pages.map((p) => (p.name === 'Login' ? { ...p, route: '/auth/login' } : p)) };
    const r = await compileCase(await loginCase('TC_LOGIN_001'), { knowledge: kb });
    assert.equal(r.pages?.['OrangeHRM login'], 'https://hr.example.test/auth/login');
  });
  it('changes nothing without knowledge: no component, no page, the same plan', async () => {
    const plain = await compileCase(await loginCase('TC_LOGIN_001'));
    assert.ok(plain.ir?.steps.every((s) => s.target?.component === undefined));
    const withKb = await compileCase(await loginCase('TC_LOGIN_001'), { knowledge: orange() });
    assert.deepEqual(withKb.plan, plain.plan);
    assert.equal(withKb.ir?.steps.length, plain.ir?.steps.length);
  });
  it('takes the class of an unclassified element from the knowledge', async () => {
    const kb = ApplicationSchema.parse({ name: 'Shop', pages: [{ name: 'Home', aliases: ['Home page'], components: [{ name: 'Cart', ontology: 'Link' }] }] });
    const r = await compileCase(
      { id: 'T', title: 't', steps: '1. Open the Home page\n2. Click Cart', expected: 'The Home page is displayed' },
      { knowledge: kb },
    );
    const click = r.ir?.steps.find((s) => s.action === 'CLICK')?.target;
    assert.deepEqual([click?.ontology, click?.component, click?.page], ['Link', 'Cart', 'Home']);
  });
  it('a name that fits two components is a question, never a pick', async () => {
    const kb = ApplicationSchema.parse({
      name: 'Two forms',
      pages: [
        { name: 'Billing', aliases: ['Billing page'], components: [{ name: 'Address', ontology: 'Field' }] },
        { name: 'Shipping', aliases: ['Shipping page'], components: [{ name: 'Address', ontology: 'Field' }] },
      ],
    });
    const r = await compileCase(
      { id: 'T', title: 't', steps: "1. Open the Application\n2. Enter 'x' in the Address field", expected: 'The Dashboard heading is displayed' },
      { knowledge: kb },
    );
    const issue = r.issues.find((i) => i.message.includes('fits more than one component'));
    assert.ok(issue, JSON.stringify(r.issues));
    assert.equal(issue.severity, 'review');
    assert.equal(r.status, 'needs-review');
    assert.ok(r.ir?.steps[1]?.target?.component === undefined, 'no component was chosen');
  });
  it('searches the page the test case is on first: the same name on two pages is not a question there', async () => {
    const kb = ApplicationSchema.parse({
      name: 'Two forms',
      pages: [
        { name: 'Billing', aliases: ['Billing page'], components: [{ name: 'Address', ontology: 'Field' }] },
        { name: 'Shipping', aliases: ['Shipping page'], components: [{ name: 'Address', ontology: 'Field' }] },
      ],
    });
    const r = await compileCase(
      { id: 'T', title: 't', steps: "1. Open the Shipping page\n2. Enter 'x' in the Address field", expected: 'The Shipping page is displayed' },
      { knowledge: kb },
    );
    assert.equal(r.ir?.steps[1]?.target?.page, 'Shipping');
    assert.ok(!r.issues.some((i) => i.message.includes('fits more than one')));
  });
  it('a page name two stored pages share is a question', async () => {
    const kb = ApplicationSchema.parse({
      name: 'X',
      pages: [
        { name: 'List', aliases: ['Overview'] },
        { name: 'Summary', aliases: ['Overview'] },
      ],
    });
    const r = await compileCase(
      { id: 'T', title: 't', steps: '1. Open the Overview page\n2. Click the Save button', expected: 'The Overview page is displayed' },
      { knowledge: kb },
    );
    assert.ok(
      r.issues.some((i) => i.message.includes('fits more than one stored page')),
      JSON.stringify(r.issues),
    );
  });
});
