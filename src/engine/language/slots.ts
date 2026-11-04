/**
 * The slot grammar (E0.15). A sentence shape is written as a pattern of words and slots instead of a list of phrases or
 * hand-cut positions:
 *
 *   {verb:ENTER_VALUE} {value} (in|into|on) [the] {target}
 *
 *   word             that word, as the normaliser leaves it (lower case, a known typo put right)
 *   (a|b c|d)        one of the alternatives; an alternative may be several words
 *   [a|b]            the same, but optional
 *   {name}           a slot: one or more words, as few as the rest of the pattern allows (so the first "in" ends {value})
 *   {name?}          a slot that may also be empty
 *   {verb}           a verb of the verb table; {verb:ENTER_VALUE} only one doing that action, {verb:fill} only that verb
 *
 * A pattern matches the whole clause, from its first word to its last. Matching is plain backtracking over the words: no
 * regular expression (RX-01), and the patterns are data that a person can read and review.
 */

import { type VerbHit, verbAt } from './verbs.js';

export type Part = { kind: 'words'; alternatives: string[][]; optional: boolean } | { kind: 'slot'; name: string; constraint?: string; optional: boolean };

export interface SlotPattern {
  source: string;
  parts: Part[];
}

export interface Span {
  /** The first word of the slot. */
  from: number;
  /** One past its last word. */
  to: number;
}

export interface SlotMatch {
  pattern: SlotPattern;
  slots: Record<string, Span>;
  /** The verb the {verb} slot read, when the pattern has one. */
  verb?: VerbHit;
}

/** Reads a pattern. Throws on a malformed one: patterns are written by us, a mistake must fail the tests, not a run. */
export function compilePattern(source: string): SlotPattern {
  const parts: Part[] = [];
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`slot pattern "${source}": ${why} at ${i}`);
  };
  const until = (close: string): string => {
    const end = source.indexOf(close, i + 1);
    if (end < 0) fail(`no closing ${close}`);
    const body = source.slice(i + 1, end);
    i = end + 1;
    return body;
  };
  const alternatives = (body: string): string[][] =>
    body.split('|').map((alt) => {
      const words = alt.trim().split(' ').filter(Boolean);
      if (!words.length) fail('an empty alternative');
      return words;
    });
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ') {
      i++;
      continue;
    }
    if (c === '(') parts.push({ kind: 'words', alternatives: alternatives(until(')')), optional: false });
    else if (c === '[') parts.push({ kind: 'words', alternatives: alternatives(until(']')), optional: true });
    else if (c === '{') {
      let body = until('}').trim();
      const optional = body.endsWith('?');
      if (optional) body = body.slice(0, -1);
      const [name, constraint] = body.split(':');
      if (!name) fail('a slot with no name');
      parts.push({ kind: 'slot', name: name as string, ...(constraint ? { constraint } : {}), optional });
    } else {
      let end = i;
      while (end < source.length && !' ([{'.includes(source[end] as string)) end++;
      parts.push({ kind: 'words', alternatives: [[source.slice(i, end)]], optional: false });
      i = end;
    }
  }
  return { source, parts };
}

const CACHE = new Map<string, SlotPattern>();
const compiled = (p: string | SlotPattern): SlotPattern => {
  if (typeof p !== 'string') return p;
  let hit = CACHE.get(p);
  if (!hit) {
    hit = compilePattern(p);
    CACHE.set(p, hit);
  }
  return hit;
};

/** Whether a verb hit satisfies a {verb:…} constraint: an action in capitals, or the verb itself in lower case. */
const verbFits = (hit: VerbHit, constraint: string | undefined): boolean =>
  !constraint || (constraint === constraint.toUpperCase() ? hit.action === constraint : hit.verb === constraint);

/**
 * Matches a pattern against the whole of `words` (from `from` to the end). Slots take as few words as they can, so the first
 * word that can end a slot does; the match that comes first in that order is the one returned.
 */
export function matchSlots(pattern: string | SlotPattern, words: readonly string[], from = 0): SlotMatch | undefined {
  const p = compiled(pattern);
  const slots: Record<string, Span> = {};
  let verb: VerbHit | undefined;
  const walk = (k: number, i: number): boolean => {
    if (k === p.parts.length) return i === words.length;
    const part = p.parts[k] as Part;
    if (part.kind === 'words') {
      for (const alt of part.alternatives) if (alt.every((w, n) => words[i + n] === w) && walk(k + 1, i + alt.length)) return true;
      return part.optional && walk(k + 1, i);
    }
    if (part.name === 'verb') {
      const hit = verbAt(words, i);
      if (hit && verbFits(hit, part.constraint) && walk(k + 1, i + hit.length)) {
        verb = hit;
        slots.verb = { from: i, to: i + hit.length };
        return true;
      }
      return part.optional && walk(k + 1, i);
    }
    // The last part takes everything that is left; any other slot as little as it can.
    for (let to = part.optional ? i : i + 1; to <= words.length; to++) {
      if (walk(k + 1, to)) {
        if (to > i) slots[part.name] = { from: i, to };
        return true;
      }
    }
    return false;
  };
  if (!walk(0, from)) return undefined;
  return { pattern: p, slots, ...(verb ? { verb } : {}) };
}

/** The first of several patterns that matches, in the order given: earlier patterns are the more specific shapes. */
export function firstMatch(patterns: readonly (string | SlotPattern)[], words: readonly string[], from = 0): SlotMatch | undefined {
  for (const p of patterns) {
    const m = matchSlots(p, words, from);
    if (m) return m;
  }
  return undefined;
}
