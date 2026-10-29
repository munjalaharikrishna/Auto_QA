import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileCase } from '../engine/pipeline/compile.js';
import { readWorkbook } from '../importer/workbook.js';
import type { RawTestCase } from '../model/test-model.js';
import { loginComesFirst } from './semantic-run.js';

/** TC_LOGIN_003 (a wrong password) logs in once, by its own steps: the shared login case does not run before it, or twice. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const raw = (id: string, over: Partial<RawTestCase> = {}): RawTestCase => ({
  id,
  title: id,
  steps: '1. Open the Login page\n2. Click the Login button',
  expected: 'The Dashboard heading is displayed',
  ...over,
});

describe('the shared login runs once, and never before the login case itself', () => {
  it('TC_LOGIN_003 of the real login workbook starts logged out, so no shared login comes first', async () => {
    const cases = (await readWorkbook(path.join(root, 'test/fixtures/OrangeHRM_Login_Test_Cases_Updated.xlsx'))).cases.map((c) => c.raw);
    const tc3 = cases.find((c) => c.id === 'TC_LOGIN_003');
    assert.ok(tc3, 'the workbook has TC_LOGIN_003');
    const compiled = await compileCase(tc3, { env: {} });
    assert.ok(!compiled.ir?.preconditions.some((p) => p.type === 'LOGGED_IN'));
    const login = await compileCase(cases.find((c) => c.id === 'TC_LOGIN_001') as RawTestCase, { env: {} });
    assert.equal(loginComesFirst(compiled, login), false);
  });
  it('a case that starts logged in has the shared login first, once', async () => {
    const login = await compileCase(raw('LOGIN', { steps: '1. Open the Login page\n2. Click the Login button' }), { env: {} });
    const inside = await compileCase(raw('INSIDE', { preconditions: 'User is logged in', steps: '1. Open the Dashboard page' }), { env: {} });
    assert.ok(
      inside.ir?.preconditions.some((p) => p.type === 'LOGGED_IN'),
      JSON.stringify(inside.ir?.preconditions),
    );
    assert.equal(loginComesFirst(inside, login), true);
  });
  it('the login case itself is never signed in by the shared login first, even when it says "logged in"', async () => {
    const login = await compileCase(raw('LOGIN', { preconditions: 'User is logged in', steps: '1. Open the Dashboard page' }), { env: {} });
    assert.ok(login.ir?.preconditions.some((p) => p.type === 'LOGGED_IN'));
    assert.equal(loginComesFirst(login, login), false);
  });
  it('without a login case there is nothing to run first', async () => {
    const inside = await compileCase(raw('INSIDE', { preconditions: 'User is logged in', steps: '1. Open the Dashboard page' }), { env: {} });
    assert.equal(loginComesFirst(inside, undefined), false);
  });
});
