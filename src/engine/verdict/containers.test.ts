import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunTrace, StepRecord } from '../execute/executor.js';
import type { Observation, ObservedContainer, ObservedElement } from '../execute/observe.js';
import { planActions } from '../execute/planner.js';
import { compileCase } from '../pipeline/compile.js';
import { judge, type Verdict } from './index.js';

/**
 * UI-07: a check about a card is judged on that card and nothing else on the page. The shop below has three cards; the checks are
 * written about one of them. What another card shows never proves a check about this one, a card that is not there is not judged on
 * the whole page, and two cards with one title are not told apart by taking the first.
 */

const page = (p: Partial<Observation> = {}): Observation => ({
  url: 'http://app/shop',
  title: 'Shop',
  lines: [],
  elements: [],
  messages: [],
  fieldErrors: [],
  tabs: 1,
  ...p,
});
const button = (name: string, ...inside: string[]): ObservedElement => ({
  identity: `${name}@${inside.join('/')}`,
  role: 'button',
  name,
  tag: 'button',
  disabled: false,
  invalid: false,
  ...(inside.length ? { inside } : {}),
});

const card = (name: string, ...lines: string[]): ObservedContainer => ({ name, lines: [name, ...lines] });

/** The shop: the Backpack is in the cart (Remove), the Bike Light is not (Add), the Bolt T-Shirt is sold out (no button). */
const SHOP = {
  containers: [
    card('Backpack', 'Price: $29.99', 'In cart', 'Remove from cart'),
    card('Bike Light', 'Price: $9.99', 'Add to cart'),
    card('Bolt T-Shirt', 'Price: $15.99', 'Sold out'),
  ],
  elements: [button('Remove from cart', 'Backpack'), button('Add to cart', 'Bike Light')],
  lines: [
    'Shop',
    'Backpack',
    'Price: $29.99',
    'In cart',
    'Remove from cart',
    'Bike Light',
    'Price: $9.99',
    'Add to cart',
    'Bolt T-Shirt',
    'Price: $15.99',
    'Sold out',
  ],
};

async function run(expected: string, shop: Partial<Observation> = SHOP): Promise<Verdict> {
  const compile = await compileCase({ id: 'T-CARD', title: 'A card', steps: '1. Open the Shop page', expected }, { env: {} });
  assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
  const chain = planActions(compile.ir, compile.plan).chains;
  const steps: StepRecord[] = chain.map((ch) => ({
    step: ch.step,
    action: ch.action,
    original: ch.original,
    status: 'done',
    calls: [],
    changes: [],
    dialogs: [],
    checksAfter: ch.checksAfter,
    notes: [],
    before: page({ url: 'http://app/' }),
    after: page(shop),
  }));
  const trace: RunTrace = { testId: 'T-CARD', status: 'completed', capabilities: [], steps };
  return judge({ compile, trace });
}

describe('a check about a card is judged on that card', () => {
  it('what the card shows proves it: the Remove button on the Backpack card', async () => {
    const v = await run('The Remove button is displayed on the Backpack card');
    assert.equal(v.verdict, 'PASS', v.reason);
  });

  it('a button name with "from" in it keeps its card: "Remove from cart" on the Backpack card, not a button called Remove anywhere', async () => {
    const shop = { ...SHOP, elements: [button('Remove from cart', 'Backpack'), button('Add to cart', 'Bike Light')] };
    assert.equal((await run('The Remove from cart button is displayed on the Backpack card', shop)).verdict, 'PASS');
    const wrong = await run('The Remove from cart button is displayed on the Bike Light card', shop);
    assert.notEqual(wrong.verdict, 'PASS', 'the Remove from cart button is on the Backpack card');
    assert.equal(wrong.evaluations[0]?.result, 'disproven');
  });

  it('what another card shows does not: a Remove button on the Bike Light card does not prove one on the Backpack card, or the reverse', async () => {
    const wrong = await run('The Remove button is displayed on the Bike Light card');
    assert.notEqual(wrong.verdict, 'PASS', 'the Bike Light card has only Add to cart');
    assert.equal(wrong.evaluations[0]?.result, 'disproven');
    assert.ok(wrong.evaluations[0]?.actual.includes('not on the page'), wrong.evaluations[0]?.actual);
    const reverse = await run('The Add to cart button is displayed on the Backpack card');
    assert.notEqual(reverse.verdict, 'PASS');
  });

  it('a card that is not on the page cannot be judged: it is not a reason to look at the whole page', async () => {
    const v = await run('The Remove button is displayed on the Umbrella card');
    assert.equal(v.verdict, 'NEEDS_REVIEW');
    assert.equal(v.evaluations[0]?.result, 'unproven');
    assert.equal(v.evaluations[0]?.doubt, 'NOT_FOUND');
    assert.ok(v.evaluations[0]?.actual.includes('no card named "umbrella"'), v.evaluations[0]?.actual);
  });

  it('two cards with one title are not told apart: the engine does not pick one', async () => {
    const twins = {
      ...SHOP,
      containers: [card('Backpack', 'Price: $29.99', 'Add to cart'), card('Backpack', 'Price: $34.99', 'Remove from cart'), card('Bike Light', 'Add to cart')],
    };
    const v = await run('The Remove button is displayed on the Backpack card', twins);
    assert.equal(v.verdict, 'NEEDS_REVIEW');
    assert.equal(v.evaluations[0]?.doubt, 'AMBIGUOUS');
    assert.ok(v.evaluations[0]?.actual.includes('2 containers are named "backpack"'), v.evaluations[0]?.actual);
  });
});

describe('"is not displayed" on a card cannot pass because the card is missing', () => {
  it('holds when the card is there and does not show it: no Add to cart on the sold-out card', async () => {
    const v = await run('The Add to cart button is not displayed on the Bolt T-Shirt card');
    assert.equal(v.verdict, 'PASS', v.reason);
  });

  it('does not hold when the card shows it, though other cards do not', async () => {
    const v = await run('The Remove button is not displayed on the Backpack card');
    assert.notEqual(v.verdict, 'PASS');
    assert.equal(v.evaluations[0]?.result, 'disproven');
  });

  it('is not proven by a card that is not there: nothing is shown on a card that does not exist', async () => {
    const v = await run('The Add to cart button is not displayed on the Umbrella card');
    assert.equal(v.verdict, 'NEEDS_REVIEW', 'a "not shown" must not pass on a card the engine never found');
    assert.equal(v.evaluations[0]?.doubt, 'NOT_FOUND');
  });
});

describe('text said to be in a card is looked for in that card', () => {
  it('the price of the Backpack is on the Backpack card', async () => {
    const v = await run("'$29.99' is displayed on the Backpack card");
    assert.equal(v.verdict, 'PASS', v.reason);
  });

  it('the price of another card is not: $9.99 is on the Bike Light card, and was on the page', async () => {
    const v = await run("'$9.99' is displayed on the Backpack card");
    assert.notEqual(v.verdict, 'PASS', 'the text is on the page, but not on this card');
    assert.equal(v.evaluations[0]?.result, 'disproven');
  });

  it('a card that contains a text, and one that shows a thing', async () => {
    assert.equal((await run("The Bike Light card contains 'Add to cart'")).verdict, 'PASS');
    assert.notEqual((await run("The Backpack card contains 'Add to cart'")).verdict, 'PASS');
    assert.equal((await run('The Backpack card shows the Remove from cart button')).verdict, 'PASS');
    assert.notEqual((await run('The Bike Light card shows the Remove from cart button')).verdict, 'PASS');
  });

  it('a text on a card that is not there is not judged', async () => {
    const v = await run("'$29.99' is displayed on the Umbrella card");
    assert.equal(v.verdict, 'NEEDS_REVIEW');
  });
});

describe('what is not a card is read as it was', () => {
  it('a section with no container of that name keeps the page-wide reading: many pages show a section that no markup names', async () => {
    const v = await run('The Remove button is displayed in the Products section');
    assert.equal(v.verdict, 'PASS', v.reason);
  });

  it('a page name is not a container: the check is on the page', async () => {
    const v = await run('The Remove button is displayed on the Shop page');
    assert.equal(v.verdict, 'PASS', v.reason);
  });

  it('a section that is named in the markup is scoped: a Remove button is not in the Bike Light section', async () => {
    const withSections = { ...SHOP, containers: [...SHOP.containers, card('Order summary', 'Total: $0')] };
    assert.notEqual((await run('The Remove button is displayed in the Order summary section', withSections)).verdict, 'PASS');
  });
});
