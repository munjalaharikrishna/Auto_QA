import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { containerRef, matchContainers, wordsOf } from './container.js';

/** UI-07: what a place phrase names. The one reading the grammar, the locator and the judge share. */

describe('what a phrase names', () => {
  it('a card, a tile or a list item is a repeated widget: it has to be found', () => {
    assert.deepEqual(containerRef("the 'Backpack' card"), { text: 'backpack', words: ['backpack'], noun: 'card', repeated: true });
    assert.deepEqual(containerRef('Backpack card'), { text: 'backpack', words: ['backpack'], noun: 'card', repeated: true });
    assert.deepEqual(containerRef('The Sauce Labs Backpack tile'), {
      text: 'sauce labs backpack',
      words: ['sauce', 'labs', 'backpack'],
      noun: 'tile',
      repeated: true,
    });
    assert.equal(containerRef('Backpack list item')?.text, 'backpack', '"list item" is one kind of container');
    assert.equal(containerRef('Backpack list item')?.noun, 'item');
  });

  it('a section, a panel or a box is an area: scoped when one is on the page, read as before when none is', () => {
    const ref = containerRef('the Employment section');
    assert.deepEqual([ref?.text, ref?.noun, ref?.repeated], ['employment', 'section', false]);
    assert.equal(containerRef('Order panel')?.repeated, false);
  });

  it('a page, a table or a name alone names no container', () => {
    for (const phrase of ['the Personal Information page', 'the table', 'Backpack', 'card', 'the card', '', undefined])
      assert.equal(containerRef(phrase as string | undefined), undefined, String(phrase));
  });

  it('reads words without case, quotes or punctuation', () => {
    assert.deepEqual(wordsOf("The 'Bolt T-Shirt' card!"), ['the', 'bolt', 't', 'shirt', 'card']);
  });
});

describe('which containers on the page a phrase means', () => {
  const on = (...names: string[]) => names.map((name) => ({ name }));
  const ref = (phrase: string) => containerRef(phrase) as NonNullable<ReturnType<typeof containerRef>>;

  it('the container whose title is the name', () => {
    assert.deepEqual(matchContainers(ref('Backpack card'), on('Backpack', 'Bike Light', 'Bolt T-Shirt')), [{ name: 'Backpack' }]);
    assert.deepEqual(matchContainers(ref("the 'bike light' card"), on('Backpack', 'Bike Light')), [{ name: 'Bike Light' }], 'case does not matter');
  });

  it('a title that only holds the name is meant when no title is the name', () => {
    assert.deepEqual(matchContainers(ref('Backpack card'), on('Sauce Labs Backpack', 'Bike Light')), [{ name: 'Sauce Labs Backpack' }]);
  });

  it('an exact title wins over a longer one: "Backpack" is not "Backpack Pro"', () => {
    assert.deepEqual(matchContainers(ref('Backpack card'), on('Backpack Pro', 'Backpack')), [{ name: 'Backpack' }]);
  });

  it('titles that tie are all returned, so the caller cannot take the first', () => {
    assert.equal(matchContainers(ref('Backpack card'), on('Backpack', 'Backpack', 'Bike Light')).length, 2);
    assert.equal(matchContainers(ref('Backpack card'), on('Backpack Pro', 'Sauce Labs Backpack')).length, 2, 'two that merely hold it');
  });

  it('none when nothing has the name, and not when only part of a word does', () => {
    assert.deepEqual(matchContainers(ref('Umbrella card'), on('Backpack', 'Bike Light')), []);
    assert.deepEqual(matchContainers(ref('Pack card'), on('Backpack')), [], 'a word is not part of another word');
  });
});
