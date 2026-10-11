import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import type { ExplorationResult } from '../explorer/controller.js';
import type { RawTestCase } from '../model/test-model.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { type GenerateInput, generateProject, workspaceName, writeProject } from './index.js';
import { automationId, camel, kebabPage, pascal, propertyName, singleMethodName } from './names.js';
import { planProject } from './plan.js';

const config = defaultParserConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cases: RawTestCase[] = JSON.parse(readFileSync(path.join(root, 'examples/demo-app/test-cases.json'), 'utf8'));
const exploration = (id: string): ExplorationResult => JSON.parse(readFileSync(path.join(here, `fixtures/demo/${id}.exploration.json`), 'utf8'));
const demoInputs = (): GenerateInput[] =>
  ['TC-DEMO-001', 'TC-DEMO-002', 'TC-DEMO-003'].map((id) => ({ model: parseTestCase(cases.find((c) => c.id === id)!, config), exploration: exploration(id) }));

/** Golden files: `UPDATE_GOLDEN=1 npm test` rewrites them after an intended change; review the diff. */
const goldenDir = path.join(here, 'fixtures/demo-golden');

describe('names (FR-GE-02, FR-GE-10)', () => {
  it('builds identifiers', () => {
    assert.equal(camel('Save changes'), 'saveChanges');
    assert.equal(camel('2FA code'), 'n2faCode');
    assert.equal(pascal('send me news'), 'SendMeNews');
    assert.equal(kebabPage('SwagLabsPage'), 'swag-labs');
    assert.equal(automationId('TC-REG-014'), 'AUTO-REG-014');
  });

  it('names properties after the element and its role', () => {
    assert.equal(propertyName('textbox', 'Username'), 'username');
    assert.equal(propertyName('button', 'Login'), 'loginButton');
    assert.equal(propertyName('checkbox', 'checkbox 1'), 'checkbox1');
    assert.equal(propertyName('combobox', 'Country'), 'countrySelect');
    assert.equal(propertyName('generic', 'Products'), 'productsText');
    assert.equal(propertyName('link', 'page'), 'pageLink');
  });

  it('names one-step methods', () => {
    assert.equal(singleMethodName('click', 'link', 'Profile'), 'openProfile');
    assert.equal(singleMethodName('click', 'button', 'Save changes'), 'saveChanges');
    assert.equal(singleMethodName('check', 'checkbox', 'Send me news'), 'checkSendMeNews');
    assert.equal(singleMethodName('select', 'combobox', 'Country'), 'selectCountry');
  });

  it('names the workspace after the site', () => {
    assert.equal(workspaceName('https://www.saucedemo.com'), 'saucedemo');
    assert.equal(workspaceName('https://the-internet.herokuapp.com/x'), 'the-internet');
    assert.equal(workspaceName('http://127.0.0.1:4173'), '127-0-0-1-4173');
  });
});

describe('generation plan (FR-GE-10, FR-GE-11)', () => {
  it('groups fields and the click that submits them into one method', () => {
    const plan = planProject(demoInputs());
    const byName = Object.fromEntries(plan.pages.map((p) => [p.className, p]));
    assert.deepEqual(
      byName.LoginPage.methods.map((m) => `${m.name}(${m.params.join(', ')})`),
      ['login(username, password)'],
    );
    assert.deepEqual(
      byName.ProfilePage.methods.map((m) => `${m.name}(${m.params.join(', ')})`),
      ['saveChanges(fullName, country)'],
    );
    assert.deepEqual(
      byName.DashboardPage.methods.map((m) => m.name),
      ['openProfile'],
    );
  });

  it('reuses a method two tests share, with their own values', () => {
    const plan = planProject(demoInputs());
    const [one, two] = plan.specs;
    assert.ok(one.steps.some((s) => s.lines[0] === 'await loginPage.login(process.env.TEST_USERNAME!, process.env.TEST_PASSWORD!);'));
    assert.ok(two.steps.some((s) => s.lines[0] === 'await loginPage.login(process.env.TEST_USERNAME!, process.env.TEST_WRONG_PASSWORD!);'));
    assert.deepEqual(plan.envVars, ['BASE_URL', 'TEST_PASSWORD', 'TEST_USERNAME', 'TEST_WRONG_PASSWORD']);
  });

  it('numbers a method whose name is taken by different steps, with a warning', () => {
    const [first] = demoInputs();
    // The same "Click Login" after only a username: a different login.
    const model = parseTestCase(
      { id: 'TC-DEMO-009', title: 'x', steps: '1. Open Login page\n2. Enter valid username\n3. Click Login', expected: 'User stays on the Login page' },
      config,
    );
    const ex: ExplorationResult = {
      ...first.exploration,
      testId: 'TC-DEMO-009',
      items: first.exploration.items.filter((i) => i.id !== 'S3' && i.kind === 'step'),
    };
    ex.items = ex.items.map((i) => (i.id === 'S4' ? { ...i, id: 'S3' } : i));
    ex.items.push({ ...first.exploration.items.find((i) => i.type === 'url')!, id: 'A1', type: 'url-unchanged', raw: 'User stays on the Login page' });
    const plan = planProject([first, { model, exploration: ex }]);
    const login = plan.pages.find((p) => p.className === 'LoginPage')!;
    assert.deepEqual(
      login.methods.map((m) => `${m.name}(${m.params.join(', ')})`),
      ['login(username, password)', 'login2(username)'],
    );
    assert.match(plan.warnings.join(), /LoginPage\.login\(\) already does something else, so this one is login2\(\)/);
  });

  it('imports a page the test only checks the URL of', async () => {
    const [first] = demoInputs();
    // Only "redirected to Dashboard": nothing on DashboardPage is clicked or checked.
    const model = parseTestCase({ ...cases[0], expected: 'User is redirected to Dashboard page.' }, config);
    const items = first.exploration.items.filter((i) => i.id !== 'A2').map((i) => (i.id === 'A3' ? { ...i, id: 'A2' } : i));
    const { files } = await generateProject([{ model, exploration: { ...first.exploration, items } }], 'demo');
    const spec = files['tests/tc-demo-001.spec.ts'];
    assert.match(spec, /import \{ DashboardPage \} from '\.\.\/pages\/DashboardPage';/);
    assert.match(spec, /await expectPath\(page, DashboardPage\.path\);/);
    assert.doesNotMatch(spec, /new DashboardPage/, 'no unused instance');
  });

  it('generates a "Logged in" test on its own, from the login steps it recorded', async () => {
    const [login, , profile] = demoInputs();
    const model = parseTestCase(
      { id: 'TC-DEMO-020', title: 'Profile opens', preconditions: 'Logged in', steps: '1. Click Profile', expected: 'Profile heading is displayed.' },
      config,
    );
    const clickProfile = profile.exploration.items.find((i) => i.raw === 'Click Profile')!;
    const exploration: ExplorationResult = {
      ...profile.exploration,
      testId: model.id,
      setup: { testId: login.model.id, steps: login.model.steps, data: login.model.data },
      items: [
        ...login.exploration.items.filter((i) => i.kind === 'step').map((i) => ({ ...i, phase: 'setup' as const })),
        { ...clickProfile, id: 'S1' },
        { ...profile.exploration.items.find((i) => i.kind === 'check' && i.type === 'health')!, id: 'A2' },
      ],
    };
    // Alone, as the batch checks each case: the setup's S1 is the login's, not this test's S1.
    const { files } = await generateProject([{ model, exploration }], 'demo');
    const spec = files['tests/tc-demo-020.spec.ts'];
    assert.match(spec, /'Precondition · S2, S3, S4: Enter valid username; Enter valid password; Click the Login button'/);
    assert.match(spec, /await loginPage\.login\(process\.env\.TEST_USERNAME!, process\.env\.TEST_PASSWORD!\);/);
    assert.match(spec, /await dashboardPage\.openProfile\(\);/);
  });

  it('refuses a test that was not fully explored', () => {
    const [input] = demoInputs();
    const ex = {
      ...input.exploration,
      status: 'incomplete' as const,
      items: input.exploration.items.map((i) => (i.id === 'S3' ? { ...i, status: 'skipped' as const } : i)),
    };
    assert.throws(() => planProject([{ ...input, exploration: ex }]), /TC-DEMO-001 is not fully explored \(incomplete: S3 skipped\)/);
  });

  it('never writes a secret value', async () => {
    const { files } = await generateProject(demoInputs(), 'demo');
    const all = Object.values(files).join('\n');
    assert.ok(!all.includes(DEMO_USER.password));
    assert.ok(all.includes('process.env.TEST_PASSWORD!'));
  });
});

describe('generated files (FR-GE-01, FR-GE-06)', () => {
  it('is deterministic, whatever order the tests come in', async () => {
    const a = await generateProject(demoInputs(), 'demo');
    const b = await generateProject(demoInputs().reverse(), 'demo');
    assert.deepEqual(a.files, b.files);
  });

  it('matches the golden files', async () => {
    const { files } = await generateProject(demoInputs(), 'demo');
    if (process.env.UPDATE_GOLDEN) {
      await rm(goldenDir, { recursive: true, force: true });
      await writeProject(goldenDir, files);
    }
    const golden = listFiles(goldenDir);
    assert.deepEqual(Object.keys(files).sort(), golden.sort(), 'file list (UPDATE_GOLDEN=1 to accept an intended change)');
    for (const [rel, content] of Object.entries(files)) {
      assert.equal(content, readFileSync(path.join(goldenDir, rel), 'utf8'), `${rel} (UPDATE_GOLDEN=1 to accept an intended change)`);
    }
  });
});

describe('generated project runs on its own (D5, M5 done)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  const exec = promisify(execFile);
  const require = createRequire(import.meta.url);
  // Inside the repo so the project finds @playwright/test in the platform's node_modules.
  const dir = path.join(root, '.auto-qa', 'test-workspaces', 'demo');
  let app: Awaited<ReturnType<typeof startDemoApp>>;

  before(async () => {
    app = await startDemoApp();
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeProject(dir, (await generateProject(demoInputs(), 'demo')).files);
  });
  after(async () => {
    await app?.close();
  });

  it('typechecks', async () => {
    const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
    await exec(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')]);
  });

  it('passes against the app, and fails when the login is wrong', async () => {
    const cli = require.resolve('@playwright/test/cli');
    const run = (password: string) =>
      exec(process.execPath, [cli, 'test', '--reporter=json'], {
        cwd: dir,
        env: { ...process.env, BASE_URL: app.url, TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: password, TEST_WRONG_PASSWORD: 'nope' },
        maxBuffer: 50 * 1024 * 1024,
      })
        .then((r) => JSON.parse(r.stdout))
        .catch((e: { stdout: string }) => JSON.parse(e.stdout));
    const good = await run(DEMO_USER.password);
    assert.deepEqual([good.stats.expected, good.stats.unexpected], [3, 0]);
    const bad = await run('wrong');
    // TC-DEMO-001 and 003 need a real login; 002 expects the rejection and still passes.
    assert.deepEqual([bad.stats.expected, bad.stats.unexpected], [1, 2]);
  });
});

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/')],
  );
}
