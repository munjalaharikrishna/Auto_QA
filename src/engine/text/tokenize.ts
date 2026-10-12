import { patterns, quotedValue } from '../patterns/index.js';
import { type NormalizedText, originalSpan, type Span } from './normalize.js';

/**
 * Layer 3, tokenization (TK-01 to TK-10). The text is cut into tokens by the pattern engine, so the order in which
 * two patterns claim the same characters is decided by priority (RX-23), in one place. Whatever no pattern claims
 * is a symbol, one character each. Quoted text is a single LITERAL token, whatever is inside it (TK-04).
 */

export type TokenKind = 'WORD' | 'NUMBER' | 'SYMBOL' | 'LITERAL' | 'VARIABLE' | 'PLACEHOLDER' | 'URL' | 'EMAIL' | 'DATE' | 'SPECIAL';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Position in the text that was tokenized. */
  start: number;
  end: number;
  /** For a LITERAL, the text between the quotes exactly as written. */
  value?: string;
  /** For a SPECIAL: a mask like `***`, or a hidden character. */
  special?: 'mask' | 'hidden';
  /** The span of the original text behind the token, when the input was normalized first (NM-19). */
  original?: Span;
}

const KIND_OF: Record<string, TokenKind> = {
  quotedString: 'LITERAL',
  url: 'URL',
  email: 'EMAIL',
  variable: 'VARIABLE',
  placeholder: 'PLACEHOLDER',
  date: 'DATE',
  mask: 'SPECIAL',
  hiddenChar: 'SPECIAL',
  number: 'NUMBER',
  word: 'WORD',
};

const isSpace = (c: string): boolean => c.trim() === '';

export function tokenize(input: string | NormalizedText): Token[] {
  const text = typeof input === 'string' ? input : input.text;
  const found = patterns().scan(text, Object.keys(KIND_OF));
  const tokens: Token[] = [];
  let at = 0;
  const symbolsUntil = (stop: number): void => {
    while (at < stop) {
      const ch = String.fromCodePoint(text.codePointAt(at) as number);
      if (!isSpace(ch)) tokens.push({ kind: 'SYMBOL', text: ch, start: at, end: at + ch.length });
      at += ch.length;
    }
  };
  for (const m of found.matches) {
    symbolsUntil(m.start);
    const kind = KIND_OF[m.pattern] as TokenKind;
    const token: Token = { kind, text: m.text, start: m.start, end: m.end };
    if (kind === 'LITERAL') token.value = quotedValue(m);
    if (kind === 'SPECIAL') token.special = m.pattern === 'mask' ? 'mask' : 'hidden';
    tokens.push(token);
    at = m.end;
  }
  symbolsUntil(text.length);
  if (typeof input !== 'string') for (const t of tokens) t.original = originalSpan(input, t);
  return tokens;
}

/** The tokens that carry meaning in a sentence: everything except symbols. */
export const contentTokens = (tokens: readonly Token[]): Token[] => tokens.filter((t) => t.kind !== 'SYMBOL');
