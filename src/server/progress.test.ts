import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { progressOf } from '../../web/src/progress.js';

/** U1 step 4: the live run reads how far a run is, and the state of each case, from the lines the run writes to its log. */

describe('the live run progress (U1 step 4)', () => {
  const log = [
    '5 test case(s) in " Signin Page "',
    '! Other sheets with test cases were not imported: Buying',
    'Setup block of " Signin Page ": the first 2 line(s) of 3 case(s)',
    '… [1/5] TC01: compiled (compiled), 13 decision(s) logged',
    '… [1/5] TC01: exploring',
    '? [2/5] TC02: needs review: 3 thing(s) the new engine did not understand',
    '… [3/5] TC03: compiled (compiled), 17 decision(s) logged',
  ];

  it('counts the cases it reached out of the total the run announced', () => {
    const p = progressOf(log);
    assert.equal(p.total, 5);
    assert.deepEqual(
      p.cases.map((c) => c.id),
      ['TC01', 'TC02', 'TC03'],
    );
    assert.equal(p.now, 'TC03');
  });

  it('a case keeps the state of its latest line: exploring is now, a question is asks', () => {
    const p = progressOf(log);
    assert.equal(p.cases.find((c) => c.id === 'TC01')?.state, 'now');
    assert.equal(p.cases.find((c) => c.id === 'TC02')?.state, 'asks');
    assert.equal(p.cases.find((c) => c.id === 'TC03')?.state, 'done');
  });

  it('later lines without a count still update their case; lines about no case are left out', () => {
    const p = progressOf([...log, '… TC01: running through the new engine', 'Clean-up list: 2 record(s)']);
    assert.equal(p.cases.find((c) => c.id === 'TC01')?.state, 'now');
    assert.equal(p.cases.length, 3);
    assert.deepEqual(progressOf(['Waiting to start…']), { cases: [] });
  });
});
