import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ONTOLOGY } from '../language/ontology.js';
import {
  type Application,
  ApplicationSchema,
  applicationClass,
  consolidate,
  diffKnowledge,
  identifyPage,
  KnowledgeStore,
  labelKey,
  pageNames,
  resolvePage,
} from './index.js';

/** E0.6 exit tests, knowledge part: the application and page knowledge bases, label consolidation, per-application words. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const orange = (): Application => ApplicationSchema.parse(JSON.parse(readFileSync(path.join(root, 'test', 'knowledge', 'orangehrm.kb.json'), 'utf8')));
const demo = (): Application => ApplicationSchema.parse({ name: 'Demo shop', pages: [{ name: 'Login', components: [{ name: 'Email', ontology: 'Field' }] }] });

describe('AK-01: the application knowledge base', () => {
  it('holds an application: pages, routes, roles, modules, forms, fields, buttons, messages, rules, navigation and authentication', () => {
    const kb = orange();
    assert.equal(kb.name, 'OrangeHRM');
    assert.ok(kb.pages.length >= 4);
    assert.ok(kb.roles.length && kb.modules.length && kb.rules.length && kb.navigation.length);
    assert.equal(kb.authentication.loginPage, 'Login');
    assert.ok(kb.pages.flatMap((p) => p.forms).length >= 2, 'forms');
    assert.ok(
      kb.pages.flatMap((p) => p.components).some((c) => c.ontology === 'Button'),
      'buttons',
    );
    assert.ok(
      kb.pages.flatMap((p) => p.components).some((c) => c.ontology === 'Field'),
      'fields',
    );
    assert.ok(kb.pages.flatMap((p) => p.messages).length >= 2, 'messages');
  });
  it('refuses knowledge that does not fit, naming the field', () => {
    assert.throws(
      () => ApplicationSchema.parse({ name: 'X', pages: [{ components: [] }] }),
      (e: unknown) => e instanceof Error && e.message.includes('name'),
    );
    assert.throws(() => ApplicationSchema.parse({ name: 'X', pages: [{ name: 'P', messages: [{ name: 'm', text: 't', kind: 'loud' }] }] }));
  });
  it('is stored as files, and every save is a new version that can be read again', async () => {
    const store = new KnowledgeStore(await mkdtemp(path.join(tmpdir(), 'auto-qa-kb-')));
    assert.equal(await store.load('OrangeHRM'), undefined);
    const v1 = await store.save(orange());
    assert.equal(v1.version, 1);
    const edited = {
      ...v1,
      pages: v1.pages.map((p) =>
        p.name === 'Login' ? { ...p, components: [...p.components, { name: 'Remember me', aliases: [], ontology: 'Checkbox', key: false }] } : p,
      ),
    };
    const v2 = await store.save(edited as never);
    assert.equal(v2.version, 2, 'the store counts the versions, whatever the data says');
    assert.deepEqual(await store.versions('OrangeHRM'), [1, 2]);
    assert.equal((await store.load('OrangeHRM'))?.version, 2);
    assert.equal((await store.load('OrangeHRM', 1))?.pages.find((p) => p.name === 'Login')?.components.length, 4, 'the first version is as it was');
    assert.equal((await store.load('OrangeHRM', 2))?.pages.find((p) => p.name === 'Login')?.components.length, 5);
  });
  it('shows what an edit changed, in words', async () => {
    const before = orange();
    const after: Application = {
      ...before,
      pages: [
        ...before.pages.map((p) =>
          p.name === 'Login'
            ? {
                ...p,
                route: '/auth/login',
                components: [
                  ...p.components.map((c) => (c.name === 'Username' ? { ...c, aliases: [...c.aliases, 'account name'] } : c)),
                  { name: 'Forgot password', aliases: [], ontology: 'Link', key: false },
                ],
              }
            : p,
        ),
        { name: 'Reports', aliases: [], sections: [], forms: [], components: [], filters: [], messages: [], expectedStates: [] },
      ],
      vocabulary: [...before.vocabulary, { term: 'Vacancy', ontology: 'Record', aliases: [] }],
    };
    const changes = diffKnowledge(before, after).map((c) => `${c.kind}/${c.change}: ${c.what}`);
    assert.ok(changes.includes('page/added: Reports'));
    assert.ok(changes.includes('route/changed: Login: (none) → /auth/login'));
    assert.ok(changes.includes('component/added: Login: Forgot password'));
    assert.ok(changes.includes('alias/added: Login: Username also called "account name"'));
    assert.ok(changes.includes('vocabulary/added: Vacancy'));
    assert.deepEqual(diffKnowledge(before, before), []);
  });
});

describe('LU-01: label consolidation', () => {
  const NAMES = ['username', 'username field', 'login name', 'user name textbox', 'Username input', 'Login Name text box', 'User Name :', 'USERNAME'];
  it('brings every way of writing the name to the same component, every time', () => {
    const kb = orange();
    const found = NAMES.map((n) => consolidate(kb, n));
    for (const [i, c] of found.entries()) {
      assert.equal(c.status, 'one', NAMES[i]);
      assert.equal(c.components[0]?.component.name, 'Username', NAMES[i]);
      assert.equal(c.components[0]?.page, 'Login', NAMES[i]);
    }
    assert.deepEqual(
      found.map((c) => labelKey(c.components[0]?.component.name ?? '')),
      NAMES.map(() => 'username'),
    );
    // Run again: the same answer.
    assert.deepEqual(
      NAMES.map((n) => consolidate(kb, n)),
      found,
    );
  });
  it('reads "user name" and "username" as one, and ignores the colon of a label cell', () => {
    assert.equal(labelKey('user name'), labelKey('username'));
    assert.equal(labelKey('Password :'), labelKey('password'));
    assert.equal(labelKey('Login Name text box'), 'loginname');
  });
  it('knows the names that mean the same everywhere, when the knowledge does not know the name', () => {
    const none = consolidate(demo(), 'login name');
    assert.equal(none.status, 'none');
    assert.equal(none.core, 'username', 'a login name is a username in any application');
    assert.equal(consolidate(undefined, 'e-mail').core, 'email');
    assert.equal(consolidate(demo(), 'Email address').components[0]?.component.name, 'Email', 'the stored component is reached by the core name too');
  });
  it('gives every component a name fits, and chooses none: "Name" fits more than one', () => {
    const kb = orange();
    const c = consolidate(kb, 'Name');
    assert.notEqual(c.status, 'one');
    const first = consolidate(kb, 'first name');
    assert.equal(first.status, 'one');
    assert.equal(first.components[0]?.component.name, 'First Name');
  });
  it('searches the current page first', () => {
    const kb = ApplicationSchema.parse({
      name: 'Two pages',
      pages: [
        { name: 'A', components: [{ name: 'Save', ontology: 'Button' }] },
        { name: 'B', components: [{ name: 'Save', ontology: 'Button' }] },
      ],
    });
    assert.equal(consolidate(kb, 'save').status, 'many');
    assert.equal(consolidate(kb, 'save', { page: 'B' }).components[0]?.page, 'B');
  });
});

describe('PK-01: the page knowledge base', () => {
  it('"Add Employee page/popup" is the stored Add Employee page', () => {
    const kb = orange();
    for (const phrase of ['Add Employee page/popup', 'the Add Employee page', 'Add Employee popup', 'add employee', 'Add Employee']) {
      const r = resolvePage(kb, phrase);
      assert.equal(r.status, 'one', phrase);
      assert.equal(r.pages[0]?.name, 'Add Employee', phrase);
    }
    assert.ok(pageNames('Add Employee page/popup').includes('addemployee'));
    assert.equal(resolvePage(kb, 'Employee Information Section').pages[0]?.name, 'Employee Information');
    assert.equal(resolvePage(kb, 'OrangeHRM login').pages[0]?.name, 'Login');
  });
  it('does not guess: an unknown page is none, and a name two pages share is many', () => {
    assert.equal(resolvePage(orange(), 'Payroll page').status, 'none');
    assert.equal(resolvePage(undefined, 'Login').status, 'none');
    const kb = ApplicationSchema.parse({
      name: 'X',
      pages: [
        { name: 'List', aliases: ['Overview'] },
        { name: 'Summary', aliases: ['Overview'] },
      ],
    });
    assert.equal(resolvePage(kb, 'Overview').status, 'many');
  });
  it('checks the identity of a page: its route and its key elements', () => {
    const page = ApplicationSchema.parse({
      name: 'X',
      pages: [
        {
          name: 'Add Employee',
          route: '/pim/addEmployee',
          components: [
            { name: 'First Name', key: true },
            { name: 'Save', key: true },
          ],
        },
      ],
    }).pages[0];
    assert.ok(page);
    const seen = (p: string, names: string[]) => ({ path: p, elements: names.map((n) => ({ name: n })) });
    assert.equal(identifyPage(page, seen('/pim/addEmployee?x=1', ['First Name', 'Save'])).ok, true);
    const wrongRoute = identifyPage(page, seen('/pim/viewEmployee', ['First Name', 'Save']));
    assert.equal(wrongRoute.ok, false);
    assert.equal(wrongRoute.route, 'mismatch');
    const noKey = identifyPage(page, seen('/pim/addEmployee', ['Save']));
    assert.equal(noKey.ok, false);
    assert.deepEqual(noKey.missing, ['First Name']);
    const nothingKnown = identifyPage(ApplicationSchema.parse({ name: 'X', pages: [{ name: 'Blank' }] }).pages[0] as never, seen('/', []));
    assert.equal(nothingKnown.ok, false, 'a page with no route and no key element is never "identified"');
  });
});

describe('PD-3: the words of one application', () => {
  it('Employee and Supervisor are OrangeHRM words: they mean something in OrangeHRM and nothing elsewhere', () => {
    assert.equal(applicationClass(orange(), 'Employee'), 'Record');
    assert.equal(applicationClass(orange(), 'employee data'), 'Record');
    assert.equal(applicationClass(orange(), 'Supervisor'), 'Field');
    assert.equal(applicationClass(demo(), 'Employee'), undefined);
    assert.equal(applicationClass(demo(), 'Supervisor'), undefined);
    assert.equal(applicationClass(undefined, 'Employee'), undefined);
  });
  it('the core ontology has no application words', () => {
    const core = new Set(ONTOLOGY.map((c) => c.name.toLowerCase()));
    for (const term of orange().vocabulary.map((v) => v.term)) assert.ok(!core.has(term.toLowerCase()), `${term} is an application word, not a core class`);
    for (const word of ['employee', 'supervisor', 'applicant-tracking', 'vacancy']) assert.ok(!core.has(word), word);
  });
  it('an application word names a core class it specializes: it adds a word, never a class the core does not have', () => {
    const core = new Set(ONTOLOGY.map((c) => c.name));
    for (const v of orange().vocabulary) assert.ok(core.has(v.ontology), `${v.term} → ${v.ontology}`);
  });
});
