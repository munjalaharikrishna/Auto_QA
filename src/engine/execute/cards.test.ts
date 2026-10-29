import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import { compileCase } from '../pipeline/compile.js';
import { judge, type Verdict } from '../verdict/index.js';
import { type ExecutionSession, executePlan, openExecutionSession, type RunTrace } from './index.js';
import { observe } from './observe.js';
import { planActions } from './planner.js';

/**
 * UI-07 on a real page: a shop whose cards look alike. The step acts on the card it names and on no other; a check about a card is
 * judged on that card; two cards with one title and a card that is not there are not guessed at. Needs Google Chrome and no internet.
 * AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

describe('cards: the intended item in the right card (UI-07)', { skip }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let session: ExecutionSession;
  before(async () => {
    app = await startDemoApp();
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  async function run(
    path: string,
    steps: string[],
    expected: string,
  ): Promise<{ trace: RunTrace; verdict: Verdict; after: Awaited<ReturnType<typeof observe>> }> {
    const lines = [`Open ${app.url}${path}`, ...steps];
    const compile = await compileCase({ id: 'T-CARDS', title: 'Cards', steps: lines.map((s, i) => `${i + 1}. ${s}`).join('\n'), expected }, { env: {} });
    assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
      { mcp: session.port, page: session.page, baseUrl: app.url },
    );
    // What the page showed is what the executor observed after the last step: the MCP server works in a tab of its own.
    const seen = trace.steps.at(-1)?.after;
    assert.ok(seen, 'the last step was observed');
    await session.reset();
    return { trace, verdict: judge({ compile, trace }), after: seen };
  }
  const cart = (o: { lines: string[] }): string => o.lines.find((l) => l.startsWith('Cart:')) ?? '';

  it('the page names its cards, and the elements know which card they are in', async () => {
    await session.page.goto(`${app.url}/ui/cards`);
    const seen = await observe(session.page);
    const names = (seen.containers ?? []).map((c) => c.name).sort();
    assert.deepEqual(names, ['Backpack', 'Bike Light', 'Bolt T-Shirt', 'Products']);
    // What the inspector says an element is inside, and what the observation says the page holds, are the same names.
    for (const e of seen.elements)
      for (const inside of e.inside ?? []) assert.ok(names.includes(inside), `${e.name} is inside "${inside}", which the observation does not list`);
    const buttons = seen.elements.filter((e) => e.role === 'button');
    assert.deepEqual(buttons.map((b) => b.inside?.[0]).sort(), ['Backpack', 'Bike Light']);
    const backpack = seen.containers?.find((c) => c.name === 'Backpack');
    assert.ok(backpack?.lines.includes('Price: $29.99') && !backpack.lines.includes('Price: $9.99'), 'a card has its own text only');
    await session.reset();
  });

  it('clicks Add to cart in the card the step names, and only there', async () => {
    const r = await run(
      '/ui/cards',
      ["Click the Add to cart button on the 'Bike Light' card"],
      'The Remove from cart button is displayed on the Bike Light card',
    );
    assert.equal(r.trace.status, 'completed', JSON.stringify(r.trace.stoppedAt));
    assert.equal(cart(r.after), 'Cart: Bike Light', 'the Bike Light is in the cart and nothing else');
    const state = (name: string) => r.after.containers?.find((c) => c.name === name)?.lines ?? [];
    assert.ok(state('Bike Light').includes('In cart'));
    assert.ok(!state('Backpack').includes('In cart'), 'the Backpack card was not touched');
    assert.equal(r.verdict.verdict, 'PASS', r.verdict.reason);
  });

  it('the same action, and a check about the card it did not touch, is not a PASS', async () => {
    const r = await run('/ui/cards', ['Click Add to cart on the Bike Light card'], 'The Remove from cart button is displayed on the Backpack card');
    assert.equal(cart(r.after), 'Cart: Bike Light');
    assert.notEqual(r.verdict.verdict, 'PASS', 'a Remove button is on the page, but on the Bike Light card, not the Backpack card');
    assert.equal(r.verdict.evaluations[0]?.result, 'disproven');
  });

  it('without a card, three look-alike buttons are not guessed: the run stops and nothing is clicked', async () => {
    const r = await run('/ui/cards', ['Click the Add to cart button'], 'The Remove from cart button is displayed');
    assert.equal(r.trace.stoppedAt?.code, 'LOCATE_AMBIGUOUS');
    assert.equal(cart(r.after), 'Cart: empty');
    assert.notEqual(r.verdict.verdict, 'PASS');
  });

  it('two cards with one title: the step is ambiguous, nothing is clicked, and a check on them is not judged', async () => {
    const act = await run('/ui/cards-twins', ['Click Add to cart on the Backpack card'], 'The Remove from cart button is displayed on the Backpack card');
    assert.equal(act.trace.stoppedAt?.code, 'LOCATE_AMBIGUOUS');
    assert.equal(cart(act.after), 'Cart: empty', 'neither Backpack was put in the cart');
    const check = await run('/ui/cards-twins', [], "'$34.99' is displayed on the Backpack card");
    assert.equal(check.verdict.verdict, 'NEEDS_REVIEW');
    assert.equal(check.verdict.evaluations[0]?.doubt, 'AMBIGUOUS');
    const other = await run('/ui/cards-twins', ['Click Add to cart on the Bike Light card'], 'The Remove from cart button is displayed on the Bike Light card');
    assert.equal(other.verdict.verdict, 'PASS', 'the card with a title of its own is still found');
    assert.equal(cart(other.after), 'Cart: Bike Light');
  });

  it('a card that is not on the page is not found, and a "not displayed" on it is not a PASS', async () => {
    const act = await run('/ui/cards', ['Click Add to cart on the Umbrella card'], 'The Remove from cart button is displayed on the Umbrella card');
    assert.equal(act.trace.stoppedAt?.code, 'LOCATE_NOT_FOUND');
    assert.equal(cart(act.after), 'Cart: empty');
    const absent = await run('/ui/cards', [], 'The Add to cart button is not displayed on the Umbrella card');
    assert.equal(absent.verdict.verdict, 'NEEDS_REVIEW', 'nothing is "not shown" on a card that was never found');
    assert.equal(absent.verdict.evaluations[0]?.doubt, 'NOT_FOUND');
  });

  it('text and buttons said to be on a card are looked for on that card', async () => {
    const cases: Array<[string, string, string]> = [
      ["'$29.99' is displayed on the Backpack card", 'PASS', 'the Backpack price is on the Backpack card'],
      ["'$9.99' is displayed on the Backpack card", 'FAIL', 'the Bike Light price is on the page, not on the Backpack card'],
      ["The Bike Light card contains 'Add to cart'", 'PASS', 'a card contains its own text'],
      ["The Bolt T-Shirt card shows 'Sold out'", 'PASS', 'a card shows its own text'],
      ['The Add to cart button is not displayed on the Bolt T-Shirt card', 'PASS', 'the sold-out card has no button, and says so'],
      ['The Add to cart button is not displayed on the Backpack card', 'FAIL', 'the Backpack card has one, though the Bolt card does not'],
    ];
    for (const [expected, want, why] of cases) {
      const r = await run('/ui/cards', [], expected);
      const got = r.verdict.verdict;
      assert.equal(got === 'PASS' ? 'PASS' : got === 'FAIL' ? 'FAIL' : got, want, `${expected}: ${why} (${r.verdict.reason})`);
    }
  });
});
