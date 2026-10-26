import { scryptSync, timingSafeEqual } from 'node:crypto';
import type { TestModel } from '../model/test-model.js';

/**
 * A secret in the Test Data column ("Password: wrongpassword") is never stored, and the test reads it from an environment
 * variable (FR-TD-02). That used to make the sheet's value and the run's value two different things: a case written to
 * log in with a wrong password logged in with the project's right one, and its negative check proved nothing (S4).
 * What is kept is a salted fingerprint of the sheet's value. Before a case runs, the variable's value is compared with it;
 * when they differ, the case does not run, and it says why.
 */

export function fingerprint(envName: string, value: string): string {
  return scryptSync(value, `auto-qa:${envName}`, 16, { N: 16384 }).toString('hex');
}

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The variables whose value is not the one the test case's Test Data gives. A variable that is not set is not a mismatch: the run reports it missing. */
export function mismatchedSecrets(model: Pick<TestModel, 'secretChecks'>, env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(model.secretChecks ?? {})
    .filter(([name, print]) => env[name] !== undefined && env[name] !== '' && !same(fingerprint(name, env[name] as string), print))
    .map(([name]) => name);
}

export function mismatchText(names: readonly string[]): string {
  return `The Test Data of this case gives a different value for ${names.join(', ')} than the one set for the project, so running it would not test what the case says (a case about a wrong password would log in with the right one). Give this case its own variable: write the value in Test Data as {{env.TEST_<NAME>}} and set that variable, or set ${names.join(', ')} to the value in the sheet.`;
}
