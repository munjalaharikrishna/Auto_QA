import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compilePattern, firstMatch, matchSlots } from './slots.js';
import { commandAt, verbAt } from './verbs.js';

const w = (s: string): string[] => s.toLowerCase().split(' ').filter(Boolean);
const text = (words: string[], span: { from: number; to: number } | undefined): string | undefined => span && words.slice(span.from, span.to).join(' ');

describe('slot grammar: patterns (E0.15)', () => {
  it('reads words, alternatives, optional words and slots', () => {
    const p = compilePattern('{verb:ENTER_VALUE} {value} (in|into|on top of) [the] {target?}');
    assert.deepEqual(
      p.parts.map((x) => x.kind),
      ['slot', 'slot', 'words', 'words', 'slot'],
    );
    assert.deepEqual(p.parts[2]?.kind === 'words' && p.parts[2].alternatives, [['in'], ['into'], ['on', 'top', 'of']]);
    assert.equal(p.parts[3]?.kind === 'words' && p.parts[3].optional, true);
    assert.equal(p.parts[4]?.kind === 'slot' && p.parts[4].optional, true);
  });

  it('refuses a malformed pattern: a mistake fails the tests, not a run', () => {
    assert.throws(() => compilePattern('enter {value'), { message: 'slot pattern "enter {value": no closing } at 6' });
    assert.throws(() => compilePattern('enter (in||on)'));
  });

  it('a slot takes as few words as it can: the first "in" ends the value', () => {
    const words = w('Enter Asha in the First Name field in the form');
    const m = matchSlots('{verb:ENTER_VALUE} {value} (in|into) {target}', words);
    assert.equal(text(words, m?.slots.value), 'asha');
    assert.equal(text(words, m?.slots.target), 'the first name field in the form');
    assert.equal(m?.verb?.verb, 'enter');
  });

  it('matches the whole clause or nothing', () => {
    assert.equal(matchSlots('click {target}', w('click')), undefined);
    assert.equal(matchSlots('click save', w('click save now')), undefined);
    assert.ok(matchSlots('click {target}', w('click save now')));
  });

  it('optional words are skipped when absent, and an optional slot may be empty', () => {
    assert.ok(matchSlots('{verb:SEARCH} [for] {value}', w('search for laptop')));
    const m = matchSlots('{verb:SEARCH} [for] {value}', w('search laptop'));
    assert.equal(m?.slots.value?.from, 1);
    const n = matchSlots('{verb:LOGIN} {rest?}', w('login'));
    assert.ok(n);
    assert.equal(n?.slots.rest, undefined);
  });

  it('a verb constraint is an action in capitals or the verb itself in lower case', () => {
    assert.ok(matchSlots('{verb:ENTER_VALUE} {target}', w('type the name')));
    assert.ok(matchSlots('{verb:fill} {target} with {value}', w('fill the name field with asha')));
    assert.equal(matchSlots('{verb:fill} {target} with {value}', w('enter the name field with asha')), undefined);
  });

  it('the first pattern that matches wins', () => {
    const patterns = ['{verb:SELECT} {value} (from|in) {target}', '{verb:SELECT} {target}'];
    assert.equal(firstMatch(patterns, w('select full-time from the status dropdown'))?.pattern.source, patterns[0]);
    assert.equal(firstMatch(patterns, w('select the status dropdown'))?.pattern.source, patterns[1]);
  });
});

describe('the one verb table (E0.15, audit U7)', () => {
  it('knows the 31 verbs in every form, and which forms give orders', () => {
    assert.equal(verbAt(w('clicks save'), 0)?.action, 'CLICK');
    assert.equal(commandAt(w('clicking save'), 0), true);
    assert.equal(commandAt(w('entered details'), 0), false, 'a past participle describes, it does not order');
  });

  it('knows the synonyms, and says which words were used', () => {
    const hit = verbAt(w('return to the employee list'), 0);
    assert.equal(hit?.action, 'NAVIGATE');
    assert.equal(hit?.via, 'return to');
    assert.equal(verbAt(w('tap on save'), 0)?.action, 'CLICK');
  });

  it('a navigation phrase comes before its first word: "open the application" starts the application', () => {
    assert.equal(verbAt(w('open the application'), 0)?.verb, 'open application');
    assert.equal(verbAt(w('go back to the list'), 0)?.action, 'BACK');
    assert.equal(verbAt(w('open the add employee page'), 0)?.verb, 'open');
  });

  it('"leave" is a verb only in "leave X blank": in a list of tabs it is a name', () => {
    assert.equal(verbAt(w('leave the code field blank'), 0)?.verb, 'leave');
    assert.equal(verbAt(w('leave , time , help are visible'), 0), undefined);
  });
});
