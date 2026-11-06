import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { compileCase } from '../pipeline/compile.js';
import { anchorScope } from './anchors.js';
import { anchorFor, type PageHolder } from './holders.js';
import { inspectPage, locate } from './index.js';

/**
 * E0.17 item 1, container anchors. A step that names a section ("Click Edit in the Job section") is done inside the part of the page
 * titled that way, also when the page marks no sections (OrangeHRM 2.5). The browser tests use the captured employee details page
 * (test/dom/orangehrm-employee.html), where the Personal, Job, Contact and Tax Edit buttons are alike. AUTO_QA_SKIP_BROWSER=1 skips them.
 */

const part = (xpath: string, title: string, frame: string[] = []): PageHolder => ({
  frame,
  xpath,
  tag: 'div',
  box: { x: 0, y: 0, width: 400, height: 200 },
  controls: 3,
  fields: 1,
  text: title,
  title,
});

describe('E0.17 item 1: the part of the page a section name means, by its title', () => {
  it('the title that is the name wins over a title that only holds it', () => {
    const r = anchorFor('the Job section', [part('/html[1]/body[1]/div[1]', 'Job History'), part('/html[1]/body[1]/div[2]', 'Job')]);
    assert.equal(r.status, 'found');
    if (r.status === 'found') assert.equal(r.anchor.xpath, '/html[1]/body[1]/div[2]');
  });

  it('a title that holds the name is used when none is the name', () => {
    const r = anchorFor('Contact section', [part('/html[1]/body[1]/div[1]', 'Personal Details'), part('/html[1]/body[1]/div[2]', 'Contact Details')]);
    assert.equal(r.status, 'found');
    if (r.status === 'found') assert.equal(r.anchor.title, 'Contact Details');
  });

  it('of titled parts inside each other the innermost is the anchor', () => {
    const r = anchorFor('Job', [part('/html[1]/body[1]/div[3]', 'Job'), part('/html[1]/body[1]/div[3]/div[1]', 'Job')]);
    assert.equal(r.status, 'found');
    if (r.status === 'found') assert.equal(r.anchor.xpath, '/html[1]/body[1]/div[3]/div[1]');
  });

  it('two separate parts with the same title are not chosen between', () => {
    assert.equal(anchorFor('Job', [part('/html[1]/body[1]/div[1]', 'Job'), part('/html[1]/body[1]/div[2]', 'Job')]).status, 'ambiguous');
  });

  it('no part with that title, or a name that is only a kind of part: not found', () => {
    assert.equal(anchorFor('Employment section', [part('/a[1]', 'Job')]).status, 'not-found');
    assert.equal(anchorFor('the section', [part('/a[1]', 'Job')]).status, 'not-found');
  });
});

describe('E0.17 item 1: a step keeps the section it names', () => {
  it('clicking and typing in a section, panel or tab keep it; a page and a plain field do not', async () => {
    const r = await compileCase(
      {
        id: 'T-ANCHOR',
        title: 'sections',
        steps: [
          '1. Open the Login page',
          '2. Click Edit in the Job section',
          '3. Click Save under Dependents section',
          '4. Enter Rao in Last Name in the Personal Details section',
          '5. Click Save in the Job tab',
          '6. Click Login on the Login page',
          '7. Enter Asha in the First Name field',
        ].join('\n'),
        expected: 'The Login page is shown',
      },
      {},
    );
    const within = (r.ir?.steps ?? []).map((s) => s.target?.within);
    assert.deepEqual(within, [undefined, 'the Job section', 'Dependents section', 'the Personal Details section', 'the Job tab', undefined, undefined]);
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = (name: string): string => pathToFileURL(path.join(root, 'test', 'dom', name)).href;

describe('E0.17 item 1 on the captured OrangeHRM 2.5 employee page', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch({ channel: 'chrome' });
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(fixture('orangehrm-employee.html'));
  });
  after(async () => {
    await browser?.close();
  });

  /** Opens a tab as OrangeHRM does: the panel with `currentpanel` is shown, the others sit at x -9999 (its scripts are not in the copy). */
  const showTab = (id: string): Promise<void> =>
    page.evaluate((shown) => {
      for (const p of Array.from(document.querySelectorAll('.pimpanel'))) p.classList.toggle('currentpanel', p.id === shown);
    }, id);

  const editIn = async (within: string, purpose: 'act' | 'inspect' = 'act') => {
    const elements = await inspectPage(page);
    const scope = await anchorScope(page, within, elements);
    assert.equal(scope.status, 'scoped', JSON.stringify(scope));
    if (scope.status !== 'scoped') return undefined;
    return locate({ name: 'Edit', ontology: 'Button', purpose }, scope.elements);
  };

  it('the Edit buttons of the tabs that are not open are off the page: only the one a person sees is found', async () => {
    await showTab('personal');
    const elements = await inspectPage(page);
    const r = locate({ name: 'Edit', ontology: 'Button' }, elements);
    assert.equal(r.status, 'found');
    if (r.status === 'found') assert.equal(r.element.id, 'btnEditPers');
    const job = elements.find((e) => e.id === 'btnEditJob');
    assert.equal(job?.visible, false);
    assert.equal(job?.hiddenReason, 'off the page');
  });

  it('"Edit in the Job section", with the Job tab open, is the Job Edit button', async () => {
    await showTab('job');
    const r = await editIn('the Job section');
    assert.equal(r?.status, 'found');
    if (r?.status === 'found') assert.equal(r.element.id, 'btnEditJob');
  });

  it('"Edit in the Job section" with another tab open is not clicked: it is off the page', async () => {
    await showTab('personal');
    assert.equal((await editIn('the Job section'))?.status, 'inactive');
  });

  it('"Edit in the Contact Details section" is found by the title, not by the id of the section (contacts)', async () => {
    await showTab('contacts');
    const r = await editIn('the Contact Details section');
    assert.equal(r?.status, 'found');
    if (r?.status === 'found') assert.equal(r.element.id, 'btnEditContact');
  });

  it('a section the page does not have is read on the whole page, and the run says so', async () => {
    const scope = await anchorScope(page, 'the Employment section', await inspectPage(page));
    assert.equal(scope.status, 'whole-page');
    if (scope.status === 'whole-page') assert.ok(scope.note.includes('whole page was searched'), scope.note);
  });

  it('a card the page does not have is left to the locator, which must find it (UI-07)', async () => {
    assert.equal((await anchorScope(page, 'the Backpack card', await inspectPage(page))).status, 'unscoped');
  });

  it('a place that is not a container is not scoped', async () => {
    assert.equal((await anchorScope(page, 'the Login page', await inspectPage(page))).status, 'unscoped');
  });
});
