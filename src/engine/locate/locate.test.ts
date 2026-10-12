import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { toLocator } from '../../locators/locator.js';
import { type DomElement, inspectPage, LEVELS, type LocateQuery, type LocateResult, locate, toLocatorSpec, WEIGHT } from './index.js';

/**
 * E0.6 exit tests, locator part, on the fixture pages of test/dom/ in a real Chrome: every target found, or reported as
 * ambiguous where two equal candidates exist; label cells; hidden, disabled, covered and duplicate elements; the order of
 * the candidate levels. Needs Google Chrome and no internet. AUTO_QA_SKIP_BROWSER=1 skips them.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name: string): string => pathToFileURL(path.join(root, 'test', 'dom', name)).href;
const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

describe('LC-01, LA-01, DM-01 on the DOM fixture pages', { skip }, () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch({ channel: 'chrome' });
    page = await browser.newPage();
  });
  after(async () => {
    await browser?.close();
  });

  const open = async (name: string): Promise<DomElement[]> => {
    await page.goto(fixture(name));
    return inspectPage(page);
  };
  const find = (elements: DomElement[], query: LocateQuery): LocateResult => locate(query, elements);
  const idsOf = (r: LocateResult): string[] => (r.status === 'ambiguous' ? r.candidates.map((c) => c.id ?? '') : []);

  describe('the label-cell page (OrangeHRM style)', () => {
    it('"Password :" in the cell before the field gives one field, not two', async () => {
      const els = await open('label-cell.html');
      const r = find(els, { name: 'password', ontology: 'Password' });
      assert.equal(r.status, 'found');
      if (r.status !== 'found') return;
      assert.equal(r.element.nameAttr, 'txtPassword');
      assert.equal(r.level, 'relationship', 'it is named by the text next to it');
      assert.equal(r.element.nearbyText, 'Password :');
      // The cell and the hint "Forgot your Password :" are text, not fields: neither is a candidate.
      assert.equal(r.tried.find((t) => t.level === 'text')?.matches, 0);
      assert.equal(r.ignored.length, 0);
    });
    it('"login name", "username" and "user name" all give the same field', async () => {
      const els = await open('label-cell.html');
      const found = ['login name', 'Login Name text box', 'Login Name :'].map((n) => find(els, { name: n, ontology: 'Username' }));
      const viaAlias = find(els, { name: 'username', aliases: ['login name'], ontology: 'Username' });
      for (const r of [...found, viaAlias]) {
        assert.equal(r.status, 'found');
        assert.equal(r.status === 'found' && r.element.id, 'txtUserName');
      }
    });
    it('a button called by its value is a button: "Clear" and "LOGIN"', async () => {
      const els = await open('label-cell.html');
      assert.equal(find(els, { name: 'Clear', ontology: 'Button' }).status, 'found');
      const login = find(els, { name: 'login', ontology: 'Button' });
      assert.equal(login.status, 'found');
      assert.equal(login.status === 'found' && login.level, 'role', 'role, with the name written on it');
    });
    it('reads what the page shows of the field (DM-01)', async () => {
      const els = await open('label-cell.html');
      await page.focus('input[name=txtPassword]');
      const again = await inspectPage(page);
      const f = again.find((e) => e.nameAttr === 'txtPassword') as DomElement;
      assert.deepEqual([f.tag, f.type, f.role], ['input', 'password', 'textbox']);
      assert.equal(f.visible, true);
      assert.equal(f.covered, false);
      assert.equal(f.disabled, false);
      assert.equal(f.focused, true, 'it has the focus');
      assert.equal(f.focusable, true);
      assert.ok(f.box.width > 20 && f.box.height > 5);
      assert.deepEqual(f.parents.slice(0, 3), ['td', 'tr', 'tbody']);
      assert.equal(f.form, 'frmLogin');
      assert.ok(f.xpath.startsWith('//*[@id='), f.xpath);
      assert.equal(els.find((e) => e.nameAttr === 'txtUserName')?.focused, false);
      assert.equal(f.inDialog, false);
    });
  });

  describe('the order of the candidate levels (LC-01)', () => {
    it('lists the eleven levels of the specification, with falling weights', () => {
      assert.deepEqual([...LEVELS], ['testId', 'role', 'accessibleName', 'label', 'placeholder', 'name', 'id', 'text', 'relationship', 'xpath', 'inspection']);
      const weights = LEVELS.map((l) => WEIGHT[l]);
      for (let i = 1; i < weights.length; i++) assert.ok((weights[i] as number) < (weights[i - 1] as number), `${LEVELS[i]} weighs less than ${LEVELS[i - 1]}`);
    });
    it('takes the test id over the role, the role over the name, … down to the text, as each winner is taken away', async () => {
      await page.goto(fixture('order.html'));
      const expected = ['testId', 'role', 'accessibleName', 'label', 'placeholder', 'name', 'id', 'text'] as const;
      for (const [i, level] of expected.entries()) {
        const els = await inspectPage(page);
        const r = locate({ name: 'quantity' }, els);
        assert.equal(r.status, 'found', level);
        if (r.status !== 'found') return;
        assert.equal(r.level, level);
        assert.equal(r.weight, WEIGHT[level]);
        // Every level above was tried first and found nothing; they are logged with their weights, in order.
        assert.deepEqual(
          r.tried.map((t) => t.level),
          LEVELS.slice(0, LEVELS.indexOf(level) + 1),
        );
        assert.deepEqual(
          r.tried.slice(0, -1).map((t) => t.outcome),
          r.tried.slice(0, -1).map(() => 'nothing'),
        );
        assert.equal(r.tried.at(-1)?.outcome, 'used');
        // The locator the level gives finds exactly this element on the page.
        const spec = toLocatorSpec(r.level, r.element);
        assert.ok(spec, level);
        const locator = toLocator(page, spec);
        assert.equal(await locator.count(), 1, `${level}: ${spec.method}(${spec.arg}) finds one element`);
        assert.equal(await locator.first().getAttribute('data-e'), String(i + 1), `${level} finds the winner`);
        // An element and its label are taken away together.
        await page.evaluate((n) => {
          for (const e of Array.from(document.querySelectorAll(`[data-e="${n}"]`))) e.remove();
        }, i + 1);
      }
      assert.equal(locate({ name: 'quantity' }, await inspectPage(page)).status, 'not-found');
    });
    it('uses the text next to a field when nothing in the field itself says its name', async () => {
      const r = find(await open('relationship.html'), { name: 'quantity', ontology: 'Field' });
      assert.equal(r.status === 'found' && r.level, 'relationship');
    });
    it('uses the XPath of the knowledge, and then an inspection, only when nothing above finds it', async () => {
      const els = await open('relationship.html');
      const input = els.find((e) => e.tag === 'input') as DomElement;
      const byXpath = find(els, { name: 'zzz unknown', xpath: input.xpath });
      assert.equal(byXpath.status === 'found' && byXpath.level, 'xpath');
      const byInspection = locate({ name: 'zzz unknown' }, els, { inspection: () => [input] });
      assert.equal(byInspection.status === 'found' && byInspection.level, 'inspection');
      assert.equal(byInspection.status === 'found' && byInspection.weight, WEIGHT.inspection);
      assert.equal(locate({ name: 'zzz unknown' }, els).status, 'not-found');
    });
  });

  describe('hidden, disabled, covered and duplicate elements (LA-01)', () => {
    it('never chooses a hidden, invisible, faded, disabled or covered element, and says why', async () => {
      const els = await open('states.html');
      const cases: Array<[string, string]> = [
        ['Hidden Action', 'display:none'],
        ['Invisible Action', 'visibility:hidden'],
        ['Faded Action', 'opacity:0'],
        ['Disabled Action', 'disabled'],
        ['Covered Action', 'covered by span#shield'],
      ];
      for (const [name, why] of cases) {
        const r = find(els, { name, ontology: 'Button' });
        assert.equal(r.status, 'inactive', name);
        assert.equal(r.passAllowed, false, `${name}: no PASS on it`);
        assert.ok(r.status === 'inactive' && r.reason.includes(why), `${name}: ${r.status === 'inactive' ? r.reason : ''}`);
      }
    });
    it('a disabled button is the right one when a check looks at it ("Verify the button is disabled")', async () => {
      const r = find(await open('states.html'), { name: 'Disabled Action', ontology: 'Button', purpose: 'inspect' });
      assert.equal(r.status, 'found');
      assert.equal(r.status === 'found' && r.element.disabled, true);
    });
    it('reports two elements that sit on each other as overlapping layers, not as one', async () => {
      const r = find(await open('states.html'), { name: 'Stacked Action', ontology: 'Button' });
      assert.equal(r.status, 'ambiguous');
      assert.ok(r.status === 'ambiguous' && r.reason.includes('overlapping layers'), r.status === 'ambiguous' ? r.reason : '');
      assert.equal(r.passAllowed, false);
    });
    it('finds an element that is fine, and nothing that is not there', async () => {
      const els = await open('states.html');
      assert.equal(find(els, { name: 'Fine Action', ontology: 'Button' }).status, 'found');
      const none = find(els, { name: 'Missing Action', ontology: 'Button' });
      assert.equal(none.status, 'not-found');
      assert.equal(none.status === 'not-found' && none.tried.length, 11, 'every level was tried');
      assert.equal(none.passAllowed, false);
    });
    it('two equal "Save" buttons are ambiguous: both are shown, none is chosen', async () => {
      const r = find(await open('duplicates.html'), { name: 'Save', ontology: 'Button' });
      assert.equal(r.status, 'ambiguous');
      assert.deepEqual(idsOf(r).sort(), ['save-a', 'save-b']);
      assert.equal(r.passAllowed, false);
      assert.ok(r.status === 'ambiguous' && r.candidates.every((c) => c.box.width > 0), 'with where they are, for the screenshot');
    });
    it('the container the tester named tells two buttons apart: "Submit" in the address form', async () => {
      const els = await open('duplicates.html');
      assert.equal(find(els, { name: 'Submit', ontology: 'Button' }).status, 'ambiguous');
      const r = find(els, { name: 'Submit', ontology: 'Button', within: 'address' });
      assert.equal(r.status === 'found' && r.element.id, 'submit-2');
    });
    it('a hidden twin is not chosen and is listed as ignored, with its reason', async () => {
      const r = find(await open('duplicates.html'), { name: 'Delete', ontology: 'Button' });
      assert.equal(r.status, 'found');
      assert.equal(r.status === 'found' && r.element.id, 'delete-visible');
      assert.deepEqual(r.status === 'found' ? r.ignored.map((i) => [i.element.id, i.reason]) : [], [['delete-hidden', 'hidden (display:none)']]);
    });
    it('an open dialog holds the user: the "OK" in it is meant, not the one behind', async () => {
      const r = find(await open('duplicates.html'), { name: 'OK', ontology: 'Button' });
      assert.equal(r.status === 'found' && r.element.id, 'ok-dialog');
      assert.equal(r.status === 'found' && r.element.inDialog, true);
    });
  });

  describe('purity', () => {
    it('gives the same result for the same page and query, and changes nothing in the facts', async () => {
      const els = await open('duplicates.html');
      const copy = JSON.stringify(els);
      const a = JSON.stringify(find(els, { name: 'Delete', ontology: 'Button' }));
      const b = JSON.stringify(find(els, { name: 'Delete', ontology: 'Button' }));
      assert.equal(a, b);
      assert.equal(JSON.stringify(els), copy);
      assert.equal(JSON.stringify(await inspectPage(page)), copy, 'and the page is read the same way twice');
    });
  });
});
