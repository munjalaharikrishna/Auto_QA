import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { understandCase } from '../engine/language/case.js';
import { parseTestCase } from '../parser/index.js';
import { type RawTestCase, stepsWithChecks } from './test-model.js';

const base: RawTestCase = {
  id: 'TC01',
  title: 'Browse',
  steps: '1. Open the Browser\n2. Enter the valid Email address in Email Text box Note: student@bookmarket.com\n3. Click on the signin Button',
  expected: 'User should see the categories',
};

describe("a step's own expected result is kept beside the steps", () => {
  it('a test case without step results reads exactly as written', () => {
    assert.equal(stepsWithChecks(base), base.steps);
    assert.equal(stepsWithChecks({ ...base, stepExpected: {} }), base.steps);
  });

  it('puts each result right after its step and numbers everything again', () => {
    const raw = { ...base, stepExpected: { '1': 'Browser should be opened', '3': 'User should navigate to the search page' } };
    assert.equal(
      stepsWithChecks(raw),
      [
        '1. Open the Browser',
        '2. Verify Browser should be opened',
        '3. Enter the valid Email address in Email Text box Note: student@bookmarket.com',
        '4. Click on the signin Button',
        '5. Verify User should navigate to the search page',
      ].join('\n'),
    );
  });

  it('a result stays with its step when steps were removed and the numbers now have gaps', () => {
    // Steps 2 and 3 were deleted by hand: the numbers read 1, 4, 5, and the result of step 4 must still follow step 4.
    const raw: RawTestCase = {
      ...base,
      steps: '1. Open the Browser\n4. Click on the signin Button\n5. Click on Explore Now Button',
      stepExpected: { '4': 'User should navigate to the search page' },
    };
    assert.deepEqual(stepsWithChecks(raw).split('\n'), [
      '1. Open the Browser',
      '2. Click on the signin Button',
      '3. Verify User should navigate to the search page',
      '4. Click on Explore Now Button',
    ]);
  });

  it('a line without a number counts as the step at its position', () => {
    const raw: RawTestCase = { ...base, steps: 'Open the Browser\nClick on the signin Button', stepExpected: { '2': 'Search page is shown' } };
    assert.deepEqual(stepsWithChecks(raw).split('\n'), ['1. Open the Browser', '2. Click on the signin Button', '3. Verify Search page is shown']);
  });

  it('both readers see the same case as when the check was written into the steps', () => {
    const raw = { ...base, stepExpected: { '1': 'Browser should be opened' } };
    const written: RawTestCase = { ...base, steps: stepsWithChecks(raw) };
    assert.deepEqual(parseTestCase(raw).steps, parseTestCase(written).steps);
    assert.deepEqual(parseTestCase(raw).assertions, parseTestCase(written).assertions);
    assert.deepEqual(understandCase(raw).units, understandCase(written).units);
    // And the steps themselves, as stored, hold only actions.
    assert.ok(!raw.steps.includes('Verify'));
  });
});
