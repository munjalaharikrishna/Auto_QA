import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ruleProblem } from './rule-check.js';

describe('a project rule is checked before it is saved (S3)', () => {
  const check = (kind: 'step' | 'check' | 'element', pattern: string, meaning: string) => ruleProblem({ kind, pattern, meaning });

  it('accepts a step and a check that say something real', () => {
    assert.equal(check('step', 'Sign me in', 'Click the Login button'), undefined);
    assert.equal(check('check', 'It works fine', 'Dashboard is displayed'), undefined);
    assert.equal(check('element', 'Account', 'Login Name'), undefined);
  });

  it('refuses a rule that judges nothing', () => {
    assert.match(check('check', 'Appropriate user name should shown', 'No crash') ?? '', /not read as a check|judges/);
    assert.match(check('check', 'It works', 'Handles the whitespace according to the rules') ?? '', /judges/);
    assert.match(check('step', 'Do the needful', 'whatever') ?? '', /not read as a step|not a step/);
  });

  it('refuses an empty rule, one that repeats itself and a multi-line one', () => {
    assert.match(check('element', 'x', '') ?? '', /Say what/);
    assert.match(check('check', 'Dashboard is displayed', 'dashboard is displayed.') ?? '', /same thing/);
    assert.match(check('step', 'a', 'Click Login\nClick Save') ?? '', /one sentence/);
  });
});
