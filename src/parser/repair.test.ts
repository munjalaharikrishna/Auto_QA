import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTestCase } from './index.js';

describe('steps written the way testers write them (RW-S08, RW-S09)', () => {
  it('reads "User is on the Login page" as opening that page', () => {
    const m = parseTestCase({ title: 'T', steps: '1. User is on the Login page\n2. Click Login', expected: 'Dashboard is displayed' });
    assert.deepEqual(
      m.steps.map((s) => [s.action, s.status]),
      [
        ['navigate', 'parsed'],
        ['click', 'parsed'],
      ],
    );
  });

  it('writes "Repeat steps 1-2" out again and numbers the steps afresh', () => {
    const m = parseTestCase({
      title: 'T',
      steps: '1. Open Login page\n2. Click Login\n3. Repeat steps 1-2\n4. Click Login',
      expected: 'Dashboard is displayed',
    });
    assert.deepEqual(
      m.steps.map((s) => [s.id, s.action]),
      [
        ['S1', 'navigate'],
        ['S2', 'click'],
        ['S3', 'navigate'],
        ['S4', 'click'],
        ['S5', 'click'],
      ],
    );
  });

  it('leaves a repeat of a step that does not exist for review', () => {
    const m = parseTestCase({ title: 'T', steps: '1. Open Login page\n2. Repeat steps 4-5', expected: 'Dashboard is displayed' });
    assert.equal(m.steps[1].status, 'unparsed');
  });
});
