/**
 * Auto QA checks that Playwright does not have built in (VALIDATIONS.md §2.2). This file is copied as it is
 * into every generated project (utils/matchers.ts), so it imports nothing from the platform.
 *
 * Rules every check here follows (VALIDATIONS.md §6):
 * - it waits and retries until the page settles, up to 5 seconds, never a fixed sleep
 * - layout checks have a tolerance, because a page is never exactly where arithmetic says
 * - a failure says what was expected and what was actually found: the "Expected:" and "Actual:" lines
 *   are what the result page and the results sheet show
 */
import { expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { errorMessagesInPage } from './observe';

const DEFAULT_TIMEOUT = 5000;

// ---------------------------------------------------------------- what the page did

export interface NetEntry {
  /** Which test step was running (see markStep). */
  step: number;
  method: string;
  url: string;
  path: string;
  type: string;
  status?: number;
  postData?: string;
  durationMs?: number;
  failed?: string;
  startedAt: number;
}

export interface PageLog {
  step: number;
  /** The latest step that did something (not a check), which "the previous step" means for a check. */
  action: number;
  requests: NetEntry[];
  console: string[];
  errors: string[];
  dialogs: string[];
  /** The browser pop-ups with the step that was running, for "an error message appeared after the previous step". */
  dialogLog: Array<{ step: number; kind: string; text: string }>;
  /** The error-like messages on the page when each step started. */
  baseline: Record<number, string[]>;
  popups: string[];
  downloads: Array<{ name: string; read: () => Promise<string | undefined> }>;
}

const logs = new WeakMap<Page, PageLog>();

/** Starts recording what the page does, so later checks can ask about it ("a request was sent", "no console errors"). */
export function startLog(page: Page): PageLog {
  const existing = logs.get(page);
  if (existing) return existing;
  const log: PageLog = { step: 0, action: 0, requests: [], console: [], errors: [], dialogs: [], dialogLog: [], baseline: {}, popups: [], downloads: [] };
  logs.set(page, log);
  // Browser pop-ups never block a test: they are accepted and written down, as when the test was explored.
  page.on('dialog', async (dialog) => {
    log.dialogs.push(`${dialog.type()} "${dialog.message()}"`);
    log.dialogLog.push({ step: log.step, kind: dialog.type(), text: dialog.message() });
    await dialog.accept().catch(() => undefined);
  });
  const byRequest = new Map<unknown, NetEntry>();
  page.on('request', (r) => {
    const url = new URL(r.url());
    const entry: NetEntry = { step: log.step, method: r.method(), url: r.url(), path: url.pathname, type: r.resourceType(), startedAt: Date.now() };
    const body = r.postData();
    if (body) entry.postData = body.length > 4000 ? body.slice(0, 4000) : body;
    byRequest.set(r, entry);
    log.requests.push(entry);
  });
  page.on('response', (r) => {
    const entry = byRequest.get(r.request());
    if (entry) {
      entry.status = r.status();
      entry.durationMs = Date.now() - entry.startedAt;
    }
  });
  page.on('requestfailed', (r) => {
    const entry = byRequest.get(r);
    if (entry) entry.failed = r.failure()?.errorText ?? 'failed';
  });
  page.on('console', (m) => {
    if (m.type() === 'error') log.console.push(m.text());
  });
  page.on('pageerror', (e) => log.errors.push(e.message));
  page.on('popup', (p) => log.popups.push(p.url()));
  page.on('download', (d) => {
    log.downloads.push({
      name: d.suggestedFilename(),
      read: async () => {
        const file = await d.path().catch(() => null);
        if (!file) return undefined;
        const { readFileSync } = await import('node:fs');
        return readFileSync(file, 'utf8');
      },
    });
  });
  return log;
}

/** Each test step calls this when it starts, so "no request was sent in the previous step" knows which step is which. */
export async function markStep(page: Page, isCheck = false): Promise<void> {
  const log = startLog(page);
  log.step++;
  if (isCheck) return;
  log.action = log.step;
  // What was already on the page, so a message that was there before the action is not mistaken for its result.
  log.baseline[log.step] = await page.evaluate(errorMessagesInPage).catch(() => []);
}

export function logOf(page: Page): PageLog {
  return startLog(page);
}

// ---------------------------------------------------------------- waiting

/** Repeats `read` until `done` accepts it or the time is up; returns the last reading and whether it was accepted. */
async function settle<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = DEFAULT_TIMEOUT): Promise<{ value: T; ok: boolean }> {
  const end = Date.now() + timeout;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return { value, ok: done(value) };
}

const px = (n: number) => `${Math.round(n)} px`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Box | null> {
  await locator
    .first()
    .waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT })
    .catch(() => undefined);
  return locator.first().boundingBox();
}

async function viewportOf(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
}

const REGION_NAMES: Record<string, string> = {
  'top-left': 'at the top left',
  top: 'at the top',
  'top-right': 'at the top right',
  left: 'on the left',
  center: 'in the middle',
  right: 'on the right',
  'bottom-left': 'at the bottom left',
  bottom: 'at the bottom',
  'bottom-right': 'at the bottom right',
};

/** The screen split in 3 x 3: which of the nine areas holds the middle of the box. */
export function regionOf(box: Box, vp: { width: number; height: number }): string {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const col = cx < vp.width / 3 ? 'left' : cx > (vp.width * 2) / 3 ? 'right' : 'center';
  const row = cy < vp.height / 3 ? 'top' : cy > (vp.height * 2) / 3 ? 'bottom' : 'center';
  if (row === 'center') return col;
  return col === 'center' ? row : `${row}-${col}`;
}

type Compare = 'eq' | 'gte' | 'lte' | 'gt' | 'lt';
const COMPARE_WORDS: Record<Compare, string> = { eq: 'exactly', gte: 'at least', lte: 'at most', gt: 'more than', lt: 'fewer than' };
const compares = (actual: number, op: Compare, wanted: number) =>
  op === 'eq' ? actual === wanted : op === 'gte' ? actual >= wanted : op === 'lte' ? actual <= wanted : op === 'gt' ? actual > wanted : actual < wanted;

const numberIn = (text: string): number => {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text.replace(/\s/g, ''));
  return m ? Number(m[0].replace(/,/g, '')) : Number.NaN;
};

// ---------------------------------------------------------------- colours

const NAMED_HUES: Array<[string, number, number]> = [
  ['red', 345, 15],
  ['orange', 15, 45],
  ['yellow', 45, 70],
  ['green', 70, 165],
  ['teal', 165, 200],
  ['blue', 200, 260],
  ['purple', 260, 300],
  ['pink', 300, 345],
];

function parseRgb(css: string): [number, number, number] | undefined {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (!h) return undefined;
  const hex = h[1].length === 3 ? [...h[1]].map((c) => c + c).join('') : h[1];
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

/** "blue", "grey", "dark red": the plain-English name of a colour, from its hue, saturation and lightness. */
export function colourName(rgb: [number, number, number]): string {
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l > 0.93) return 'white';
  if (l < 0.1) return 'black';
  if (s < 0.18) return l > 0.65 ? 'light grey' : l < 0.35 ? 'dark grey' : 'grey';
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const hue = NAMED_HUES.find(([, from, to]) => (from > to ? h >= from || h < to : h >= from && h < to))?.[0] ?? 'red';
  if (hue === 'orange' && l < 0.35) return 'brown';
  return l < 0.3 ? `dark ${hue}` : l > 0.75 ? `light ${hue}` : hue;
}

/** Does the colour read as `wanted`: a name ("blue", "grey"), "#0066cc" or "rgb(0, 102, 204)"? */
export function colourMatches(actual: string, wanted: string, tolerance = 40): boolean {
  const have = parseRgb(actual);
  if (!have) return false;
  const exact = parseRgb(wanted);
  if (exact) return Math.hypot(have[0] - exact[0], have[1] - exact[1], have[2] - exact[2]) <= tolerance;
  const name = colourName(have);
  const w = wanted.toLowerCase().replace('gray', 'grey').trim();
  return name === w || name.endsWith(` ${w}`) || (w === 'grey' && name.includes('grey'));
}

// ---------------------------------------------------------------- the matchers

type Message = { pass: boolean; message: () => string; name: string; expected?: unknown; actual?: unknown };
const result = (name: string, pass: boolean, expected: string, actual: string, subject = 'locator'): Message => ({
  name,
  pass,
  expected,
  actual,
  message: () => `${subject}\n\nExpected: ${expected}\nActual: ${actual}`,
});

export const expect = baseExpect.extend({
  /** In the middle of the screen. `axis` x = left-right (the usual meaning), y = up-down, both = exact centre. */
  async toBeCentered(locator: Locator, options: { axis?: 'x' | 'y' | 'both'; tolerance?: number; timeout?: number } = {}) {
    const { axis = 'x', tolerance = 0.05, timeout } = options;
    const read = async () => {
      const box = await boxOf(locator);
      const vp = await viewportOf(locator.page());
      if (!box) return undefined;
      return { dx: Math.abs(box.x + box.width / 2 - vp.width / 2), dy: Math.abs(box.y + box.height / 2 - vp.height / 2), vp, box };
    };
    const good = (m?: Awaited<ReturnType<typeof read>>) =>
      !!m && (axis === 'y' || m.dx <= m.vp.width * tolerance) && (axis === 'x' || m.dy <= m.vp.height * tolerance);
    const { value: m, ok } = await settle(read, (v) => (this.isNot ? !good(v) : good(v)), timeout);
    const where = axis === 'x' ? 'horizontally' : axis === 'y' ? 'vertically' : 'horizontally and vertically';
    const expected = `${this.isNot ? 'not ' : ''}in the middle of the screen ${where} (within ${pct(tolerance)})`;
    const actual = !m
      ? 'the element is not visible, so its position cannot be measured'
      : `${px(m.dx)} off centre horizontally, ${px(m.dy)} off vertically (the element is ${px(m.box.width)} wide, the screen ${m.vp.width} x ${m.vp.height} px)`;
    void ok;
    return result('toBeCentered', good(m), expected, actual, 'Position of the element');
  },

  /** In one of the nine areas of the screen (3 x 3). */
  async toBeInRegion(locator: Locator, region: string, options: { timeout?: number } = {}) {
    const read = async () => {
      const box = await boxOf(locator);
      const vp = await viewportOf(locator.page());
      return box ? { area: regionOf(box, vp), box, vp } : undefined;
    };
    const { value: m } = await settle(read, (v) => (v?.area === region) !== this.isNot, options.timeout);
    const expected = `${this.isNot ? 'not ' : ''}${REGION_NAMES[region] ?? region} of the screen`;
    const actual = m
      ? `${REGION_NAMES[m.area] ?? m.area} of the screen (the middle of the element is at x ${px(m.box.x + m.box.width / 2)}, y ${px(m.box.y + m.box.height / 2)}; screen ${m.vp.width} x ${m.vp.height} px)`
      : 'the element is not visible';
    return result('toBeInRegion', m?.area === region, expected, actual, 'Position of the element');
  },

  /** Where one element is compared with another: above, below, left or right of it. */
  async toBePlacedRelativeTo(locator: Locator, other: Locator, relation: 'above' | 'below' | 'left-of' | 'right-of', options: { timeout?: number } = {}) {
    const read = async () => ({ a: await boxOf(locator), b: await boxOf(other) });
    const good = (v: { a: Box | null; b: Box | null }) => {
      if (!v.a || !v.b) return false;
      switch (relation) {
        case 'above':
          return v.a.y + v.a.height <= v.b.y + 2;
        case 'below':
          return v.a.y >= v.b.y + v.b.height - 2;
        case 'left-of':
          return v.a.x + v.a.width <= v.b.x + 2;
        default:
          return v.a.x >= v.b.x + v.b.width - 2;
      }
    };
    const { value: v } = await settle(read, (x) => good(x) !== this.isNot, options.timeout);
    const word = relation.replace('-', ' ');
    const where = (b: Box | null) => (b ? `x ${px(b.x)}–${px(b.x + b.width)}, y ${px(b.y)}–${px(b.y + b.height)}` : 'not visible');
    return result(
      'toBePlacedRelativeTo',
      good(v),
      `${this.isNot ? 'not ' : ''}${word} the other element`,
      `the element is at ${where(v.a)}; the other at ${where(v.b)}`,
      'Position of the element',
    );
  },

  /** Lines up with another element along one edge (within a few pixels). */
  async toBeAlignedWith(locator: Locator, other: Locator, edge: 'left' | 'right' | 'top' | 'bottom', options: { tolerance?: number; timeout?: number } = {}) {
    const tolerance = options.tolerance ?? 2;
    const side = (b: Box) => (edge === 'left' ? b.x : edge === 'right' ? b.x + b.width : edge === 'top' ? b.y : b.y + b.height);
    const read = async () => ({ a: await boxOf(locator), b: await boxOf(other) });
    const gap = (v: { a: Box | null; b: Box | null }) => (v.a && v.b ? Math.abs(side(v.a) - side(v.b)) : Number.POSITIVE_INFINITY);
    const { value: v } = await settle(read, (x) => gap(x) <= tolerance !== this.isNot, options.timeout);
    const d = gap(v);
    return result(
      'toBeAlignedWith',
      d <= tolerance,
      `${this.isNot ? 'not ' : ''}${edge}-aligned with the other element (within ${tolerance} px)`,
      Number.isFinite(d) ? `the ${edge} edges are ${px(d)} apart` : 'an element is not visible',
      'Alignment',
    );
  },

  /** Does not overlap another element. */
  async toNotOverlap(locator: Locator, other: Locator) {
    const [a, b] = [await boxOf(locator), await boxOf(other)];
    const overlap =
      a && b
        ? Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
        : 0;
    return result(
      'toNotOverlap',
      overlap === 0,
      'the two elements do not overlap',
      overlap ? `they overlap by ${Math.round(overlap)} square px` : 'they do not overlap',
      'Overlap',
    );
  },

  /** Width or height compared with a number of pixels. */
  async toHaveSize(locator: Locator, side: 'width' | 'height', compare: Compare, wanted: number, options: { timeout?: number } = {}) {
    const read = async () => (await boxOf(locator))?.[side];
    const { value } = await settle(read, (v) => v !== undefined && compares(v, compare, wanted) !== this.isNot, options.timeout);
    return result(
      'toHaveSize',
      value !== undefined && compares(value, compare, wanted),
      `${this.isNot ? 'not ' : ''}${side} ${COMPARE_WORDS[compare]} ${wanted} px`,
      value === undefined ? 'the element is not visible' : `${side} is ${px(value)}`,
      'Size of the element',
    );
  },

  /** Every matching element has the same width or height. */
  async toHaveSameSize(locator: Locator, side: 'width' | 'height') {
    const sizes = await locator.evaluateAll((els, s) => els.map((el) => Math.round(el.getBoundingClientRect()[s as 'width' | 'height'])), side);
    const same = sizes.length > 0 && sizes.every((v) => Math.abs(v - sizes[0]) <= 1);
    return result(
      'toHaveSameSize',
      same,
      `all ${sizes.length || 'the'} elements have the same ${side}`,
      sizes.length ? `${side}s are ${[...new Set(sizes)].join(', ')} px` : 'no elements found',
      'Size of the elements',
    );
  },

  /** A colour: by name ("blue"), hex or rgb, for `color`, `background-color` or `border-color`. */
  async toHaveColour(locator: Locator, property: string, wanted: string, options: { timeout?: number } = {}) {
    const read = async () => {
      await locator
        .first()
        .waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT })
        .catch(() => undefined);
      return locator
        .first()
        .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property)
        .catch(() => '');
    };
    const { value } = await settle(read, (v) => colourMatches(v, wanted) !== this.isNot, options.timeout);
    const rgb = parseRgb(value);
    return result(
      'toHaveColour',
      colourMatches(value, wanted),
      `${this.isNot ? 'not ' : ''}${property.replace('-', ' ')} ${wanted}`,
      rgb ? `${property.replace('-', ' ')} is ${colourName(rgb)} (${value})` : 'the colour could not be read',
      'Colour',
    );
  },

  /** A CSS property, e.g. font-weight bold (700). */
  async toHaveStyle(locator: Locator, property: string, wanted: string, options: { timeout?: number } = {}) {
    const alias: Record<string, string> = { bold: '700', normal: '400', italic: 'italic' };
    const want = alias[wanted.toLowerCase()] ?? wanted;
    const read = async () =>
      locator
        .first()
        .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property)
        .catch(() => '');
    const same = (v: string) => v === want || (property === 'font-weight' && Number(v) >= 600 && want === '700');
    const { value } = await settle(read, (v) => same(v) !== this.isNot, options.timeout);
    return result('toHaveStyle', same(value), `${this.isNot ? 'not ' : ''}${property} ${wanted}`, `${property} is ${value || 'not set'}`, 'Style');
  },

  /** Stays in place when the page is scrolled (a sticky header). */
  async toBeSticky(locator: Locator) {
    const before = await boxOf(locator);
    await locator.page().evaluate(() => window.scrollBy(0, 800));
    await locator.page().waitForTimeout(150);
    const after = await boxOf(locator);
    await locator.page().evaluate(() => window.scrollTo(0, 0));
    const moved = before && after ? Math.abs(after.y - before.y) : Number.NaN;
    return result(
      'toBeSticky',
      moved <= 2,
      'stays in the same place when the page is scrolled',
      Number.isFinite(moved) ? `moved ${px(moved)} when scrolled` : 'the element is not visible',
      'Sticky element',
    );
  },

  /** Every image inside has loaded (is not broken). */
  async toHaveLoadedImages(locator: Locator) {
    const broken = await locator.evaluate((root) =>
      [...(root instanceof HTMLImageElement ? [root] : root.querySelectorAll('img'))]
        .filter((img) => !(img.complete && img.naturalWidth > 0))
        .map((img) => img.getAttribute('src') ?? '(no src)'),
    );
    return result(
      'toHaveLoadedImages',
      broken.length === 0,
      'every image has loaded',
      broken.length ? `${broken.length} image(s) did not load: ${broken.slice(0, 3).join(', ')}` : 'every image loaded',
      'Images',
    );
  },

  /** The element contains parts with these names (fields, buttons, headings, text), in any order. */
  async toHaveParts(locator: Locator, names: string[]) {
    const missing: string[] = [];
    for (const name of names) {
      const part = locator
        .getByRole('textbox', { name })
        .or(locator.getByRole('button', { name }))
        .or(locator.getByRole('link', { name }))
        .or(locator.getByRole('heading', { name }))
        .or(locator.getByLabel(name))
        .or(locator.getByText(name));
      if (
        !(await part
          .first()
          .isVisible()
          .catch(() => false))
      )
        missing.push(name);
    }
    return result(
      'toHaveParts',
      missing.length === 0,
      `contains ${names.join(', ')}`,
      missing.length ? `${missing.join(', ')} not found inside` : 'all parts found',
      'Structure',
    );
  },

  /** A number compared with the number of matching elements ("at least 3 results"). */
  async toHaveCountThat(locator: Locator, compare: Compare, wanted: number, options: { timeout?: number } = {}) {
    const { value } = await settle(
      () => locator.count(),
      (n) => compares(n, compare, wanted) !== this.isNot,
      options.timeout,
    );
    return result(
      'toHaveCountThat',
      compares(value, compare, wanted),
      `${this.isNot ? 'not ' : ''}${COMPARE_WORDS[compare]} ${wanted}`,
      `${value} found`,
      'Number of elements',
    );
  },

  /** Can be clicked: visible, enabled and not covered by anything. */
  async toBeClickable(locator: Locator, options: { timeout?: number } = {}) {
    let reason = '';
    const { ok } = await settle(
      async () => {
        try {
          await locator.first().click({ trial: true, timeout: 800 });
          return true;
        } catch (e) {
          reason =
            String((e as Error).message)
              .split('\n')
              .find((l) => /intercepts|disabled|not visible|not enabled|covered/i.test(l)) ?? 'it could not be clicked';
          return false;
        }
      },
      (v) => v !== this.isNot,
      options.timeout,
    );
    return result('toBeClickable', ok, `${this.isNot ? 'not ' : ''}clickable`, ok ? 'it can be clicked' : reason.trim(), 'Clickable');
  },

  /** The field is marked invalid (aria-invalid or the browser's own validity). */
  async toBeMarkedInvalid(locator: Locator, options: { timeout?: number } = {}) {
    const read = () =>
      locator
        .first()
        .evaluate(
          (el) =>
            (el as HTMLInputElement).getAttribute('aria-invalid') === 'true' ||
            (typeof (el as HTMLInputElement).checkValidity === 'function' && !(el as HTMLInputElement).checkValidity()) ||
            /\b(invalid|error|is-invalid)\b/.test(el.className.toString()),
        );
    const { value } = await settle(read, (v) => v !== this.isNot, options.timeout);
    return result(
      'toBeMarkedInvalid',
      value,
      `${this.isNot ? 'not ' : ''}marked invalid`,
      value ? 'the field is marked invalid' : 'the field is not marked invalid',
      'Field state',
    );
  },

  /** The tab, menu item or link that is the current one (selected, active or current page). */
  async toBeSelectedItem(locator: Locator, options: { timeout?: number } = {}) {
    const read = () =>
      locator.first().evaluate((el) => {
        const on = (v: string | null) => v === 'true' || v === 'page' || v === 'step' || v === 'location';
        const marked = on(el.getAttribute('aria-selected')) || on(el.getAttribute('aria-current')) || on(el.getAttribute('aria-pressed'));
        return marked || /\b(active|selected|current)\b/i.test(`${el.className} ${el.parentElement?.className ?? ''}`);
      });
    const { value } = await settle(read, (v) => v !== this.isNot, options.timeout);
    return result(
      'toBeSelectedItem',
      value,
      `${this.isNot ? 'not ' : ''}the selected item`,
      value ? 'it is marked as selected' : 'it is not marked as selected',
      'Selected item',
    );
  },

  /** The browser's own validation message for the field (e.g. "Please fill out this field"). */
  async toHaveBrowserMessage(locator: Locator, text?: string) {
    const message = await locator.first().evaluate((el) => (el as HTMLInputElement).validationMessage ?? '');
    const pass = text ? message.toLowerCase().includes(text.toLowerCase()) : message.length > 0;
    return result(
      'toHaveBrowserMessage',
      pass,
      text ? `the browser says "${text}"` : 'the browser shows a message',
      message ? `the browser says "${message}"` : 'the browser shows no message',
      'Browser validation',
    );
  },

  /** A field stops accepting characters after `max`. */
  async toLimitLengthTo(locator: Locator, max: number) {
    const attr = await locator.first().getAttribute('maxlength');
    if (attr !== null) return result('toLimitLengthTo', Number(attr) === max, `at most ${max} characters`, `the field allows ${attr}`, 'Field length');
    await locator.first().fill('x'.repeat(max + 5));
    const length = (await locator.first().inputValue()).length;
    return result('toLimitLengthTo', length === max, `at most ${max} characters`, `${length} characters were accepted`, 'Field length');
  },

  /** An error message belongs to this field: linked to it, or the nearest message after it. */
  async toHaveFieldError(locator: Locator, text: string) {
    const found = await locator.first().evaluate((el, wanted) => {
      const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const w = norm(wanted);
      const ids = [el.getAttribute('aria-describedby'), el.getAttribute('aria-errormessage')].filter(Boolean).join(' ').split(/\s+/);
      for (const id of ids)
        if (norm(document.getElementById(id)?.textContent).includes(w)) return { linked: true, text: norm(document.getElementById(id)?.textContent) };
      let next: Element | null = el.nextElementSibling ?? el.parentElement?.nextElementSibling ?? null;
      for (let i = 0; i < 3 && next; i++, next = next.nextElementSibling)
        if (norm(next.textContent).includes(w)) return { linked: false, text: norm(next.textContent) };
      return undefined;
    }, text);
    return result(
      'toHaveFieldError',
      !!found,
      `the error "${text}" belongs to this field`,
      found ? 'the error is next to this field' : 'no such error is linked to or next to this field',
      'Field error',
    );
  },

  /** Hovering shows a tooltip with this text (or the element has it as its title). */
  async toHaveTooltip(locator: Locator, text: string) {
    await locator.first().hover();
    const tip = locator.page().getByRole('tooltip').first();
    const shown = await tip.textContent({ timeout: 1500 }).catch(() => null);
    const title = await locator.first().getAttribute('title');
    const got = shown ?? title ?? '';
    return result(
      'toHaveTooltip',
      got.toLowerCase().includes(text.toLowerCase()),
      `a tooltip "${text}"`,
      got ? `the tooltip says "${got.trim()}"` : 'no tooltip appeared',
      'Tooltip',
    );
  },

  /** The text has a common format: currency, number, date, email, phone, or your own pattern. */
  async toHaveFormat(locator: Locator, format: string, options: { timeout?: number } = {}) {
    const patterns: Record<string, RegExp> = {
      currency: /^[^\d-]{0,3}-?\d{1,3}(,\d{3})*(\.\d{2})?\s?[^\d\s]{0,3}$/,
      number: /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/,
      'date-dmy': /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/,
      'date-mdy': /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/,
      'date-iso': /^\d{4}-\d{2}-\d{2}$/,
      time: /^\d{1,2}:\d{2}(:\d{2})?(\s?[AP]M)?$/i,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      phone: /^[+\d][\d\s().-]{6,}$/,
    };
    const re = patterns[format] ?? new RegExp(format);
    const read = async () =>
      (
        (await locator
          .first()
          .textContent()
          .catch(() => '')) ?? ''
      ).trim();
    const { value } = await settle(read, (v) => re.test(v) !== this.isNot, options.timeout);
    return result('toHaveFormat', re.test(value), `${this.isNot ? 'not ' : ''}a ${format.replace('-', ' ')}`, `the text is "${value}"`, 'Text format');
  },

  /** Shows today's date, in the format the application uses. */
  async toShowToday(locator: Locator) {
    const text = ((await locator.first().textContent()) ?? '').trim();
    const now = new Date();
    const d = String(now.getDate());
    const m = String(now.getMonth() + 1);
    const y = String(now.getFullYear());
    const pad = (s: string) => s.padStart(2, '0');
    const months = now.toLocaleString('en-GB', { month: 'short' });
    const monthsLong = now.toLocaleString('en-GB', { month: 'long' });
    const options = [
      `${y}-${pad(m)}-${pad(d)}`,
      `${pad(d)}/${pad(m)}/${y}`,
      `${d}/${m}/${y}`,
      `${pad(m)}/${pad(d)}/${y}`,
      `${m}/${d}/${y}`,
      `${pad(d)}-${pad(m)}-${y}`,
      `${d} ${months} ${y}`,
      `${d} ${monthsLong} ${y}`,
      `${months} ${d}, ${y}`,
      `${monthsLong} ${d}, ${y}`,
    ];
    return result(
      'toShowToday',
      options.some((o) => text.includes(o)),
      `today's date (${options[0]})`,
      `the text is "${text}"`,
      'Date',
    );
  },

  /** The text is not cut off (nothing hidden by the box). */
  async toShowAllText(locator: Locator) {
    const cut = await locator.first().evaluate((el) => el.scrollWidth - el.clientWidth);
    return result(
      'toShowAllText',
      cut <= 1,
      'all the text is visible',
      cut > 1 ? `the text is ${cut} px wider than its box, so it is cut off` : 'all the text is visible',
      'Text',
    );
  },

  /** A dropdown shows this option as chosen (by its text or value). */
  async toHaveSelectedOption(locator: Locator, text: string) {
    const chosen = await locator
      .first()
      .evaluate((el) =>
        el instanceof HTMLSelectElement ? [...el.selectedOptions].flatMap((o) => [o.label.trim(), o.value]) : [(el as HTMLInputElement).value],
      );
    return result(
      'toHaveSelectedOption',
      chosen.some((c) => c.toLowerCase() === text.toLowerCase()),
      `"${text}" is selected`,
      `selected: ${chosen[0] ?? '(nothing)'}`,
      'Dropdown',
    );
  },

  /** A dropdown offers these options (in any order unless `ordered`). */
  async toHaveOptionsList(locator: Locator, list: string[], ordered = false) {
    const options = (await locator.first().evaluate((el) => (el instanceof HTMLSelectElement ? [...el.options].map((o) => o.label.trim()) : []))).filter(
      Boolean,
    );
    const missing = list.filter((o) => !options.map((x) => x.toLowerCase()).includes(o.toLowerCase()));
    const inOrder =
      !ordered || list.every((o, i) => options.filter((x) => list.map((l) => l.toLowerCase()).includes(x.toLowerCase()))[i]?.toLowerCase() === o.toLowerCase());
    return result(
      'toHaveOptionsList',
      !missing.length && inOrder,
      `the options ${list.join(', ')}`,
      missing.length ? `missing ${missing.join(', ')}; the dropdown has ${options.join(', ')}` : `has ${options.join(', ')}`,
      'Dropdown',
    );
  },

  /** The elements' texts are exactly this list, in this order. */
  async toHaveTextList(locator: Locator, list: string[]) {
    const { value } = await settle(
      () => locator.allTextContents().then((t) => t.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)),
      (v) => (JSON.stringify(v) === JSON.stringify(list)) !== this.isNot,
    );
    return result(
      'toHaveTextList',
      JSON.stringify(value) === JSON.stringify(list),
      `${this.isNot ? 'not ' : ''}${list.join(', ')}`,
      value.length ? value.join(', ') : 'nothing found',
      'List',
    );
  },

  // ---- tables

  /** The table's column headers. */
  async toHaveColumns(locator: Locator, headers: string[]) {
    const got = (await locator.first().getByRole('columnheader').allTextContents()).map((h) => h.replace(/\s+/g, ' ').trim());
    const missing = headers.filter((h) => !got.map((g) => g.toLowerCase()).includes(h.toLowerCase()));
    return result(
      'toHaveColumns',
      !missing.length,
      `the columns ${headers.join(', ')}`,
      missing.length ? `missing ${missing.join(', ')}; the columns are ${got.join(', ')}` : `the columns are ${got.join(', ')}`,
      'Table',
    );
  },

  /** How many data rows the table (or list) shows, not counting the header. */
  async toHaveRows(locator: Locator, compare: Compare, wanted: number, options: { timeout?: number } = {}) {
    const read = async () => {
      const rows = await locator.first().getByRole('row').count();
      const header = await locator.first().getByRole('columnheader').count();
      const items = rows ? rows - (header ? 1 : 0) : await locator.first().getByRole('listitem').count();
      return items;
    };
    const { value } = await settle(read, (n) => compares(n, compare, wanted) !== this.isNot, options.timeout);
    return result(
      'toHaveRows',
      compares(value, compare, wanted),
      `${this.isNot ? 'not ' : ''}${COMPARE_WORDS[compare]} ${wanted} rows`,
      `${value} rows`,
      'Table',
    );
  },

  /** The row that contains `rowText` has `cellText` in the column `column` (or anywhere in the row). */
  async toHaveRowWith(locator: Locator, rowText: string, cellText: string, column?: string) {
    const row = locator.first().getByRole('row').filter({ hasText: rowText }).first();
    if (!(await row.isVisible().catch(() => false))) return result('toHaveRowWith', false, `a row with "${rowText}"`, 'no such row', 'Table');
    let cells = (await row.getByRole('cell').allTextContents()).map((c) => c.replace(/\s+/g, ' ').trim());
    if (column) {
      const heads = (await locator.first().getByRole('columnheader').allTextContents()).map((h) => h.replace(/\s+/g, ' ').trim().toLowerCase());
      const at = heads.indexOf(column.toLowerCase());
      if (at < 0) return result('toHaveRowWith', false, `a column "${column}"`, `the columns are ${heads.join(', ')}`, 'Table');
      cells = [cells[at] ?? ''];
    }
    return result(
      'toHaveRowWith',
      cells.some((c) => c.toLowerCase().includes(cellText.toLowerCase())),
      `the row for "${rowText}" has ${column ? `${column} ` : ''}"${cellText}"`,
      `the row's ${column ? column : 'cells'}: ${cells.join(' | ')}`,
      'Table',
    );
  },

  /** The cell in row `index` (1 = the first data row) under the column `column` shows `text`. */
  async toHaveCellAt(locator: Locator, index: number, column: string, text: string) {
    const heads = (await locator.first().getByRole('columnheader').allTextContents()).map((h) => h.replace(/\s+/g, ' ').trim().toLowerCase());
    const at = heads.findIndex((h) => h.startsWith(column.toLowerCase()));
    if (at < 0) return result('toHaveCellAt', false, `a column "${column}"`, `the columns are ${heads.join(', ')}`, 'Table');
    const rows = locator
      .first()
      .getByRole('row')
      .filter({ has: locator.page().getByRole('cell') });
    const cell = (
      (await rows
        .nth(index - 1)
        .getByRole('cell')
        .nth(at)
        .textContent()
        .catch(() => null)) ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    return result(
      'toHaveCellAt',
      cell.toLowerCase().includes(text.toLowerCase()),
      `row ${index}, ${column} shows "${text}"`,
      cell ? `row ${index}, ${column} shows "${cell}"` : `there is no row ${index}`,
      'Table',
    );
  },

  /** A column is sorted. Numbers and dates are compared as such, text alphabetically. */
  async toBeSortedBy(locator: Locator, column: string, order: 'asc' | 'desc') {
    const heads = (await locator.first().getByRole('columnheader').allTextContents()).map((h) => h.replace(/\s+/g, ' ').trim().toLowerCase());
    const at = heads.findIndex((h) => h.startsWith(column.toLowerCase()));
    if (at < 0) return result('toBeSortedBy', false, `a column "${column}"`, `the columns are ${heads.join(', ')}`, 'Table');
    const rows = locator
      .first()
      .getByRole('row')
      .filter({ has: locator.page().getByRole('cell') });
    const values = (await rows.evaluateAll(
      (trs, i) => trs.map((tr) => (tr.querySelectorAll('td, [role=cell]')[i as number]?.textContent ?? '').replace(/\s+/g, ' ').trim()),
      at,
    )) as string[];
    const asNumber = values.every((v) => !Number.isNaN(numberIn(v)));
    const asDate = !asNumber && values.every((v) => !Number.isNaN(Date.parse(v)));
    const key = (v: string) => (asNumber ? numberIn(v) : asDate ? Date.parse(v) : v.toLowerCase());
    let bad = -1;
    for (let i = 1; i < values.length && bad < 0; i++) {
      const [a, b] = [key(values[i - 1]), key(values[i])];
      if (order === 'asc' ? a > b : a < b) bad = i;
    }
    return result(
      'toBeSortedBy',
      bad < 0,
      `${column} sorted ${order === 'asc' ? 'lowest first' : 'highest first'}`,
      bad < 0 ? `sorted: ${values.slice(0, 5).join(', ')}` : `"${values[bad - 1]}" is followed by "${values[bad]}"`,
      'Table',
    );
  },

  /** Every row (or list item) contains the text, e.g. after filtering or searching. */
  async toHaveEveryRowContaining(locator: Locator, text: string, column?: string) {
    let rows: string[];
    if (column) {
      const heads = (await locator.first().getByRole('columnheader').allTextContents()).map((h) => h.replace(/\s+/g, ' ').trim().toLowerCase());
      const at = heads.findIndex((h) => h.startsWith(column.toLowerCase()));
      rows = (await locator
        .first()
        .getByRole('row')
        .filter({ has: locator.page().getByRole('cell') })
        .evaluateAll((trs, i) => trs.map((tr) => tr.querySelectorAll('td, [role=cell]')[i as number]?.textContent ?? ''), at)) as string[];
    } else {
      const table = await locator
        .first()
        .getByRole('row')
        .filter({ has: locator.page().getByRole('cell') })
        .allTextContents();
      rows = table.length ? table : await locator.first().getByRole('listitem').allTextContents();
    }
    const bad = rows.filter((r) => !r.toLowerCase().includes(text.toLowerCase()));
    return result(
      'toHaveEveryRowContaining',
      rows.length > 0 && bad.length === 0,
      `every ${column ? `${column} value` : 'row'} contains "${text}"`,
      rows.length
        ? bad.length
          ? `${bad.length} of ${rows.length} do not: ${bad
              .slice(0, 3)
              .map((b) => `"${b.trim().slice(0, 40)}"`)
              .join(', ')}`
          : `all ${rows.length} do`
        : 'there are no rows',
      'Table',
    );
  },

  /** No two items are the same. */
  async toHaveNoDuplicates(locator: Locator) {
    const items = (await locator.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const dupes = items.filter((v, i) => items.indexOf(v) !== i);
    return result(
      'toHaveNoDuplicates',
      dupes.length === 0,
      'every item appears once',
      dupes.length ? `repeated: ${[...new Set(dupes)].slice(0, 3).join(', ')}` : `${items.length} different items`,
      'List',
    );
  },
});

// ---------------------------------------------------------------- checks on the page as a whole

/** The page path, ignoring the host so every environment works. */
export async function expectPath(page: Page, path: string, options: { not?: boolean } = {}): Promise<void> {
  const current = () => new URL(page.url()).pathname;
  if (options.not) await baseExpect.poll(current, { message: `page path is not ${path}` }).not.toBe(path);
  else await baseExpect.poll(current, { message: `page path is ${path}` }).toBe(path);
}

/** A request the page made: by method, path and (optionally) status, body text, or how fast it answered. */
export async function expectRequest(
  page: Page,
  want: { method?: string; path: string; status?: number; body?: string[]; withinMs?: number },
  options: { timeout?: number } = {},
): Promise<void> {
  const log = logOf(page);
  const find = () =>
    log.requests.filter(
      (r) =>
        (!want.method || r.method === want.method.toUpperCase()) &&
        r.path.includes(want.path) &&
        (want.status === undefined || r.status === want.status) &&
        (!want.body || want.body.every((b) => (r.postData ?? '').includes(b))) &&
        (want.withinMs === undefined || (r.durationMs !== undefined && r.durationMs <= want.withinMs)),
    );
  const { ok } = await settle(
    async () => find().length,
    (n) => n > 0,
    options.timeout,
  );
  const what = `${want.method?.toUpperCase() ?? 'a request'} ${want.path}${want.status ? ` answered ${want.status}` : ''}${want.body ? ` with ${want.body.join(', ')}` : ''}${want.withinMs ? ` within ${want.withinMs} ms` : ''}`;
  if (ok) return;
  const seen = log.requests
    .filter((r) => r.type === 'xhr' || r.type === 'fetch' || r.type === 'document')
    .slice(-6)
    .map((r) => `${r.method} ${r.path}${r.status ? ` ${r.status}` : ''}${r.durationMs !== undefined ? ` ${r.durationMs} ms` : ''}`);
  throw new Error(
    `Request check failed\n\nExpected: ${what}\nActual: ${seen.length ? `no such request; the page sent ${seen.join('; ')}` : 'the page sent no requests'}`,
  );
}

/** The page sent nothing to the server matching this during the step before this check (e.g. an invalid form). */
export async function expectNoRequest(page: Page, want: { method?: string; path?: string }): Promise<void> {
  const log = logOf(page);
  const previous = log.action;
  const sent = log.requests.filter(
    (r) =>
      r.step === previous &&
      (r.type === 'xhr' || r.type === 'fetch' || r.type === 'document') &&
      (!want.method || r.method === want.method.toUpperCase()) &&
      (!want.path || r.path.includes(want.path)),
  );
  if (sent.length)
    throw new Error(
      `Request check failed\n\nExpected: no ${want.method ?? ''} ${want.path ?? 'request'} sent\nActual: the page sent ${sent.map((r) => `${r.method} ${r.path}`).join(', ')}`.replace(
        '  ',
        ' ',
      ),
    );
}

/**
 * An error message appeared as a result of the previous step: a browser alert, or a message on the page that was not there
 * before (an alert role, an error class, red text, a field's validation message). With `text`, that message says it.
 */
export async function expectErrorShown(page: Page, want: { text?: string } = {}): Promise<void> {
  const log = logOf(page);
  const before = log.action;
  const read = async () => {
    const onPage = (await page.evaluate(errorMessagesInPage).catch(() => [])).filter((m) => !(log.baseline[before] ?? []).includes(m));
    const alerts = log.dialogLog.filter((d) => d.step === before && d.kind !== 'confirm').map((d) => d.text);
    return [...alerts, ...onPage];
  };
  const matches = (all: string[]) => all.filter((m) => !want.text || m.toLowerCase().includes(want.text.toLowerCase()));
  const { value, ok } = await settle(read, (all) => matches(all).length > 0, 4000);
  if (ok) return;
  const shown = (await page.evaluate(errorMessagesInPage).catch(() => [])).slice(0, 3);
  throw new Error(
    `Error message check failed\n\nExpected: an error message${want.text ? ` "${want.text}"` : ''} appears after the previous step\nActual: ${
      value.length
        ? `messages appeared, but not that one: ${value.slice(0, 3).join(' | ')}`
        : `no new error message appeared${shown.length ? ` (the page already showed: ${shown.join(' | ')})` : ''}`
    }`,
  );
}

/** No errors were written to the browser console. */
export async function expectNoConsoleErrors(page: Page): Promise<void> {
  const log = logOf(page);
  const errors = [...log.console, ...log.errors];
  if (errors.length)
    throw new Error(`Console check failed\n\nExpected: no errors in the browser console\nActual: ${errors.length} error(s): ${errors.slice(0, 3).join(' | ')}`);
}

/** The page is not blank: something is on it. */
export async function expectNotBlank(page: Page): Promise<void> {
  const shown = await page.evaluate(
    () => (document.body?.innerText ?? '').trim().length + document.body.querySelectorAll('img, input, button, canvas, svg, video').length,
  );
  if (!shown) throw new Error('Blank page check failed\n\nExpected: something is shown on the page\nActual: the page is blank');
}

/** On a secure page, nothing was loaded over plain http. */
export async function expectNoMixedContent(page: Page): Promise<void> {
  if (!page.url().startsWith('https://')) return;
  const bad = logOf(page).requests.filter((r) => r.url.startsWith('http://'));
  if (bad.length)
    throw new Error(
      `Mixed content check failed\n\nExpected: everything loaded over https\nActual: ${bad.length} request(s) over http: ${bad
        .slice(0, 3)
        .map((r) => r.url)
        .join(', ')}`,
    );
}

/** A query parameter of the current address, e.g. ?tab=profile. */
export async function expectQueryParam(page: Page, name: string, value?: string): Promise<void> {
  const read = () => new URL(page.url()).searchParams.get(name);
  const { value: got, ok } = await settle(
    async () => read(),
    (v) => (value === undefined ? v !== null : v === value),
  );
  if (!ok)
    throw new Error(
      `Address check failed\n\nExpected: ${name}${value === undefined ? ' is present' : ` is "${value}"`} in the address\nActual: ${got === null ? `no ${name} in ${page.url()}` : `${name} is "${got}"`}`,
    );
}

/** A page opened in a new tab (optionally with an address containing `path`). */
export async function expectNewTab(page: Page, path?: string): Promise<void> {
  const log = logOf(page);
  const { value, ok } = await settle(
    async () => log.popups.slice(),
    (v) => v.length > 0 && (!path || v.some((u) => u.includes(path))),
  );
  if (!ok)
    throw new Error(
      `New tab check failed\n\nExpected: a new tab${path ? ` with ${path}` : ''}\nActual: ${value.length ? `new tabs: ${value.join(', ')}` : 'no new tab opened'}`,
    );
}

/** The page showed a browser alert, confirm or prompt with this text. */
export async function expectBrowserDialog(page: Page, text: string): Promise<void> {
  const log = logOf(page);
  const { value, ok } = await settle(
    async () => log.dialogs.slice(),
    (v) => v.some((d) => d.toLowerCase().includes(text.toLowerCase())),
  );
  if (!ok)
    throw new Error(
      `Pop-up check failed\n\nExpected: a browser pop-up saying "${text}"\nActual: ${value.length ? `pop-ups: ${value.join('; ')}` : 'no browser pop-up appeared'}`,
    );
}

/** Nothing on the page is still loading (spinners, progress bars, skeletons). */
export async function expectLoadingDone(page: Page, timeout = DEFAULT_TIMEOUT): Promise<void> {
  const busy = () =>
    page.evaluate(() => {
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      return [
        ...document.querySelectorAll(
          '[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="loading" i], [class*="loader" i], [class*="skeleton" i]',
        ),
      ].filter(visible).length;
    });
  const { value, ok } = await settle(busy, (n) => n === 0, timeout);
  if (!ok)
    throw new Error(
      `Loading check failed\n\nExpected: loading has finished\nActual: ${value} loading indicator(s) are still shown after ${timeout / 1000} seconds`,
    );
}

/** A cookie exists (and, if given, has this value or these flags). */
export async function expectCookie(
  page: Page,
  name: string,
  expected?: { value?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; absent?: boolean },
): Promise<void> {
  const read = async () =>
    (await page.context().cookies()).find((c) => c.name.toLowerCase() === name.toLowerCase()) ??
    (await page.context().cookies()).find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
  const { value: c } = await settle(read, (v) => (expected?.absent ? !v : !!v), 3000);
  if (expected?.absent) {
    if (c) throw new Error(`Cookie check failed\n\nExpected: no cookie ${name}\nActual: the cookie ${name} is set`);
    return;
  }
  if (!c)
    throw new Error(
      `Cookie check failed\n\nExpected: a cookie ${name}\nActual: no cookie ${name} (cookies: ${(await page.context().cookies()).map((x) => x.name).join(', ') || 'none'})`,
    );
  const problems: string[] = [];
  if (expected?.value !== undefined && c.value !== expected.value) problems.push('its value is different');
  if (expected?.secure !== undefined && c.secure !== expected.secure) problems.push(`Secure is ${c.secure}`);
  if (expected?.httpOnly !== undefined && c.httpOnly !== expected.httpOnly) problems.push(`HttpOnly is ${c.httpOnly}`);
  if (expected?.sameSite !== undefined && c.sameSite.toLowerCase() !== expected.sameSite.toLowerCase()) problems.push(`SameSite is ${c.sameSite}`);
  if (problems.length)
    throw new Error(`Cookie check failed\n\nExpected: cookie ${name} ${JSON.stringify(expected)}\nActual: cookie ${name}: ${problems.join(', ')}`);
}

/** A value kept in local or session storage. */
export async function expectStorage(page: Page, area: 'local' | 'session', key: string, expected?: string): Promise<void> {
  const read = () =>
    page.evaluate(
      ([a, k]) => {
        const store = a === 'local' ? localStorage : sessionStorage;
        const real =
          Object.keys(store).find((x) => x.toLowerCase() === k.toLowerCase()) ?? Object.keys(store).find((x) => x.toLowerCase().includes(k.toLowerCase()));
        return real === undefined ? null : store.getItem(real);
      },
      [area, key] as const,
    );
  const { value, ok } = await settle(read, (v) => (expected === undefined ? v !== null : v === expected), 3000);
  if (!ok)
    throw new Error(
      `Storage check failed\n\nExpected: ${area} storage ${key}${expected === undefined ? ' is set' : ` is "${expected}"`}\nActual: ${value === null ? `${key} is not set` : `${key} is "${value}"`}`,
    );
}

/** The page loaded within a time (milliseconds), measured by the browser. */
export async function expectLoadTime(page: Page, compare: Compare, ms: number): Promise<void> {
  const took = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav ? Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd) : -1;
  });
  if (took < 0 || !compares(took, compare, ms))
    throw new Error(
      `Load time check failed\n\nExpected: the page loads in ${COMPARE_WORDS[compare]} ${ms} ms\nActual: ${took < 0 ? 'the load time could not be measured' : `it loaded in ${took} ms`}`,
    );
}

/** Layout shift and largest paint, measured by the browser. */
export async function expectWebVitals(page: Page, limits: { cls?: number; lcpMs?: number }): Promise<void> {
  const v = await page.evaluate(
    () =>
      new Promise<{ cls: number; lcp: number }>((resolve) => {
        let cls = 0;
        let lcp = 0;
        try {
          new PerformanceObserver((l) => {
            for (const e of l.getEntries() as unknown as Array<{ hadRecentInput: boolean; value: number }>) if (!e.hadRecentInput) cls += e.value;
          }).observe({ type: 'layout-shift', buffered: true });
          new PerformanceObserver((l) => {
            const last = l.getEntries().at(-1);
            if (last) lcp = last.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {}
        setTimeout(() => resolve({ cls: Math.round(cls * 1000) / 1000, lcp: Math.round(lcp) }), 500);
      }),
  );
  const bad: string[] = [];
  if (limits.cls !== undefined && v.cls > limits.cls) bad.push(`layout shift ${v.cls} (limit ${limits.cls})`);
  if (limits.lcpMs !== undefined && v.lcp > limits.lcpMs) bad.push(`largest paint ${v.lcp} ms (limit ${limits.lcpMs} ms)`);
  if (bad.length) throw new Error(`Web vitals check failed\n\nExpected: ${JSON.stringify(limits)}\nActual: ${bad.join('; ')}`);
}

/** A file was downloaded (optionally with this name); `content` checks a text file such as CSV. */
export async function expectDownload(page: Page, want: { name?: string; rows?: number; header?: string[]; notEmpty?: boolean } = {}): Promise<void> {
  const log = logOf(page);
  const { value, ok } = await settle(
    async () => log.downloads.slice(),
    (v) => v.length > 0 && (!want.name || v.some((d) => d.name === want.name)),
    8000,
  );
  if (!ok)
    throw new Error(
      `Download check failed\n\nExpected: a download${want.name ? ` named ${want.name}` : ''}\nActual: ${value.length ? `downloads: ${value.map((d) => d.name).join(', ')}` : 'nothing was downloaded'}`,
    );
  const file = value.find((d) => !want.name || d.name === want.name)!;
  if (want.rows === undefined && !want.header && !want.notEmpty) return;
  const text = await file.read();
  const lines = (text ?? '').split(/\r?\n/).filter(Boolean);
  const problems: string[] = [];
  if (want.notEmpty && !(text ?? '').length) problems.push('the file is empty');
  if (want.header && !want.header.every((h) => (lines[0] ?? '').toLowerCase().includes(h.toLowerCase()))) problems.push(`the header is "${lines[0] ?? ''}"`);
  if (want.rows !== undefined && lines.length - 1 !== want.rows) problems.push(`it has ${Math.max(0, lines.length - 1)} data rows`);
  if (problems.length) throw new Error(`Download content check failed\n\nExpected: ${JSON.stringify(want)}\nActual: ${file.name}: ${problems.join('; ')}`);
}

/** Every field has a label (or a name for screen readers). */
export async function expectFieldsLabelled(page: Page): Promise<void> {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), select, textarea')]
      .filter((el) => {
        const e = el as HTMLInputElement;
        const named =
          e.getAttribute('aria-label') ||
          e.getAttribute('aria-labelledby') ||
          e.getAttribute('title') ||
          (e.labels && e.labels.length > 0) ||
          e.closest('label');
        return !named;
      })
      .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('name') ? `[name=${el.getAttribute('name')}]` : ''}`),
  );
  if (bad.length)
    throw new Error(`Labels check failed\n\nExpected: every field has a label\nActual: ${bad.length} field(s) without a label: ${bad.slice(0, 5).join(', ')}`);
}

/** Every image has alternative text. */
export async function expectImagesHaveAlt(page: Page): Promise<void> {
  const bad = await page.evaluate(() => [...document.querySelectorAll('img:not([alt])')].map((i) => i.getAttribute('src') ?? '(no src)'));
  if (bad.length)
    throw new Error(
      `Image text check failed\n\nExpected: every image has alternative text\nActual: ${bad.length} image(s) without it: ${bad.slice(0, 3).join(', ')}`,
    );
}

/** Pressing Tab moves through these elements in this order. */
export async function expectTabOrder(page: Page, names: string[]): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen: string[] = [];
  for (let i = 0; i < names.length; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const e = document.activeElement as HTMLInputElement | null;
        return (
          e?.getAttribute('aria-label') ||
          e?.labels?.[0]?.textContent ||
          e?.getAttribute('placeholder') ||
          e?.value ||
          e?.textContent ||
          e?.getAttribute('name') ||
          e?.tagName ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();
      }),
    );
  }
  const same = names.every((n, i) => seen[i]?.toLowerCase().includes(n.toLowerCase()));
  if (!same) throw new Error(`Tab order check failed\n\nExpected: Tab goes ${names.join(' → ')}\nActual: Tab goes ${seen.join(' → ')}`);
}

/** The total equals the sum of the items (prices, amounts), to two decimals. */
export async function expectSum(items: Locator, total: Locator): Promise<void> {
  const values = (await items.allTextContents()).map(numberIn).filter((n) => !Number.isNaN(n));
  const shown = numberIn((await total.first().textContent()) ?? '');
  const sum = Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
  if (Math.abs(sum - shown) > 0.005)
    throw new Error(
      `Sum check failed\n\nExpected: the total equals the sum of the items\nActual: the items add up to ${sum} (${values.join(' + ')}), the total shows ${shown}`,
    );
}

/** A number shown (a badge, a counter) equals how many items there are. */
export async function expectCountMatches(counter: Locator, items: Locator): Promise<void> {
  const shown = numberIn((await counter.first().textContent()) ?? '');
  const count = await items.count();
  if (shown !== count)
    throw new Error(`Count check failed\n\nExpected: the number shown equals the number of items\nActual: it shows ${shown}, there are ${count} items`);
}

/** A value changes to this within a time (a status that goes from Pending to Done). */
export async function expectEventually(read: () => Promise<string | null>, expected: string, timeout = 30000): Promise<void> {
  const { value, ok } = await settle(
    async () => ((await read()) ?? '').trim(),
    (v) => v.toLowerCase().includes(expected.toLowerCase()),
    timeout,
  );
  if (!ok) throw new Error(`Timing check failed\n\nExpected: it becomes "${expected}" within ${timeout / 1000} seconds\nActual: it was "${value}" at the end`);
}
