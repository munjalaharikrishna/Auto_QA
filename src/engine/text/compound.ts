import type { Token } from './tokenize.js';

/**
 * Compound words (TK-14, TK-15). A field is called `Login Name`, `loginname`, `login_name` or `loginName` by different
 * people; they are the same thing. Two spellings are the same compound when they have the same letters and digits once
 * case, spaces, underscores and hyphens are ignored. The case styles themselves (TK-11 to TK-13) are read by `splitIdentifier`.
 */

const isLetterOrDigit = (c: string): boolean => c.toLowerCase() !== c.toUpperCase() || (c >= '0' && c <= '9');

/** `Login Name`, `login_name`, `loginName` and `loginname` all give `loginname`. */
export function compactKey(text: string): string {
  let key = '';
  for (const c of text) if (isLetterOrDigit(c)) key += c.toLowerCase();
  return key;
}

export type CaseStyle = 'camel' | 'pascal' | 'snake' | 'kebab' | 'plain';

export interface Identifier {
  style: CaseStyle;
  /** The words of the name, lower case: `userName`, `user_name`, `user-name` and `User Name` all give `user`, `name`. */
  words: string[];
}

const isUpper = (c: string): boolean => c !== c.toLowerCase();
const isLower = (c: string): boolean => c !== c.toUpperCase();

/** Cuts a name at its separators; `splitOn` is the character that separates the words. */
const cutAt = (text: string, splitOn: string): string[] => text.split(splitOn).filter((w) => w !== '');

/** Cuts `userName` / `UserName` where a capital starts a word; an acronym stays together (`userID` gives `user`, `ID`). */
function cutAtCapitals(text: string): string[] {
  const words: string[] = [];
  let word = '';
  const chars = [...text];
  chars.forEach((c, i) => {
    const before = chars[i - 1];
    const after = chars[i + 1];
    const startsWord = isUpper(c) && before !== undefined && (isLower(before) || (isUpper(before) && after !== undefined && isLower(after)));
    if (startsWord && word) {
      words.push(word);
      word = '';
    }
    word += c;
  });
  if (word) words.push(word);
  return words;
}

/**
 * Reads the case style of a name and splits it into words (TK-11 camelCase, TK-12 snake_case, TK-13 kebab-case). Text with
 * spaces is plain words. Only a single name is read: a sentence is the tokenizer's job. No regular expression is used (RX-01).
 */
export function splitIdentifier(text: string): Identifier {
  const name = text.trim();
  const lower = (words: string[]): string[] => words.map((w) => w.toLowerCase());
  if (name.includes(' ')) return { style: 'plain', words: lower(cutAt(name, ' ')) };
  if (name.includes('_')) return { style: 'snake', words: lower(cutAt(name, '_')) };
  if (name.includes('-')) return { style: 'kebab', words: lower(cutAt(name, '-')) };
  const words = cutAtCapitals(name);
  const first = name[0];
  const style: CaseStyle = words.length > 1 && first !== undefined && isUpper(first) ? 'pascal' : words.length > 1 ? 'camel' : 'plain';
  return { style, words: lower(words) };
}

/** The name as plain words: `userName` gives `user name`. */
export const spaced = (text: string): string => splitIdentifier(text).words.join(' ');

export const sameCompound = (a: string, b: string): boolean => {
  const key = compactKey(a);
  return key !== '' && key === compactKey(b);
};

export interface CompoundMatch {
  term: string;
  /** Indexes into the token list, both included. */
  from: number;
  to: number;
  start: number;
  end: number;
}

/**
 * Finds known terms in a token list, written in one word, several words, or joined: with `login name` known,
 * `Login Name`, `loginname` and `login_name` are all found. The longest reading wins, left to right.
 */
export function findCompounds(tokens: readonly Token[], terms: readonly string[], maxWords = 3): CompoundMatch[] {
  const known = new Map<string, string>();
  for (const term of terms) {
    const key = compactKey(term);
    if (key && !known.has(key)) known.set(key, term);
  }
  const out: CompoundMatch[] = [];
  let i = 0;
  while (i < tokens.length) {
    let hit: CompoundMatch | undefined;
    for (let len = Math.min(maxWords, tokens.length - i); len >= 1 && !hit; len--) {
      const window = tokens.slice(i, i + len);
      if (window.some((t) => t.kind !== 'WORD')) continue;
      const term = known.get(compactKey(window.map((t) => t.text).join('')));
      if (term !== undefined) hit = { term, from: i, to: i + len - 1, start: (window[0] as Token).start, end: (window[len - 1] as Token).end };
    }
    if (hit) {
      out.push(hit);
      i = hit.to + 1;
    } else i++;
  }
  return out;
}
