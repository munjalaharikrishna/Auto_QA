import { type NormalizedText, normalize, type Token, tokenize } from '../text/index.js';
import { fixTypo } from './synonyms.js';

/**
 * A line of a test case as the language layers see it: the original words, the normalized text, and its tokens. The
 * tokens keep the span of the original behind each of them (NM-19), so any decision can show the tester's own words.
 */
export interface Line {
  raw: string;
  n: NormalizedText;
  tokens: Token[];
}

export function readLine(raw: string): Line {
  const n = normalize(raw);
  return { raw, n, tokens: tokenize(n) };
}

/** The form of a token used to compare it with the vocabulary: lower case, a known misspelling put right. */
export const lw = (t: Token | undefined): string => (!t ? '' : t.kind === 'WORD' ? fixTypo(t.text.toLowerCase()) : t.text);

export const wordsOf = (tokens: readonly Token[]): string[] => tokens.map(lw);

/** The tester's own words behind a run of tokens, exactly as written (NM-19). */
export function originalOf(line: Line, tokens: readonly Token[]): string {
  const first = tokens.find((t) => t.original)?.original;
  const last = [...tokens].reverse().find((t) => t.original)?.original;
  if (!first || !last) return '';
  return line.raw.slice(first.start, last.end).trim();
}

/** The value of a literal token, the text of any other. */
export const textOf = (t: Token): string => (t.kind === 'LITERAL' ? (t.value ?? '') : t.text);

export const isSymbol = (t: Token | undefined, ...chars: string[]): boolean => t?.kind === 'SYMBOL' && (chars.length === 0 || chars.includes(t.text));
