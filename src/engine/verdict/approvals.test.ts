import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunTrace, StepRecord } from '../execute/executor.js';
import type { IrExpectation } from '../ir/schema.js';
import type { Evaluation } from './evaluate.js';
import { approvalFingerprint } from './verdict.js';

/**
 * E0.18 step 5, approval fingerprints: a person's decision on a check holds for the next run only while the check is the same: the
 * sentence, the condition and its expected value, the step's action and the element it used, and what the page showed.
 */

const exp = (expect = 'Profile', name = 'Profile'): IrExpectation => ({
  id: 'E1',
  clause: 'User should see Profile as a default page',
  negated: false,
  condition: { type: 'STATE', target: { ontology: 'Page', name }, expect },
  afterStep: 'S4',
});
const ev = (actual = 'no menu item called "Profile" on the page'): Evaluation => ({
  expectation: 'E1',
  clause: 'User should see Profile as a default page',
  result: 'unproven',
  expected: 'x',
  actual,
  why: 'y',
  step: 'S4',
  fresh: false,
});
const trace = (selector = "xpath=//*[@data-testid='login']"): RunTrace => ({
  testId: 'T',
  status: 'completed',
  capabilities: [],
  steps: [
    {
      step: 'S4',
      action: 'CLICK',
      original: 'Click Login',
      status: 'done',
      calls: [],
      changes: [],
      dialogs: [],
      checksAfter: ['E1'],
      notes: [],
      located: {
        name: 'Login',
        level: 'role',
        weight: 0.95,
        selector,
        contract: { id: 'c', page: '/', semantic: 'Login' },
        tried: [],
        element: { tag: 'button', role: 'button' },
        ignored: [],
      },
    } as StepRecord,
  ],
});

describe('E0.18 step 5: what a decision is about', () => {
  const same = approvalFingerprint(exp(), ev(), trace());

  it('the same check, element and page give the same fingerprint, run after run', () => {
    assert.equal(approvalFingerprint(exp(), ev(), trace()), same);
  });

  it('another expected value, another element of the step, or another page asks again', () => {
    assert.notEqual(approvalFingerprint(exp('Dashboard', 'Dashboard'), ev(), trace()), same);
    assert.notEqual(approvalFingerprint(exp(), ev(), trace("xpath=//*[@id='other-login']")), same);
    assert.notEqual(approvalFingerprint(exp(), ev('the address after login names Profile'), trace()), same);
    assert.notEqual(approvalFingerprint({ ...exp(), negated: true }, ev(), trace()), same);
  });
});
