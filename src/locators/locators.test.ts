import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseSnapshot } from '../explorer/snapshot-parser.js';
import { defaultParserConfig } from '../parser/config.js';
import { buildLadder, type ElementFacts, fingerprint, isStableId, pageOf } from './ladder.js';
import { parseLocatorCode, spec, toCode } from './locator.js';
import { findCandidates, levenshtein, SCORE, type TargetQuery } from './match.js';

const config = defaultParserConfig();
const fixture = (name: string) => parseSnapshot(readFileSync(new URL(`../explorer/fixtures/${name}.yaml`, import.meta.url), 'utf8'));
const saucedemo = fixture('saucedemo-login');
const checkboxes = fixture('the-internet-checkboxes');
const q = (kind: TargetQuery['kind'], target?: string, more: Partial<TargetQuery> = {}): TargetQuery => ({ kind, target, alternatives: [], ...more });
const best = (query: TargetQuery, nodes = saucedemo) => {
  const r = findCandidates(query, nodes, config);
  return r.status === 'matched' ? { ref: r.best.node.ref, how: r.best.how, score: r.best.score } : { review: r.code };
};

describe('candidate filter (FR-LO-03)', () => {
  it('only considers roles the action works on', () => {
    // "Login" is also the form's name, but a form cannot be clicked or filled.
    assert.deepEqual(best(q('click', 'Login')), { ref: 'e15', how: 'exact', score: 1 });
    assert.deepEqual(best(q('fill', 'Login')), { review: 'NO_MATCH' });
  });

  it('lets assertions target any element', () => {
    assert.equal(best(q('visible', 'Accepted usernames are:')).ref, 'e19');
  });
});

describe('scoring (FR-LO-04)', () => {
  it('matches names ignoring case and punctuation', () => {
    assert.deepEqual(best(q('fill', 'user name')), { ref: 'e11', how: 'exact', score: 1 });
  });

  it('uses synonyms', () => {
    assert.deepEqual(best(q('fill', 'email')), { ref: 'e11', how: 'synonym', score: SCORE.synonym });
    assert.deepEqual(best(q('click', 'Sign in')), { ref: 'e15', how: 'synonym', score: SCORE.synonym });
  });

  it('accepts a small typo with a lower score', () => {
    const r = best(q('fill', 'Pasword'));
    assert.equal(r.ref, 'e13');
    assert.equal(r.how, 'fuzzy');
    assert.ok(r.score! < SCORE.synonym);
  });

  it('matches whole words inside a longer name', () => {
    const nodes = parseSnapshot('- button "Add to cart" [ref=e1]\n- button "Remove" [ref=e2]');
    assert.equal(best(q('click', 'Add'), nodes).how, 'contains');
    // "Remove" must not match "Re" inside another word.
    assert.deepEqual(best(q('click', 'Re'), nodes), { review: 'NO_MATCH' });
  });

  it('uses the alternatives the tester gave', () => {
    assert.equal(best(q('click', 'Submit', { alternatives: ['Login'] })).ref, 'e15');
  });

  it('only accepts an exact name when the tester quoted it', () => {
    assert.deepEqual(best(q('fill', 'email', { exact: true })), { review: 'NO_MATCH' });
    assert.equal(best(q('fill', 'USERNAME', { exact: true })).ref, 'e11');
  });

  it('names unlabeled elements from nearby text', () => {
    const r = findCandidates(q('check', 'checkbox 1'), checkboxes, config);
    assert.equal(r.status, 'matched');
    assert.equal(r.status === 'matched' && r.best.node.ref, 'f1e10');
    assert.equal(r.status === 'matched' && r.best.source, 'nearby');
  });

  it('names an unlabeled field from the heading just above it', () => {
    const nodes = parseSnapshot('- generic:\n  - heading "Dropdown List" [level=3] [ref=e8]\n  - combobox [ref=e9]');
    assert.equal(best(q('select', 'dropdown list', { roleHint: 'combobox' }), nodes).ref, 'e9');
  });

  it('prefers the role the tester named, and notes a mismatch', () => {
    const nodes = parseSnapshot('- link "Help" [ref=e1]\n- button "Help" [ref=e2]');
    assert.equal(best(q('click', 'Help', { roleHint: 'button' }), nodes).ref, 'e2');
    const mismatch = findCandidates(q('click', 'Login', { roleHint: 'link' }), saucedemo, config);
    assert.ok(mismatch.status === 'matched' && mismatch.best.notes.some((n) => n.includes('the step says link')));
  });

  it('prefers an element inside an open dialog', () => {
    const nodes = parseSnapshot('- button "OK" [ref=e1]\n- dialog "Confirm" [ref=e2]:\n  - button "OK" [ref=e3]');
    // Exactly the dialog bonus apart, which is inside the margin: the tester must choose.
    assert.deepEqual(best(q('click', 'OK'), nodes), { review: 'AMBIGUOUS' });
  });

  it('is deterministic', () => {
    const a = findCandidates(q('click', 'Login'), saucedemo, config);
    const b = findCandidates(q('click', 'Login'), saucedemo, config);
    assert.deepEqual(
      a.candidates.map((c) => [c.node.ref, c.score]),
      b.candidates.map((c) => [c.node.ref, c.score]),
    );
  });

  it('computes edit distance', () => {
    assert.equal(levenshtein('password', 'pasword'), 1);
    assert.equal(levenshtein('', 'abc'), 3);
  });
});

describe('ambiguity rule (FR-LO-05)', () => {
  it('never picks between two equal elements', () => {
    const nodes = parseSnapshot('- button "Save" [ref=e1]\n- button "Save" [ref=e2]');
    const r = findCandidates(q('click', 'Save'), nodes, config);
    assert.equal(r.status, 'needs-review');
    assert.equal(r.status === 'needs-review' && r.code, 'AMBIGUOUS');
    assert.equal(r.candidates.length, 2);
  });

  it('asks when nothing matches well enough', () => {
    assert.deepEqual(best(q('click', 'Checkout')), { review: 'NO_MATCH' });
  });

  it('picks the only element of the named role when the step names none', () => {
    const nodes = parseSnapshot('- combobox [ref=e9]\n- button "Go" [ref=e10]');
    assert.deepEqual(best(q('select', undefined, { roleHint: 'combobox' }), nodes), { ref: 'e9', how: 'only-one', score: SCORE.onlyOne });
    const two = parseSnapshot('- combobox [ref=e1]\n- combobox [ref=e2]');
    assert.deepEqual(best(q('select', undefined, { roleHint: 'combobox' }), two), { review: 'NO_TARGET' });
  });
});

describe('locator specs (FR-LO-06, FR-LO-07)', () => {
  it('prints Playwright code', () => {
    assert.equal(toCode(spec('getByRole', 'button', { name: 'Login', exact: true })), "getByRole('button', { name: 'Login', exact: true })");
    assert.equal(toCode(spec('getByText', "It's here")), "getByText('It\\'s here')");
    assert.equal(toCode({ ...spec('getByRole', 'checkbox'), nth: 1 }), "getByRole('checkbox').nth(1)");
  });

  it('reads the code MCP prints', () => {
    assert.deepEqual(parseLocatorCode("getByTestId('username')"), { strategy: 'testid', method: 'getByTestId', arg: 'username', source: 'mcp' });
    assert.deepEqual(parseLocatorCode("await page.getByRole('button', { name: 'Log \"in\"' }).click();"), {
      strategy: 'role',
      method: 'getByRole',
      arg: 'button',
      options: { name: 'Log "in"' },
      source: 'mcp',
    });
    assert.equal(parseLocatorCode("locator('#user-name')")?.strategy, 'css');
    assert.equal(parseLocatorCode("locator('//form/input')")?.strategy, 'xpath');
    assert.equal(parseLocatorCode("getByRole('checkbox').first()")?.nth, 0);
    assert.equal(parseLocatorCode("getByRole('checkbox').nth(2)")?.nth, 2);
  });

  it('round-trips its own code', () => {
    for (const code of ["getByRole('button', { name: 'Login', exact: true })", "getByPlaceholder('Search…')", "getByRole('checkbox').last()"]) {
      const parsed = parseLocatorCode(code, 'ladder');
      assert.ok(parsed, code);
      assert.equal(toCode(parsed), code);
    }
  });

  it('skips anything it cannot represent instead of misreading it', () => {
    for (const code of [
      "locator('form').getByRole('button')",
      'getByText(/log ?in/i)',
      "getByRole('button', { name: 'x', level: 2 })",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a template literal is exactly what must be rejected
      'getByText(`a ${b}`)',
      "frameLocator('iframe').getByText('x')",
      'evaluate(() => 1)',
    ]) {
      assert.equal(parseLocatorCode(code), undefined, code);
    }
  });
});

describe('ladder, fingerprint and page (FR-LO-06, FR-LO-10, FR-LO-11)', () => {
  const node = saucedemo[0].children[1].children[0].children[0]; // textbox "Username"
  const facts: ElementFacts = {
    tag: 'input',
    type: 'text',
    id: 'user-name',
    nameAttr: 'user-name',
    placeholder: 'Username',
    testId: 'username',
    labels: ['User'],
    form: 'login',
    xpath: "//div[@id='login_button_container']/div/form/div[1]/input",
  };

  it('builds rungs in ladder order', () => {
    assert.equal(node.name, 'Username');
    assert.deepEqual(buildLadder(node, facts).map(toCode), [
      "getByTestId('username')",
      "getByRole('textbox', { name: 'Username', exact: true })",
      "getByLabel('User', { exact: true })",
      "getByPlaceholder('Username', { exact: true })",
      "locator('#user-name')",
      "locator('xpath=//div[@id=\\'login_button_container\\']/div/form/div[1]/input')",
    ]);
  });

  it('adds the MCP suggestion once, at its place, with position-based locators last', () => {
    const ladder = buildLadder(node, facts, [parseLocatorCode("getByTestId('username')")!, parseLocatorCode("getByRole('textbox').first()")!]);
    assert.equal(ladder.filter((s) => s.strategy === 'testid').length, 1);
    assert.equal(toCode(ladder.at(-1)!), "getByRole('textbox').first()");
  });

  it('uses a name attribute when the id looks generated', () => {
    assert.ok(!isStableId('input-12345'));
    assert.ok(!isStableId(':r1:'));
    assert.ok(isStableId('user-name'));
    const ladder = buildLadder(node, { ...facts, id: 'ember123', testId: undefined }).map(toCode);
    assert.ok(ladder.includes(`locator('input[name="user-name"]')`));
  });

  it('stores a fingerprint without empty fields', () => {
    assert.deepEqual(fingerprint(node, { ...facts, placeholder: '' }, 'form "Login"'), {
      role: 'textbox',
      name: 'Username',
      tag: 'input',
      type: 'text',
      label: 'User',
      testId: 'username',
      id: 'user-name',
      nameAttr: 'user-name',
      form: 'login',
      context: 'form "Login"',
    });
  });

  it('names the page from the tester, the path, then the title', () => {
    assert.equal(pageOf('https://www.saucedemo.com/', 'Swag Labs', 'Login').name, 'LoginPage');
    assert.equal(pageOf('https://www.saucedemo.com/inventory.html', 'Swag Labs').name, 'InventoryPage');
    assert.equal(pageOf('https://www.saucedemo.com/', 'Swag Labs').name, 'SwagLabsPage');
    assert.equal(pageOf('https://example.com/', '').name, 'HomePage');
    assert.equal(pageOf('https://example.com/a/b?x=1', 't').path, '/a/b');
  });
});
