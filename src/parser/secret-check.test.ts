import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultParserConfig, parseTestCase } from './index.js';
import { fingerprint, mismatchedSecrets, mismatchText } from './secret-check.js';

const config = defaultParserConfig();
const wrongPassword = parseTestCase(
  {
    id: 'TC_LOGIN_003',
    title: 'Login with valid username and invalid password',
    steps: '1. Open the login page\n2. Enter username in the Login Name text box.\n3. Enter password in the Password text box.\n4. Click the Login button.',
    expected: 'Login is rejected and an error message is displayed',
    testData: 'Username: cypress\nPassword: wrongpassword',
  },
  config,
);

describe('a secret in the Test Data is compared, not replaced (S4)', () => {
  it('keeps a fingerprint of the sheet value and never the value', () => {
    assert.deepEqual(Object.keys(wrongPassword.secretChecks ?? {}), ['TEST_PASSWORD']);
    assert.ok(!JSON.stringify(wrongPassword).includes('wrongpassword'));
    assert.equal(wrongPassword.secretChecks?.TEST_PASSWORD, fingerprint('TEST_PASSWORD', 'wrongpassword'));
  });
  it('finds the project password that is not the one the case gives (the TC_LOGIN_003 trap)', () => {
    assert.deepEqual(mismatchedSecrets(wrongPassword, { TEST_PASSWORD: 'selenium' }), ['TEST_PASSWORD']);
    assert.match(mismatchText(['TEST_PASSWORD']), /wrong password would log in with the right one/);
  });
  it('lets a case run whose value is the one set, or whose variable is not set yet', () => {
    assert.deepEqual(mismatchedSecrets(wrongPassword, { TEST_PASSWORD: 'wrongpassword' }), []);
    assert.deepEqual(mismatchedSecrets(wrongPassword, {}), []);
    assert.deepEqual(mismatchedSecrets({}, { TEST_PASSWORD: 'x' }), []);
  });
});
