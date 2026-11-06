import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import type { Observation } from '../execute/observe.js';
import type { IrExpectation } from '../ir/schema.js';
import { evaluateExpectation } from '../verdict/evaluate.js';
import { findHolder, HOLDER_SELECTOR, type PageHolder, partWords, readHolders } from './holders.js';

/**
 * E0.17 item 2, nested containers, and the layout check that uses them. "The login section" is the innermost part of the page that
 * holds the login words and controls; the parts around it are measured too, and where they disagree a person decides (owner, 6 Nov).
 * The browser tests read the captured OrangeHRM 2.5 login page (test/dom/orangehrm-login.html). AUTO_QA_SKIP_BROWSER=1 skips them.
 */

const holder = (xpath: string, box: PageHolder['box'], text: string, controls = 4, fields = 2, frame: string[] = []): PageHolder => ({
  frame,
  xpath,
  tag: 'table',
  box,
  controls,
  fields,
  text,
});
const LOGIN = 'Login Name : Password : Login Clear';
const page = (holders: PageHolder[], width = 1280): Observation => ({
  url: 'http://x/login.php',
  title: 't',
  lines: [],
  elements: [],
  messages: [],
  fieldErrors: [],
  tabs: 1,
  holders,
  viewport: { width, height: 720 },
});
const judge = (obs: Observation, region = 'center', negated = false) => {
  const exp: IrExpectation = {
    id: 'E1',
    clause: 'Login section should be middle of the page',
    negated,
    condition: { type: 'LAYOUT', target: { ontology: 'Section', name: 'Login' }, region, check: 'region' },
    afterStep: 'S1',
  };
  const step = {
    step: 'S1',
    action: 'OPEN',
    original: 'Open',
    status: 'done',
    calls: [],
    changes: [],
    dialogs: [],
    checksAfter: ['E1'],
    notes: [],
    before: obs,
    after: obs,
  };
  return evaluateExpectation(exp, { steps: [step as never], stepOf: new Map([['E1', 'S1']]), seen: [obs], clause: '' } as never);
};

describe('E0.17 item 2: the part of the page a name means', () => {
  it('"the Login section" is the words `login`: the kind of part is not its name', () => {
    assert.deepEqual(partWords('the Login section'), ['login']);
    assert.deepEqual(partWords('Login form'), ['login']);
  });

  it('of holders inside each other, the innermost is meant, and the ones around it are listed nearest first', () => {
    const r = findHolder('Login section', [
      holder('/html[1]/body[1]/form[1]', { x: 0, y: 80, width: 1280, height: 400 }, LOGIN, 5),
      holder('/html[1]/body[1]/form[1]/table[1]', { x: 0, y: 80, width: 1280, height: 380 }, LOGIN),
      holder('/html[1]/body[1]/form[1]/table[1]/tbody[1]/tr[1]/td[2]/table[1]', { x: 256, y: 80, width: 717, height: 380 }, LOGIN),
      holder(
        '/html[1]/body[1]/form[1]/table[1]/tbody[1]/tr[1]/td[2]/table[1]/tbody[1]/tr[1]/td[2]/table[1]',
        { x: 261, y: 261, width: 167, height: 120 },
        LOGIN,
      ),
    ]);
    assert.equal(r.status, 'found');
    if (r.status !== 'found') return;
    assert.equal(r.holder.box.width, 167);
    assert.deepEqual(
      r.around.map((h) => h.box.width),
      [717, 1280, 1280],
    );
    assert.ok(r.why.includes('innermost of 4 nested parts'), r.why);
  });

  it('two parts that are not inside each other are not chosen between', () => {
    const r = findHolder('Login', [
      holder('/html[1]/body[1]/div[1]', { x: 0, y: 0, width: 300, height: 100 }, LOGIN),
      holder('/html[1]/body[1]/div[2]', { x: 0, y: 200, width: 300, height: 100 }, LOGIN),
    ]);
    assert.equal(r.status, 'ambiguous');
  });

  it('the same address in two frames is two parts, not one inside the other', () => {
    const r = findHolder('Login', [
      holder('/html[1]/body[1]/div[1]', { x: 0, y: 0, width: 300, height: 100 }, LOGIN, 4, 2, ['#a']),
      holder('/html[1]/body[1]/div[1]/div[1]', { x: 0, y: 0, width: 200, height: 100 }, LOGIN, 4, 2, ['#b']),
    ]);
    assert.equal(r.status, 'ambiguous');
  });

  it('a row of buttons inside the form is not the login section: the box around the fields and their buttons is', () => {
    const r = findHolder('Login', [
      holder('/html[1]/body[1]/div[1]', { x: 400, y: 100, width: 480, height: 300 }, 'Sign in Email Password Login Forgot password?', 4, 2),
      holder('/html[1]/body[1]/div[1]/div[3]', { x: 420, y: 330, width: 440, height: 40 }, 'Login Forgot password?', 2, 0),
    ]);
    assert.equal(r.status, 'found');
    if (r.status === 'found') assert.equal(r.holder.xpath, '/html[1]/body[1]/div[1]');
  });

  it('a part without fields is still found when nothing with fields holds the words', () => {
    const r = findHolder('Tabs', [holder('/html[1]/body[1]/ul[1]', { x: 0, y: 0, width: 600, height: 40 }, 'Tabs Personal Job Contact', 3, 0)]);
    assert.equal(r.status, 'found');
  });

  it('a holder with fewer than two controls, or none with the words, gives not-found', () => {
    assert.equal(findHolder('Login', [holder('/a[1]', { x: 0, y: 0, width: 10, height: 10 }, LOGIN, 1, 1)]).status, 'not-found');
    assert.equal(findHolder('Search', [holder('/a[1]', { x: 0, y: 0, width: 10, height: 10 }, LOGIN)]).status, 'not-found');
    assert.equal(findHolder('the section', [holder('/a[1]', { x: 0, y: 0, width: 10, height: 10 }, LOGIN)]).status, 'not-found');
  });
});

describe('E0.17: a layout check measures the part and the parts around it (owner, 6 Nov 2026)', () => {
  const nested = (innerX: number, panelX: number): PageHolder[] => [
    holder('/html[1]/body[1]/form[1]/table[1]', { x: 0, y: 80, width: 1280, height: 380 }, LOGIN),
    holder('/html[1]/body[1]/form[1]/table[1]/tr[1]/td[2]/table[1]', { x: panelX, y: 80, width: 717, height: 380 }, LOGIN),
    holder('/html[1]/body[1]/form[1]/table[1]/tr[1]/td[2]/table[1]/tr[1]/td[1]/table[1]', { x: innerX, y: 260, width: 167, height: 120 }, LOGIN),
  ];

  it('OrangeHRM 2.5: the box is left of the middle and its panel is in it, so the check is not decided', () => {
    const e = judge(page(nested(261, 256)));
    assert.equal(e.result, 'unproven');
    assert.equal(e.doubt, 'AMBIGUOUS');
    assert.ok(e.actual.includes('296 px off the middle'), e.actual);
    assert.ok(e.actual.includes('717 px wide): 26 px off the middle'), e.actual);
  });

  it('box and panel both in the middle: proven', () => {
    assert.equal(judge(page(nested(556, 281))).result, 'proven');
  });

  it('box and panel both off the middle: disproven, and "not in the middle" is then proven', () => {
    assert.equal(judge(page(nested(20, 10))).result, 'disproven');
    assert.equal(judge(page(nested(20, 10)), 'center', true).result, 'proven');
  });

  it('a holder as wide as the window is the layout of the page and is not measured', () => {
    // Only the full-width table and the box: the box alone decides.
    const e = judge(page([nested(20, 10)[0] as PageHolder, nested(20, 10)[2] as PageHolder]));
    assert.equal(e.result, 'disproven');
  });

  it('two separate login boxes, or none: not decided', () => {
    const two = judge(
      page([
        holder('/html[1]/body[1]/div[1]', { x: 556, y: 0, width: 167, height: 100 }, LOGIN),
        holder('/html[1]/body[1]/div[2]', { x: 556, y: 300, width: 167, height: 100 }, LOGIN),
      ]),
    );
    assert.equal(two.doubt, 'AMBIGUOUS');
    assert.equal(judge(page([])).doubt, 'NOT_FOUND');
  });

  it('a region other than the middle is a third of the window', () => {
    const left = page([holder('/html[1]/body[1]/div[1]', { x: 20, y: 20, width: 200, height: 100 }, LOGIN)]);
    assert.equal(judge(left, 'top-left').result, 'proven');
    assert.equal(judge(left, 'left').result, 'proven');
    assert.equal(judge(left, 'bottom').result, 'disproven');
  });

  it('without the size of the window nothing is measured', () => {
    const { viewport: _gone, ...rest } = page(nested(261, 256));
    assert.equal(judge(rest).doubt, 'NOT_OBSERVABLE');
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name: string): string => pathToFileURL(path.join(root, 'test', 'dom', name)).href;

describe('E0.17 exit test: the captured OrangeHRM 2.5 login page (3 nested "login" tables)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let browser: Browser;
  let tab: Page;
  before(async () => {
    browser = await chromium.launch({ channel: 'chrome' });
    tab = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  });
  after(async () => {
    await browser?.close();
  });

  it('the login section is found without a question: the table around Login Name, Password, Login and Clear', async () => {
    await tab.goto(fixture('orangehrm-login.html'));
    await tab.evaluate('globalThis.__name = globalThis.__name || ((fn) => fn)');
    const holders = (await tab.evaluate(readHolders, { selector: HOLDER_SELECTOR, limit: 400 })).map((h) => ({ ...h, frame: [] }));
    const r = findHolder('Login section', holders);
    assert.equal(r.status, 'found', r.status === 'found' ? '' : r.why);
    if (r.status !== 'found') return;
    assert.equal(r.holder.tag, 'table');
    assert.equal(r.holder.controls, 4);
    assert.equal(r.holder.fields, 2);
    assert.ok(r.holder.text.includes('Login Name'));
    assert.ok(r.around.length >= 2, `${r.around.length} holders around it`);
    // The panel around the box is narrower than the window: it is measured as well.
    assert.ok(r.around.some((h) => h.box.width < 1280 * 0.95));
  });
});
