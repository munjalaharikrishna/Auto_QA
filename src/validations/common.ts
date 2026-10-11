import type { Assertion } from '../model/test-model.js';
import type { Compare, ParseContext, Parsed } from './types.js';

/** "is", "are", "was", "stays", "remains"…: the linking word of a check. */
export const BE = '(?:is|are|was|were|be|being|gets|get|becomes?|stays?|remains?|looks?)';
/** The same, optional. */
export const OBE = `(?:${BE}\\s+)?`;

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  twenty: 20,
  fifty: 50,
  hundred: 100,
};

/** A number as digits or a word. */
export const NUM = `(?:\\d+(?:[.,]\\d+)?|${Object.keys(WORD_NUMBERS).join('|')})`;

export function toNumber(text: string): number {
  const t = text.trim().toLowerCase();
  return WORD_NUMBERS[t] ?? Number(t.replace(',', '.'));
}

const COMPARE_WORDS: Array<[string, Compare]> = [
  ['at least|no fewer than|no less than|not less than|minimum of|a minimum of|min', 'gte'],
  ['at most|no more than|not more than|up to|maximum of|a maximum of|max', 'lte'],
  ['more than|greater than|over|above|longer than|bigger than', 'gt'],
  ['fewer than|less than|under|below|within|shorter than|smaller than', 'lt'],
  ['exactly|only|equal to', 'eq'],
];

/** A comparison word as part of a pattern: `(?<cmp>…)`. */
export const CMP = `(?:${COMPARE_WORDS.map(([w]) => w).join('|')})`;

export function toCompare(word?: string): Compare {
  if (!word) return 'eq';
  const w = word.trim().toLowerCase();
  return COMPARE_WORDS.find(([words]) => new RegExp(`^(?:${words})$`).test(w))?.[1] ?? 'eq';
}

/** "30 seconds", "2 s", "500 ms", "1 minute" → milliseconds. */
export function toMilliseconds(amount: string, unit: string): number {
  const n = toNumber(amount);
  const u = unit.toLowerCase();
  if (u.startsWith('ms') || u.startsWith('milli')) return Math.round(n);
  if (u.startsWith('m') && !u.startsWith('ms') && !u.startsWith('milli')) return Math.round(n * 60000);
  return Math.round(n * 1000);
}

export const UNIT = '(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?)';

/** Builds a case-insensitive pattern that must match the whole text. */
export function re(source: string): RegExp {
  return new RegExp(`^${source}$`, 'iu');
}

/** Runs the patterns in order; the first that matches builds the result. */
export function firstMatch(text: string, patterns: Array<[RegExp, (g: Record<string, string | undefined>) => Parsed | undefined]>): Parsed | undefined {
  for (const [pattern, build] of patterns) {
    const m = pattern.exec(text);
    if (!m) continue;
    const built = build(m.groups ?? {});
    if (built) return built;
  }
  return undefined;
}

/** "Home, About and Contact" / "Home, About, Contact" → [Home, About, Contact]. */
export function toList(ctx: ParseContext, raw: string): string[] {
  return ctx
    .value(raw)
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((x) =>
      ctx
        .value(x)
        .replace(/^["'“‘]|["'”’]$/g, '')
        .trim(),
    )
    .filter(Boolean);
}

/** Plural nouns a tester uses, and the accessible role of one of them. */
const ROLE_NOUNS: Record<string, string> = {
  rows: 'row',
  records: 'row',
  entries: 'row',
  items: 'listitem',
  links: 'link',
  buttons: 'button',
  images: 'img',
  options: 'option',
  headings: 'heading',
  checkboxes: 'checkbox',
  tabs: 'tab',
  fields: 'textbox',
  inputs: 'textbox',
  errors: 'alert',
  alerts: 'alert',
  messages: 'alert',
  dialogs: 'dialog',
  columns: 'columnheader',
  cells: 'cell',
  menus: 'menuitem',
  paragraphs: 'paragraph',
};

/** The singular of a plural noun, roughly: products → product, categories → category. */
export function singular(noun: string): string {
  const n = noun.trim().toLowerCase();
  if (n.endsWith('ies')) return `${n.slice(0, -3)}y`;
  if (/(xes|ches|shes|sses)$/.test(n)) return n.slice(0, -2);
  return n.endsWith('s') && !n.endsWith('ss') ? n.slice(0, -1) : n;
}

/**
 * Code for "all the things the tester calls <noun>": a role for common words (rows, links, buttons…), otherwise
 * elements whose class, id or test id mentions the word (products → anything with "product" in it).
 */
export function collectionCode(noun: string, quote: (s: string) => string): string {
  const key = noun.trim().toLowerCase().replace(/\s+/g, ' ');
  const last = key.split(' ').at(-1) ?? key;
  const role = ROLE_NOUNS[key] ?? ROLE_NOUNS[last];
  if (role) return `page.getByRole(${quote(role)})`;
  const word = singular(last);
  // The word as a whole class name or part of one (product, product-card, inventory_product), not "products" the container.
  const classes = [`[class~="${word}" i]`, `[class*="${word}-" i]`, `[class*="${word}_" i]`, `[class*="-${word}" i]`, `[class*="_${word}" i]`];
  const ids = ['id', 'data-testid', 'data-test', 'data-qa'].map((a) => `[${a}*="${word}" i]`);
  return `page.locator(${quote([...classes, ...ids].join(', '))})`;
}

/** Wraps an optional timeout for Playwright's own matchers. */
export function timeoutArg(a: Assertion): string {
  return a.options?.timeoutMs ? `{ timeout: ${a.options.timeoutMs} }` : '';
}

export const NOT = (a: Assertion) => (a.negated ? 'not.' : '');

/** The plain words for how a number was compared. */
export function compareWords(op: Compare | undefined): string {
  return { eq: 'exactly', gte: 'at least', lte: 'at most', gt: 'more than', lt: 'fewer than' }[op ?? 'eq'];
}

/** Region words → the nine screen areas. */
export function toRegion(text: string): NonNullable<NonNullable<Assertion['options']>['region']> | undefined {
  const t = text
    .toLowerCase()
    .replace(/upper/g, 'top')
    .replace(/lower/g, 'bottom')
    .replace(/[\s_]+/g, '-')
    .replace(/-?(?:centre|center)$/, '')
    .replace('--', '-');
  const known = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top', 'bottom', 'left', 'right'] as const;
  return known.find((k) => k === t) ?? (/^(?:middle|centre|center)$/.test(text.toLowerCase()) ? 'center' : undefined);
}

/** What the element is called in a sentence: `"Login form"`. */
export function nameOf(a: Assertion): string {
  return a.target ? `"${a.target}"` : 'the element';
}
