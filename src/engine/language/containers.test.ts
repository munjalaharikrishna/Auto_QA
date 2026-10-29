import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { containerRef } from '../ir/container.js';
import { compileCase } from '../pipeline/compile.js';

/**
 * UI-07: a sentence that names a card keeps the card, in a step and in a check, whichever way it is written. A card dropped from the
 * reading is a step or a check about the whole page, which is the wrong thing done or proven. What names no card is read as before.
 */

const stepOf = async (step: string) =>
  (await compileCase({ id: 'T', title: 'T', steps: `1. ${step}`, expected: 'The cart is displayed' }, { env: {} })).ir?.steps[0];
const checkOf = async (expected: string) => {
  const c = await compileCase({ id: 'T', title: 'T', steps: '1. Open the Shop page', expected }, { env: {} });
  assert.ok(c.ir, JSON.stringify(c.issues));
  return c.ir.expectations[0];
};

describe('a step about a card keeps the card', () => {
  for (const [text, name] of [
    ["Click the Add to cart button on the 'Backpack' card", 'Add to cart'],
    ['Click Add to cart on the Backpack card', 'Add to cart'],
    ["Click 'Add to cart' in the Backpack card", 'Add to cart'],
    ['Click the Remove from cart button on the Backpack card', 'Remove from cart'],
  ] as const) {
    it(text, async () => {
      const step = await stepOf(text);
      assert.equal(step?.action, 'CLICK');
      assert.equal(step?.target?.name, name);
      assert.equal(containerRef(step?.target?.within)?.text, 'backpack', JSON.stringify(step?.target));
    });
  }

  it('a place that is not a repeated widget is not a container: the step is read as it always was', async () => {
    assert.equal((await stepOf('Click the Login button on the Login page'))?.target?.within, undefined);
    assert.equal((await stepOf('Click Edit for John Smith'))?.target?.row?.[0], 'John Smith', 'a row is a row, not a card');
  });
});

describe('a check about a card keeps the card', () => {
  it('"is displayed on the card", with and without a "from" in the name, and not displayed', async () => {
    const shown = await checkOf('The Remove from cart button is displayed on the Backpack card');
    assert.deepEqual(
      [shown?.condition.type, shown?.condition.target?.name, shown?.condition.target?.within],
      ['VISIBILITY', 'Remove from cart', 'backpack card'],
    );
    const plain = await checkOf('The Remove button is displayed in the Backpack card');
    assert.equal(plain?.condition.target?.within, 'backpack card');
    const absent = await checkOf('The Add to cart button is not displayed on the Bolt T-Shirt card');
    assert.equal(absent?.negated, true);
    assert.equal(absent?.condition.target?.within, 'bolt t-shirt card');
  });

  it('a text said to be on a card is looked for in what the card shows', async () => {
    const quoted = await checkOf("'$29.99' is displayed on the Backpack card");
    assert.deepEqual(
      [quoted?.condition.type, quoted?.condition.check, quoted?.condition.expect, quoted?.condition.target?.within],
      ['TEXT', 'contains-text', '$29.99', 'backpack card'],
    );
    const contains = await checkOf("The Bike Light card contains 'Add to cart'");
    assert.deepEqual(
      [contains?.condition.type, contains?.condition.expect, contains?.condition.target?.within?.toLowerCase()],
      ['TEXT', 'Add to cart', 'the bike light card'],
    );
  });

  it('"The card shows X": X is shown in that card, and a "from" in its name is part of the name', async () => {
    const shows = await checkOf('The Backpack card shows the Remove from cart button');
    assert.deepEqual(
      [shows?.condition.target?.name, shows?.condition.target?.ontology, shows?.condition.target?.within?.toLowerCase()],
      ['Remove from cart', 'Button', 'the backpack card'],
    );
    const price = await checkOf('The Backpack card shows the price $29.99');
    assert.equal(price?.condition.target?.within?.toLowerCase(), 'the backpack card');
  });

  it('a place that is a page, and a list after "from", are read as before', async () => {
    const page = await checkOf('The Added data is displayed on the Personal Information page');
    assert.equal(page?.condition.target?.within, 'personal information page');
    const tabs = await checkOf('The tabs from Admin, PIM and Leave are displayed');
    assert.equal(tabs?.condition.target?.within, 'Admin, PIM and Leave');
    assert.equal(tabs?.condition.target?.label, 'tabs');
  });

  it('a button called "Remove from cart" is that button wherever it is written', async () => {
    assert.equal((await stepOf('Click the Remove from cart button'))?.target?.name, 'Remove from cart');
    assert.equal((await checkOf('The Remove from cart button is displayed'))?.condition.target?.name, 'Remove from cart');
  });
});
