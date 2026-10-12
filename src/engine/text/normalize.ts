import { expandAbbreviation, expandContraction, patterns, quotedValue } from '../patterns/index.js';

/**
 * Layer 2, text normalization (NM-01 to NM-20). It makes the words of a sentence comparable and never touches the
 * data inside it. Two ideas carry the whole layer:
 *
 *  - **Protected text.** Before anything changes, the pieces that are data are found: quoted text, URLs, emails,
 *    IDs, variables, placeholders, file paths, API paths, technical terms, and words that look like data (a letter
 *    next to a digit, `camelCase`, a symbol inside a word). Every rule skips them (NM-13 to NM-18, NM-20).
 *  - **The mapping.** Every character of the result remembers the span of the original it came from (NM-19), so a
 *    report can always show the tester's own words behind any decision.
 *
 * Test data has a stronger rule still: `kind: 'data'` returns the text unchanged, whatever it contains (NM-20).
 */

export interface Span {
  start: number;
  end: number;
}

export interface NormChange {
  rule: string;
  /** What was there, in the original. Only ever text that was not protected. */
  from: string;
  to: string;
  at: Span;
}

export interface NormalizedText {
  /** The text exactly as it came in (NM-02). */
  raw: string;
  text: string;
  /** For every UTF-16 unit of `text`, the span of `raw` it came from (NM-19). */
  map: Span[];
  /** Where the text is data, in `text` coordinates. Nothing in these spans was changed (NM-20). */
  protectedSpans: Span[];
  changes: NormChange[];
  /** How many times each rule changed something, `NM-01` included. */
  applied: Record<string, number>;
}

export interface NormalizeOptions {
  /** `data`: a test-data value, returned exactly as given. Default `sentence`. */
  kind?: 'sentence' | 'data';
  /** Lower case the words that are not data (NM-01). Default true. */
  lowercase?: boolean;
}

interface Cell {
  ch: string;
  o0: number;
  o1: number;
  prot: boolean;
}

const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟', '«', '»', '〝', '〞', '＂']);
const SINGLE_OPEN = new Set(['‘', '‛']);
const APOSTROPHES = new Set(['’', 'ʼ', '`', '´', '′', '＇']);
const DASHES = new Set(['–', '—', '‑', '‒', '―', '−', '‐', '﹘', '﹣', '－']);
const HIDDEN = new Set(['​', '‌', '‍', '⁠', '﻿', '­']);

const isSpace = (c: string): boolean => c.trim() === '';
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isLetter = (c: string): boolean => c.toLowerCase() !== c.toUpperCase();
const isUpper = (c: string): boolean => isLetter(c) && c === c.toUpperCase() && c !== c.toLowerCase();
const isLower = (c: string): boolean => isLetter(c) && c === c.toLowerCase() && c !== c.toUpperCase();
const SYMBOLS_IN_DATA = new Set(['@', '#', '$', '%', '^', '&', '*', '+', '=', '~', '|', '\\']);
const EDGE_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '<', '>', '"', "'"]);

/** A word that reads as data rather than language: `Admin123`, `OrangeHRM`, `Pa$$w0rd` (NM-14, NM-15). */
function looksLikeData(core: string): boolean {
  const chars = [...core];
  const hasLetter = chars.some(isLetter);
  if (!hasLetter) return false;
  if (chars.some(isDigit)) return true;
  if (chars.some((c) => SYMBOLS_IN_DATA.has(c))) return true;
  for (let i = 1; i < chars.length; i++) if (isUpper(chars[i] as string) && isLower(chars[i - 1] as string)) return true;
  return false;
}

/** The spans of the raw text that are data. Positions are UTF-16 indexes into `raw`. */
function protectedRawSpans(raw: string): Span[] {
  const spans: Span[] = [];
  const found = patterns().scan(raw, ['quotedString', 'url', 'email', 'identifier', 'technicalTerm', 'variable', 'placeholder', 'filePath', 'apiEndpoint']);
  for (const m of found.matches) {
    // The quote marks themselves are normalized to straight quotes; what is between them is the value.
    if (m.pattern === 'quotedString') spans.push({ start: m.start + 1, end: m.end - 1 });
    else spans.push({ start: m.start, end: m.end });
  }
  // Words that look like data, found chunk by chunk between spaces.
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && isSpace(raw[i] as string)) i++;
    const from = i;
    while (i < raw.length && !isSpace(raw[i] as string)) i++;
    let a = from;
    let b = i;
    while (a < b && EDGE_PUNCT.has(raw[a] as string)) a++;
    while (b > a && EDGE_PUNCT.has(raw[b - 1] as string)) b--;
    if (b > a && looksLikeData(raw.slice(a, b))) spans.push({ start: a, end: b });
  }
  return spans;
}

const mergeSpans = (spans: Span[]): Span[] => {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
};

export function normalize(raw: string, options: NormalizeOptions = {}): NormalizedText {
  if (options.kind === 'data') {
    const map = Array.from({ length: raw.length }, (_, i) => ({ start: i, end: i + 1 }));
    return { raw, text: raw, map, protectedSpans: raw ? [{ start: 0, end: raw.length }] : [], changes: [], applied: {} };
  }

  const changes: NormChange[] = [];
  const applied: Record<string, number> = {};
  const note = (rule: string, from: string, to: string, at: Span): void => {
    applied[rule] = (applied[rule] ?? 0) + 1;
    if (rule !== 'NM-01') changes.push({ rule, from, to, at });
  };

  // One cell per character of the raw text, flagged when it is data.
  const guarded = mergeSpans(protectedRawSpans(raw));
  let cells: Cell[] = [];
  for (let i = 0; i < raw.length; ) {
    const ch = String.fromCodePoint(raw.codePointAt(i) as number);
    cells.push({ ch, o0: i, o1: i + ch.length, prot: guarded.some((s) => i >= s.start && i < s.end) });
    i += ch.length;
  }

  // NM-05 to NM-10: one character at a time, never in protected text.
  const next: Cell[] = [];
  for (const cell of cells) {
    if (cell.prot) {
      next.push(cell);
      continue;
    }
    let out = '';
    const at = { start: cell.o0, end: cell.o1 };
    // The explicit rules come first: NFKC would turn `´` into a space and an accent, so it never reached NM-08.
    const direct = DOUBLE_QUOTES.has(cell.ch) || SINGLE_OPEN.has(cell.ch) || APOSTROPHES.has(cell.ch) || DASHES.has(cell.ch);
    const nfkc = direct ? cell.ch : cell.ch.normalize('NFKC');
    if (nfkc !== cell.ch) note('NM-10', cell.ch, nfkc, at);
    for (const c of nfkc) {
      if (HIDDEN.has(c)) note('NM-10', c, '', at);
      else if (DOUBLE_QUOTES.has(c)) {
        out += '"';
        note('NM-07', c, '"', at);
      } else if (SINGLE_OPEN.has(c)) {
        out += "'";
        note('NM-07', c, "'", at);
      } else if (APOSTROPHES.has(c)) {
        out += "'";
        note('NM-08', c, "'", at);
      } else if (DASHES.has(c)) {
        out += '-';
        note('NM-09', c, '-', at);
      } else if (c === '‚') {
        out += ',';
        note('NM-06', c, ',', at);
      } else if (c === '…') {
        out += '...';
        note('NM-06', c, '...', at);
      } else if (isSpace(c)) {
        out += ' ';
        if (c !== ' ') note('NM-05', c, ' ', at);
      } else out += c;
    }
    if (out) next.push({ ...cell, ch: out });
  }
  cells = next;

  // NM-04 and NM-03: collapse runs of spaces, then trim.
  const collapsed: Cell[] = [];
  for (const cell of cells) {
    const last = collapsed[collapsed.length - 1];
    if (!cell.prot && cell.ch === ' ' && last && !last.prot && last.ch === ' ') {
      last.o1 = cell.o1;
      note('NM-04', '  ', ' ', { start: cell.o0, end: cell.o1 });
    } else collapsed.push({ ...cell });
  }
  const isBlank = (c: Cell | undefined): boolean => c !== undefined && !c.prot && c.ch === ' ';
  while (isBlank(collapsed[0])) {
    const c = collapsed.shift() as Cell;
    note('NM-03', ' ', '', { start: c.o0, end: c.o1 });
  }
  while (isBlank(collapsed[collapsed.length - 1])) {
    const c = collapsed.pop() as Cell;
    note('NM-03', ' ', '', { start: c.o0, end: c.o1 });
  }
  cells = collapsed;

  // NM-01: lower case, only where it is language.
  if (options.lowercase !== false) {
    for (const cell of cells) {
      if (cell.prot) continue;
      const lower = cell.ch.toLowerCase();
      if (lower !== cell.ch) {
        cell.ch = lower;
        note('NM-01', '', '', { start: cell.o0, end: cell.o1 });
      }
    }
  }

  // NM-11 and NM-12: whole words, never across protected text.
  cells = expandWords(cells, note);

  let text = '';
  const map: Span[] = [];
  const guardedOut: Span[] = [];
  for (const cell of cells) {
    const start = text.length;
    text += cell.ch;
    for (let k = 0; k < cell.ch.length; k++) map.push({ start: cell.o0, end: cell.o1 });
    if (cell.prot) guardedOut.push({ start, end: text.length });
  }
  return { raw, text, map, protectedSpans: mergeSpans(guardedOut), changes, applied };
}

function expandWords(cells: Cell[], note: (rule: string, from: string, to: string, at: Span) => void): Cell[] {
  const starts: number[] = [];
  let text = '';
  for (const cell of cells) {
    starts.push(text.length);
    text += cell.ch;
  }
  const cellAt = (pos: number): number => {
    let k = 0;
    while (k + 1 < starts.length && (starts[k + 1] as number) <= pos) k++;
    return k;
  };
  const found = patterns().scan(text, ['abbreviation', 'contraction']);
  const out = [...cells];
  for (const m of [...found.matches].reverse()) {
    const first = cellAt(m.start);
    const last = cellAt(m.end - 1);
    if (cells.slice(first, last + 1).some((c) => c.prot)) continue;
    const replacement = m.pattern === 'abbreviation' ? expandAbbreviation(m.text) : expandContraction(m.text);
    if (replacement === undefined) continue;
    const a = cells[first] as Cell;
    const z = cells[last] as Cell;
    out.splice(first, last - first + 1, { ch: replacement, o0: a.o0, o1: z.o1, prot: false });
    note(m.pattern === 'abbreviation' ? 'NM-11' : 'NM-12', m.text, replacement, { start: a.o0, end: z.o1 });
  }
  return out;
}

/** The span of the original behind a span of the normalized text (NM-19). */
export function originalSpan(n: NormalizedText, span: Span): Span {
  if (n.map.length === 0) return { start: 0, end: 0 };
  const a = n.map[Math.min(Math.max(span.start, 0), n.map.length - 1)] as Span;
  const b = n.map[Math.min(Math.max(span.end - 1, span.start, 0), n.map.length - 1)] as Span;
  return { start: a.start, end: Math.max(b.end, a.end) };
}

/** The original words behind a span of the normalized text. */
export const originalText = (n: NormalizedText, span: Span): string => {
  const o = originalSpan(n, span);
  return n.raw.slice(o.start, o.end);
};

/** Whether any part of the span is data that no rule may change. */
export const touchesData = (n: NormalizedText, span: Span): boolean => n.protectedSpans.some((p) => span.start < p.end && p.start < span.end);

/** The text between the quotes of every quoted value in a sentence, as written (NM-18). */
export const quotedValues = (raw: string): string[] =>
  patterns()
    .scan(raw, ['quotedString'])
    .matches.map((m) => quotedValue(m));
