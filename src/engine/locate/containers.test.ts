import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DomElement, type LocateQuery, locate } from './index.js';

/** UI-07: the element is found inside the card the step names, and never in another; a tie or a missing card is not guessed. */

let n = 0;
/** A button as the inspector reads it, inside the cards whose titles are given. */
const button = (text: string, ...containers: string[]): DomElement => ({
  index: n++,
  tag: 'button',
  role: 'button',
  ariaName: '',
  labels: [],
  text,
  visible: true,
  disabled: false,
  readOnly: false,
  covered: false,
  box: { x: 0, y: n * 10, width: 80, height: 20 },
  focused: false,
  focusable: true,
  parents: ['article', 'section'],
  ...(containers.length ? { containers } : {}),
  nearbyText: '',
  xpath: `/html[1]/body[1]/section[1]/article[${n}]/button[1]`,
  inDialog: false,
  invalid: false,
  frame: [],
});

const find = (page: DomElement[], within?: string, name = 'Add to cart'): ReturnType<typeof locate> =>
  locate({ name, ontology: 'Button', ...(within ? { within } : {}) } as LocateQuery, page);
const indexOf = (r: ReturnType<typeof locate>): number | undefined => (r.status === 'found' ? r.element.index : undefined);

const SHOP = [button('Add to cart', 'Backpack'), button('Add to cart', 'Bike Light'), button('Remove from cart', 'Bolt T-Shirt')];

describe('finding an element inside the card the step names', () => {
  it('without a card, three look-alike buttons are ambiguous: the first is never taken', () => {
    const page = [button('Add to cart', 'Backpack'), button('Add to cart', 'Bike Light'), button('Add to cart', 'Bolt T-Shirt')];
    assert.equal(find(page).status, 'ambiguous');
  });

  it('with the card named, the one button in that card is found, whichever card it is', () => {
    const page = [button('Add to cart', 'Backpack'), button('Add to cart', 'Bike Light'), button('Add to cart', 'Bolt T-Shirt')];
    for (const [card, at] of [
      ["the 'Backpack' card", 0],
      ['Bike Light card', 1],
      ['the Bolt T-Shirt card', 2],
    ] as const) {
      const r = find(page, card);
      assert.equal(r.status, 'found', card);
      assert.equal(indexOf(r), page[at]?.index, card);
    }
  });

  it('a card that does not have the element does not lend it from another: the Bolt card has no Add to cart', () => {
    const r = find(SHOP, 'Bolt T-Shirt card');
    assert.equal(r.status, 'not-found');
  });

  it('a card that is not on the page is not found, and the whole page is not searched instead', () => {
    const r = find(SHOP, 'Umbrella card');
    assert.equal(r.status, 'not-found');
  });

  it('two cards with one title tie: the engine reports both and takes neither', () => {
    const page = [button('Add to cart', 'Backpack'), button('Add to cart', 'Backpack'), button('Add to cart', 'Bike Light')];
    const r = find(page, 'Backpack card');
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.status === 'ambiguous' && r.candidates.length, 2);
  });

  it('a title that holds the name is meant when no title is the name; an exact title wins over a longer one', () => {
    const long = [button('Add to cart', 'Sauce Labs Backpack'), button('Add to cart', 'Bike Light')];
    assert.equal(indexOf(find(long, 'Backpack card')), long[0]?.index);
    const both = [button('Add to cart', 'Backpack Pro'), button('Add to cart', 'Backpack')];
    assert.equal(indexOf(find(both, 'Backpack card')), both[1]?.index, 'the card titled Backpack, not Backpack Pro');
  });

  it('a nested card: an element inside both is in each of them, and the nearest title is the one the page gave it first', () => {
    const inner = button('Add to cart', 'Backpack', 'Products');
    const page = [inner, button('Add to cart', 'Bike Light', 'Products')];
    assert.equal(indexOf(find(page, 'Backpack card')), inner.index);
    assert.equal(find(page, 'Products section').status, 'ambiguous', 'the section holds both buttons');
  });

  it('a place that is not a container is read as it was: the form or an ancestor the page names', () => {
    const inForm: DomElement = { ...button('Add to cart'), form: 'checkout', parents: ['form#checkout'] };
    assert.equal(find([inForm], 'checkout').status, 'found');
    assert.equal(find([button('Add to cart', 'Backpack')], 'the Login page').status, 'not-found');
  });
});
