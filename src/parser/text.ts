/**
 * Small text helpers shared by the parser. All functions are pure and deterministic (NFR-02).
 */

export interface NumberedLine {
  /** The tester's step number, or the position when the cell has no numbering. */
  n: number;
  text: string;
}

const MARKER = /(^|\s)(?:step[ \t]*(\d{1,3})[ \t]*[:.)-]?|(\d{1,3})[ \t]*[.)])\s+/gi;
const BULLET = /^\s*[-*•●▪]\s+/;

/**
 * Splits a cell into numbered items (FR-IN-03).
 *
 * "1. Open Home 2. Click Login" and one-item-per-line both work. A number only starts a new item
 * when it is the next number in sequence, so "Enter 5. Then…" does not break a step in two.
 * In a numbered cell, a line without a number continues the item above it.
 */
export function splitNumbered(cell: string): NumberedLine[] {
  const text = cell.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];

  const markers: Array<{ index: number; end: number; n: number }> = [];
  let expected: number | undefined;
  for (const m of text.matchAll(MARKER)) {
    const n = Number(m[2] ?? m[3]);
    const index = m.index + m[1].length;
    if (expected === undefined ? index !== 0 : n !== expected) continue;
    markers.push({ index, end: m.index + m[0].length, n });
    expected = n + 1;
  }

  if (!markers.length) {
    return text
      .split('\n')
      .map((line) => line.replace(BULLET, '').trim())
      .filter(Boolean)
      .map((line, i) => ({ n: i + 1, text: line }));
  }
  return markers
    .map((m, i) => ({
      n: m.n,
      text: text
        .slice(m.end, markers[i + 1]?.index ?? text.length)
        .replace(/\s*\n\s*/g, ' ')
        .trim(),
    }))
    .filter((l) => l.text);
}

/** Splits a cell into items on numbering, bullets, line breaks and (optionally) semicolons. */
export function splitList(cell: string, options: { semicolons?: boolean } = {}): string[] {
  const items = splitNumbered(cell).map((l) => l.text);
  return options.semicolons ? items.flatMap((i) => splitOutsideQuotes(i, /\s*;\s*/)).filter(Boolean) : items;
}

/** Splits text into sentences: "Error is shown. User stays on Login." → two items. Quotes are kept whole. */
export function splitSentences(text: string): string[] {
  return splitOutsideQuotes(text, /(?<=[.!?])\s+(?=[A-Z"'“‘])/);
}

/** Splits on `separator`, never inside a quoted string. */
export function splitOutsideQuotes(text: string, separator: RegExp): string[] {
  const p = protectQuotes(text);
  return p.text
    .split(separator)
    .map((part) => p.restore(part).trim())
    .filter(Boolean);
}

/** Removes decoration that is not part of an element name: arrows, trailing punctuation, extra spaces (FR-PA-05). */
export function clean(text: string): string {
  return text
    .replace(/\s*(?:→|➜|➔|➞|⇒|⟶|->|=>|»)\s*/g, ' ')
    .replace(/\s*>+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!]+$/, '')
    .trim();
}

export interface Quoted {
  value: string;
  start: number;
  end: number;
}

const QUOTES = [
  /"([^"]+)"/,
  /“([^”]+)”/,
  /‘([^’]+)’/,
  /`([^`]+)`/,
  // An apostrophe inside a word ("user's") is not a quote.
  /(?<![\p{L}\p{N}])'([^']+?)'(?![\p{L}\p{N}])/u,
];

/** The first quoted string in `text`, with any of the usual quote marks. */
export function findQuoted(text: string): Quoted | undefined {
  let best: Quoted | undefined;
  for (const re of QUOTES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.start)) best = { value: m[1].trim(), start: m.index, end: m.index + m[0].length };
  }
  return best;
}

/** Removes one pair of surrounding quotes, if present. */
export function unquote(text: string): string {
  const t = text.trim();
  const q = findQuoted(t);
  return q && q.start === 0 && q.end === t.length ? q.value : t;
}

const OPEN = '';
const CLOSE = '';

/**
 * Replaces each quoted string with a placeholder, so rules (negation words, "and", sentence ends)
 * never look inside the text the tester quoted. `restore` puts the original quotes back.
 */
export function protectQuotes(text: string): { text: string; restore: (s: string) => string } {
  const saved: string[] = [];
  let rest = text;
  let out = '';
  for (let q = findQuoted(rest); q; q = findQuoted(rest)) {
    out += rest.slice(0, q.start) + OPEN + saved.length + CLOSE;
    saved.push(rest.slice(q.start, q.end));
    rest = rest.slice(q.end);
  }
  out += rest;
  const restore = (s: string) => s.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, i) => saved[Number(i)]);
  return { text: out, restore };
}

export function hasProtectedQuote(text: string): boolean {
  return text.includes(OPEN);
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex for a phrase as whole words, with any run of spaces between the words. */
export function phraseRegex(phrase: string, flags = 'i'): RegExp {
  const body = phrase.trim().split(/\s+/).map(escapeRegex).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags.includes('u') ? flags : flags + 'u');
}

/** Verb forms a tester might use: click → clicks, clicked, clicking; type → typed, typing; submit → submitted. */
export function inflections(word: string): string[] {
  const w = word.toLowerCase();
  const forms = new Set([w, `${w}s`, `${w}es`, `${w}ed`, `${w}ing`]);
  if (w.endsWith('e')) {
    forms.add(`${w}d`);
    forms.add(`${w.slice(0, -1)}ing`);
  }
  if (w.endsWith('y')) forms.add(`${w.slice(0, -1)}ies`);
  if (/[^aeiou][aeiou][bdgmnpt]$/.test(w)) {
    forms.add(`${w}${w.at(-1)}ed`);
    forms.add(`${w}${w.at(-1)}ing`);
  }
  return [...forms];
}

export interface LeadingMatch<T> {
  phrase: string;
  value: T;
  rest: string;
}

const leadingCache = new Map<string, RegExp>();

/**
 * Finds the longest phrase that starts `text`, e.g. "click on" before "click".
 * With `inflect`, the first word may be in any verb form ("clicks on").
 */
export function matchLeading<T>(text: string, phrases: Array<[string, T]>, inflect = false): LeadingMatch<T> | undefined {
  const sorted = [...phrases].sort(([a], [b]) => wordCount(b) - wordCount(a) || b.length - a.length || a.localeCompare(b));
  for (const [phrase, value] of sorted) {
    const cacheKey = `${inflect}|${phrase}`;
    let re = leadingCache.get(cacheKey);
    if (!re) {
      const [first, ...others] = phrase.toLowerCase().trim().split(/\s+/);
      const head = inflect ? `(?:${inflections(first).map(escapeRegex).join('|')})` : escapeRegex(first);
      const tail = others.map((w) => `\\s+${escapeRegex(w)}`).join('');
      re = new RegExp(`^${head}${tail}(?![\\p{L}\\p{N}'’])[\\s,:]*`, 'iu');
      leadingCache.set(cacheKey, re);
    }
    const m = re.exec(text);
    if (m) return { phrase, value, rest: text.slice(m[0].length).trim() };
  }
  return undefined;
}

/** Removes every occurrence of the phrases (whole words). Returns what was removed, for warnings. */
export function removePhrases(text: string, phrases: string[]): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text;
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    const re = phraseRegex(phrase, 'giu');
    if (re.test(out)) {
      removed.push(phrase);
      out = out.replace(re, ' ');
    }
  }
  return { text: out.replace(/\s+/g, ' ').trim(), removed };
}

export function containsPhrase(text: string, phrases: string[]): string | undefined {
  return phrases.find((p) => phraseRegex(p).test(text));
}

export function looksLikeUrl(text: string): boolean {
  return /^(?:https?:\/\/|www\.|\/)/i.test(text.trim());
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

/** Stable 32-bit FNV-1a hash, used for generated ids (the same title always gets the same id). */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
