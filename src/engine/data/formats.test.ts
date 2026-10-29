import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileCase } from '../index.js';
import { formatRuleOf } from './formats.js';

/** D: a note that says what a field accepts decides the values made for it. */

const compile = (steps: string, expected: string) => compileCase({ id: 'T', title: 'T', steps, expected }, { env: {} });
const madeValue = async (steps: string): Promise<{ value: string; rule: string }> => {
  const c = await compile(steps, 'Verify the Dashboard heading is displayed');
  assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
  const v = Object.values(c.values ?? {})[0];
  assert.ok(v);
  return { value: typeof v.value === 'string' ? v.value : '***', rule: v.rule ?? '' };
};

describe('format notes', () => {
  it('reads "should accept only <format>" with and without a named field', () => {
    assert.deepEqual(formatRuleOf('Text box should accept only alphabets'), { format: 'ALPHA' });
    assert.deepEqual(formatRuleOf('The Code field accepts only numbers'), { format: 'NUMERIC', field: 'Code field' });
    assert.deepEqual(formatRuleOf('Text box should accept only numeric'), { format: 'NUMERIC' });
  });

  it('needs "only": "accepts numbers" does not say letters are refused', () => {
    assert.equal(formatRuleOf('Text box should accept numbers'), undefined);
    assert.equal(formatRuleOf('The page should open'), undefined);
  });

  it('makes a valid value of letters for a field that accepts only alphabets', async () => {
    const v = await madeValue('Enter valid Last name in Last name text box. Note: Text box should accept only alphabets');
    assert.equal(v.rule, 'format.alpha');
    assert.ok(
      [...v.value].every((c) => c.toLowerCase() !== c.toUpperCase()),
      v.value,
    );
  });

  it('makes digits for a field that accepts only numbers, and a value with no digits when it must be invalid', async () => {
    const ok = await madeValue('Enter the valid code/id in code text box Note: Text box should accept only numbers');
    assert.equal(ok.rule, 'format.numeric');
    assert.ok(
      [...ok.value].every((c) => c >= '0' && c <= '9'),
      ok.value,
    );
    const bad = await madeValue('Enter invalid Last name in Last name text box. Note: Text box should accept only alphabets');
    assert.equal(bad.rule, 'invalid.format.alpha');
    assert.ok(
      [...bad.value].every((c) => c >= '0' && c <= '9'),
      bad.value,
    );
  });

  it('changes nothing for a field with no note', async () => {
    assert.equal((await madeValue('Enter valid Last name in Last name text box')).rule, 'person.name');
  });
});
