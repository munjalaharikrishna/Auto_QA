import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Secret } from '../data/secret.js';
import type { IrExpectation } from '../ir/schema.js';
import type { Observation } from '../execute/observe.js';
import { evaluateExpectation } from './evaluate.js';

/** A check that names a value by its data key is compared with the value, never with the key, and a secret is never compared. */

const form: Observation = {
  url: 'http://x/',
  title: 't',
  lines: ['Employee list', 'Asha Rao'],
  elements: [{ identity: 'a', role: 'textbox', name: 'First Name', tag: 'input', value: 'Asha', disabled: false, invalid: false }],
  messages: [],
  fieldErrors: [],
  tabs: 1,
};
const step = { step: 'S1', action: 'CLICK', original: 'Click Save', status: 'done', calls: [], changes: [], dialogs: [], checksAfter: ['E1'], notes: [], before: form, after: form } as never;
const ctx = (values: Record<string, { value: unknown }>) => ({ steps: [step], stepOf: new Map([['E1', 'S1']]), seen: [form], clause: '', values });
const exp = (condition: IrExpectation['condition']): IrExpectation => ({ id: 'E1', clause: 'the data is shown', negated: false, condition, afterStep: 'S1' });

describe('values named by data key in a check', () => {
  it('compares a field with the value the key stands for', () => {
    const e = evaluateExpectation(exp({ type: 'VALUE', target: { ontology: 'Field', name: 'First Name' }, expect: '$data.First_Name', check: 'value' }), ctx({ First_Name: { value: 'Asha' } }));
    assert.equal(e.result, 'proven');
    const other = evaluateExpectation(exp({ type: 'VALUE', target: { ontology: 'Field', name: 'First Name' }, expect: '$data.First_Name', check: 'value' }), ctx({ First_Name: { value: 'Ben' } }));
    assert.equal(other.result, 'disproven');
  });
  it('finds the value as text on the page', () => {
    assert.equal(evaluateExpectation(exp({ type: 'TEXT', expect: '$data.Last_Name', check: 'contains-text' }), ctx({ Last_Name: { value: 'Rao' } })).result, 'proven');
    assert.equal(evaluateExpectation(exp({ type: 'TEXT', expect: '$data.Last_Name', check: 'contains-text' }), ctx({ Last_Name: { value: 'Zed' } })).result, 'disproven');
  });
  it('does not decide on a secret or on a value nobody resolved', () => {
    const c = { type: 'VALUE' as const, target: { ontology: 'Field', name: 'First Name' }, expect: '$data.Password', check: 'value' };
    const secret = evaluateExpectation(exp(c), ctx({ Password: { value: new Secret('hunter2') } }));
    assert.equal(secret.result, 'unproven');
    assert.ok(!JSON.stringify(secret).includes('hunter2'));
    assert.equal(evaluateExpectation(exp(c), ctx({})).result, 'unproven');
  });
});
