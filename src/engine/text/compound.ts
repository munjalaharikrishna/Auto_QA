import type { Token } from './tokenize.js';

/**
 * Compound words (TK-14, TK-15). A field is called `Login Name`, `loginname`, `login_name` or `loginName` by different
 * people; they are the same thing. Two spellings are the same compound when they have the same letters and digits once
 * case, spaces, underscores and hyphens are ignored. Case styles as such (TK-11 to TK-13) are not built yet.
 */

const isLetterOrDigit = (c: string): boolean => c.toLowerCase() !== c.toUpperCase() || (c >= '0' && c <= '9');

/** `Login Name`, `login_name`, `loginName` and `loginname` all give `loginname`. */
export function compactKey(text: string): string {
  let key = '';
  for (const c of text) if (isLetterOrDigit(c)) key += c.toLowerCase();
  return key;
}

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
