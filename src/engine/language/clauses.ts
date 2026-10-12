import type { Token } from '../text/index.js';
import { isSymbol, type Line, lw, originalOf } from './view.js';
import { ASSERTION_WORDS, isCommandForm } from './vocabulary.js';

/**
 * Layer 8, the clause parser (CL-01). A sentence is cut into clauses at and, or, but, then, while, because, if, when,
 * unless, otherwise, after, before and until, and at the end of a sentence. Each clause remembers the word that
 * joined it to the one before (`relation`), so the grammar can tell "A and B" from "A if B".
 *
 * A word like `and` only cuts when both sides are clauses of their own. "Terms and Conditions" and "Enter username and
 * password" are one clause with a list in it; "Login is not performed and the system displays a message" is two.
 */

export type Relation =
  | 'FIRST'
  | 'SENTENCE'
  | 'COMMA'
  | 'AND'
  | 'OR'
  | 'BUT'
  | 'THEN'
  | 'IF'
  | 'WHEN'
  | 'UNLESS'
  | 'OTHERWISE'
  | 'AFTER'
  | 'BEFORE'
  | 'UNTIL'
  | 'WHILE'
  | 'BECAUSE'
  | 'NOTE';

export interface Clause {
  tokens: Token[];
  relation: Relation;
  /** The word that joined it (`if`, `and`), when there was one. */
  keyword?: string;
  /** The tester's own words for the clause. */
  original: string;
}

const SUBORDINATORS: Readonly<Record<string, Relation>> = {
  if: 'IF',
  when: 'WHEN',
  whenever: 'WHEN',
  unless: 'UNLESS',
  after: 'AFTER',
  before: 'BEFORE',
  until: 'UNTIL',
  while: 'WHILE',
  because: 'BECAUSE',
  otherwise: 'OTHERWISE',
};

const COORDINATORS: Readonly<Record<string, Relation>> = { and: 'AND', or: 'OR', but: 'BUT' };

/** Longer keywords of CD-01, written as word lists; each joins like its first word's relation. */
const PHRASE_SUBORDINATORS: ReadonlyArray<readonly [words: readonly string[], relation: Relation]> = [
  [['only', 'if'], 'IF'],
  [['in', 'case'], 'IF'],
  [['provided', 'that'], 'IF'],
  [['depending', 'on'], 'WHEN'],
  [['based', 'on'], 'WHEN'],
];

/** Words that make a stretch of text a clause of its own: something is said about something. */
const PREDICATE_WORDS: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'were',
  'be',
  'should',
  'must',
  'shall',
  'will',
  'can',
  'cannot',
  'does',
  'do',
  'did',
  'has',
  'have',
  'appears',
  'appear',
  'remains',
  'remain',
  'stays',
  'stay',
  'displays',
  'shows',
  'contains',
  'equals',
  'redirects',
  'rejects',
  'accepts',
  'redirected',
  'rejected',
  'accepted',
  'displayed',
  'shown',
  'navigates',
  'opens',
  'sees',
  'see',
  'performed',
  'visible',
  'enabled',
  'disabled',
  'hidden',
  'empty',
  ...ASSERTION_WORDS.flatMap((a) => a.forms),
]);

/** Words that can stand before the verb of a clause without being part of the thing it acts on. */
const FILLERS: ReadonlySet<string> = new Set([
  'then',
  'also',
  'next',
  'and',
  'please',
  'now',
  'finally',
  'the',
  'a',
  'an',
  'user',
  'tester',
  'system',
  'application',
  'it',
  'to',
]);

const CONNECTORS: ReadonlySet<string> = new Set(['and', 'or', 'but', 'then', ...Object.keys(SUBORDINATORS)]);

/** A stretch of tokens that could be a clause on its own: it starts with an action or a check word, or it says something with a predicate. */
export function isClauseLike(tokens: readonly Token[]): boolean {
  const words = tokens.map((t) => lw(t));
  let i = 0;
  while (i < words.length && FILLERS.has(words[i] as string)) i++;
  const first = words[i];
  if (first === undefined) return false;
  if (isCommandForm(first) || first === 'leave') return true;
  return words.slice(0, 12).some((w) => PREDICATE_WORDS.has(w));
}

/**
 * Whether the text *begins* like a clause: it opens with an action or check word, or says something with a predicate
 * within its first words. A list item that only has a predicate far behind it ("PIM (…), Leave, Time, Help are
 * visible") does not begin one, so the commas of a list are not clause boundaries.
 */
export function startsClause(tokens: readonly Token[]): boolean {
  const words = tokens.map((t) => lw(t));
  let i = 0;
  while (i < words.length && FILLERS.has(words[i] as string)) i++;
  const first = words[i];
  if (first === undefined) return false;
  if (isCommandForm(first) || first === 'leave') return true;
  return words.slice(0, 6).some((w) => PREDICATE_WORDS.has(w));
}

/** The tokens from `from` to the end of the sentence. */
function restOfSentence(tokens: readonly Token[], from: number): Token[] {
  const rest: Token[] = [];
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (isSymbol(t, '.', ';', '!', '?')) break;
    rest.push(t);
  }
  return rest;
}

const startsWithConnector = (tokens: readonly Token[]): boolean => CONNECTORS.has(lw(tokens[0]));

/** Takes out what is written in brackets: an aside, not part of the sentence. */
function withoutBrackets(tokens: readonly Token[]): Token[] {
  const kept: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (isSymbol(t, '(')) depth++;
    else if (isSymbol(t, ')')) depth = Math.max(0, depth - 1);
    else if (depth === 0) kept.push(t);
  }
  return kept;
}

export function splitClauses(line: Line): Clause[] {
  const tokens = withoutBrackets(line.tokens);
  const out: Array<{ tokens: Token[]; relation: Relation; keyword?: string }> = [];
  let cur: Token[] = [];
  let relation: Relation = 'FIRST';
  let keyword: string | undefined;
  const flush = (): void => {
    if (cur.length) out.push({ tokens: cur, relation, ...(keyword ? { keyword } : {}) });
    cur = [];
  };
  const start = (rel: Relation, word?: string): void => {
    flush();
    relation = rel;
    keyword = word;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    const w = lw(t);
    if (isSymbol(t, '.', ';', '!', '?')) {
      start('SENTENCE');
      continue;
    }
    // "... in code text box Note: Text box should accept only numbers": the note starts at the word "note".
    if (isSymbol(t, ':') && cur.length >= 1 && lw(cur[cur.length - 1]) === 'note') {
      cur.pop();
      start('NOTE', 'note');
      continue;
    }
    if (isSymbol(t, ',')) {
      const rest = restOfSentence(tokens, i + 1);
      if (startsWithConnector(rest)) continue; // the connector that follows decides
      const inList = cur.some((x) => isSymbol(x, ','));
      if (!inList && cur.length && isClauseLike(cur) && startsClause(rest)) {
        start('COMMA');
        continue;
      }
      cur.push(t);
      continue;
    }
    if (t.kind === 'WORD') {
      const phrase = PHRASE_SUBORDINATORS.find(([ws]) => ws.every((x, k) => lw(tokens[i + k]) === x));
      if (phrase) {
        start(phrase[1], phrase[0].join(' '));
        i += phrase[0].length - 1;
        continue;
      }
      if (w in SUBORDINATORS) {
        start(SUBORDINATORS[w] as Relation, w);
        continue;
      }
      if (w === 'then') {
        start('THEN', w);
        continue;
      }
      if (w in COORDINATORS) {
        const rest = restOfSentence(tokens, i + 1);
        if (cur.length && isClauseLike(cur) && isClauseLike(rest)) {
          start(COORDINATORS[w] as Relation, w);
          continue;
        }
      }
    }
    cur.push(t);
  }
  flush();
  return out.map((c) => ({ ...c, original: originalOf(line, c.tokens) })).filter((c) => c.tokens.length > 0);
}
