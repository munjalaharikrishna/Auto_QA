import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium, type ElementHandle, type Page, selectors } from 'playwright';
import type { ElementFacts } from './ladder.js';
import { type LocatorSpec, spec, toCode, toLocator } from './locator.js';
import type { TargetQuery } from './match.js';

/**
 * Locator Probe (FR-LO-08, D7): checks locators with the Playwright library in the same
 * Chrome that Playwright MCP drives. The probe starts Chrome with a CDP port; MCP connects to
 * it with `--cdp-endpoint`, so both see the same pages.
 */

export interface ProbeOptions {
  headless?: boolean;
  /** Must match the MCP server's, so `getByTestId` means the same in both (FR-LO-09). */
  testIdAttribute?: string;
  /** How long an actionability check may wait, in ms. */
  timeout?: number;
}

export interface Validation {
  spec: LocatorSpec;
  code: string;
  ok: boolean;
  /** Why it failed, in words for the review screen. */
  reason?: string;
  count: number;
}

export class LocatorProbe {
  /** Browser pop-ups this connection saw, e.g. `alert "Password not given!"`. Each is accepted, as the generated test does. */
  private readonly dialogs: string[] = [];

  private constructor(
    private readonly context: BrowserContext,
    private readonly userDataDir: string,
    readonly cdpEndpoint: string,
    private readonly timeout: number,
  ) {}

  static async launch(options: ProbeOptions = {}): Promise<LocatorProbe> {
    selectors.setTestIdAttribute(options.testIdAttribute ?? 'data-testid');
    const port = await freePort();
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-chrome-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: options.headless ?? true,
      args: [`--remote-debugging-port=${port}`],
    });
    const probe = new LocatorProbe(context, userDataDir, `http://127.0.0.1:${port}`, options.timeout ?? 2000);
    // Without a listener this connection would dismiss every pop-up itself, and nobody would learn what it said.
    const watch = (page: Page) =>
      page.on('dialog', (dialog) => {
        probe.dialogs.push(`${dialog.type()} "${dialog.message()}"`);
        void dialog.accept().catch(() => undefined);
      });
    for (const page of context.pages()) watch(page);
    context.on('page', watch);
    return probe;
  }

  /** Pop-ups seen since the last call. */
  takeDialogs(): string[] {
    return this.dialogs.splice(0);
  }

  /** The page MCP is on: the newest page with this URL, or the newest page. */
  page(url?: string): Page {
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const match = url ? pages.filter((p) => sameUrl(p.url(), url)) : [];
    const page = (match.length ? match : pages).at(-1);
    if (!page) throw new Error('The shared browser has no open page.');
    return page;
  }

  /** The one element a spec points to, or why there is not exactly one. */
  async resolve(page: Page, s: LocatorSpec): Promise<{ handle?: ElementHandle; count: number }> {
    const locator = toLocator(page, s);
    const count = await locator.count();
    return { handle: count === 1 ? ((await locator.elementHandle({ timeout: this.timeout })) ?? undefined) : undefined, count };
  }

  /**
   * The element with this snapshot ref, if the probe's own snapshot of the page is the one the ref came
   * from: then its refs are MCP's (the same snapshot code on the same page).
   */
  async resolveRef(page: Page, ref: string, snapshotYaml: string): Promise<ElementHandle | undefined> {
    const own = await page.ariaSnapshot({ mode: 'ai', timeout: this.timeout }).catch(() => undefined);
    if (own?.trimEnd() !== snapshotYaml.trimEnd()) return undefined;
    const { handle } = await this.resolve(page, spec('locator', `aria-ref=${ref}`));
    return handle;
  }

  async facts(handle: ElementHandle, testIdAttribute: string): Promise<ElementFacts> {
    return handle.evaluate(readFacts, testIdAttribute);
  }

  /**
   * A locator is valid when it finds exactly one element, that element is the one the matcher
   * chose (`anchor`), and the step's action is possible on it. Invalid locators are never stored.
   */
  async validate(page: Page, s: LocatorSpec, kind: TargetQuery['kind'], anchor: ElementHandle): Promise<Validation> {
    const code = toCode(s);
    const fail = (count: number, reason: string): Validation => ({ spec: s, code, ok: false, count, reason });
    const locator = toLocator(page, s);
    let count: number;
    try {
      count = await locator.count();
    } catch (e) {
      return fail(0, `not a valid locator: ${(e as Error).message.split('\n')[0]}`);
    }
    if (count !== 1) return fail(count, count ? `matches ${count} elements` : 'matches nothing');
    if (!(await locator.evaluate((el, a) => el === a, anchor))) return fail(1, 'finds a different element');

    const t = { timeout: this.timeout };
    try {
      switch (kind) {
        case 'fill':
        case 'clear':
          if (!(await locator.isVisible())) return fail(1, 'not visible');
          if (!(await locator.isEditable(t))) return fail(1, 'not editable');
          break;
        case 'click':
          await locator.click({ ...t, trial: true });
          break;
        case 'check':
          await locator.check({ ...t, trial: true });
          break;
        case 'uncheck':
          await locator.uncheck({ ...t, trial: true });
          break;
        case 'hover':
          await locator.hover({ ...t, trial: true });
          break;
        case 'select':
          if (!(await locator.isVisible())) return fail(1, 'not visible');
          if (!(await locator.isEnabled(t))) return fail(1, 'disabled');
          break;
        case 'upload':
          if (!(await locator.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file'))) return fail(1, 'not a file input');
          break;
        default:
          // Assertion targets only need to be unique; what they show is checked when the test runs.
          break;
      }
    } catch (e) {
      return fail(1, `the ${kind} is not possible: ${(e as Error).message.split('\n')[0].replace(/^\w+\.\w+: /, '')}`);
    }
    return { spec: s, code, ok: true, count };
  }

  /** Validates `s` as another locator for the element `winner` points to (FR-LO-07: MCP's code after an action). */
  async validateAgainst(page: Page, s: LocatorSpec, kind: TargetQuery['kind'], winner: LocatorSpec): Promise<Validation | undefined> {
    const { handle } = await this.resolve(page, winner);
    if (!handle) return undefined;
    try {
      return await this.validate(page, s, kind, handle);
    } finally {
      await handle.dispose();
    }
  }

  async close(): Promise<void> {
    await this.context.close();
    await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const sameUrl = (a: string, b: string) => a.replace(/#.*$/, '').replace(/\/$/, '') === b.replace(/#.*$/, '').replace(/\/$/, '');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Runs in the page and returns ElementFacts. Plain DOM reads only. It is a string, not a function,
 * because tsx adds a `__name` helper to compiled functions that does not exist in the page.
 */
const READ_FACTS = String.raw`(el, testIdAttribute) => {
  const attr = (name) => (el.getAttribute(name) || '').trim() || undefined;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim() || undefined;

  const labels = [];
  const labelled = attr('aria-labelledby');
  if (labelled) {
    const text = clean(labelled.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' '));
    if (text) labels.push(text);
  }
  for (const l of Array.from(el.labels || [])) {
    const text = clean(l.textContent);
    if (text) labels.push(text);
  }
  if (attr('aria-label')) labels.push(attr('aria-label'));

  const form = el.closest('form');
  const tag = el.tagName.toLowerCase();
  const isField = ['input', 'select', 'textarea'].includes(tag);

  const steps = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    if (n !== el && n.id) {
      steps.unshift('//' + n.tagName.toLowerCase() + "[@id='" + n.id + "']");
      break;
    }
    const parent = n.parentElement;
    const same = parent ? Array.from(parent.children).filter((c) => c.tagName === n.tagName) : [];
    steps.unshift('/' + n.tagName.toLowerCase() + (same.length > 1 ? '[' + (same.indexOf(n) + 1) + ']' : ''));
    if (!parent || parent === document.documentElement) steps.unshift('/html');
  }

  return {
    tag,
    type: attr('type'),
    id: attr('id'),
    nameAttr: attr('name'),
    placeholder: attr('placeholder'),
    testId: attr(testIdAttribute),
    labels: [...new Set(labels)],
    text: isField ? undefined : (clean(el.innerText) || '').slice(0, 80) || undefined,
    form: form ? form.id || form.getAttribute('name') || undefined : undefined,
    xpath: steps.join(''),
  };
}`;

// Built at runtime so the compiler never touches its body.
const readFacts = new Function('el', 'testIdAttribute', `return (${READ_FACTS})(el, testIdAttribute);`) as (
  el: Element,
  testIdAttribute: string,
) => ElementFacts;
