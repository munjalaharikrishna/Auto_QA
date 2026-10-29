import { compactKey } from '../text/compound.js';
import type { FieldKind } from './classes.js';

/**
 * A format rule: what a field accepts, said by a note such as "Text box should accept only alphabets". Nothing verifies the
 * note (typing other characters and seeing them refused is a test of its own), but it tells the data generator what a valid
 * value of that field looks like, and what an invalid one is. Without it a valid "Last name" is made of letters by chance of
 * the field's name, and a valid "Code" of digits only because of the word "code".
 */
export const FIELD_FORMATS = ['ALPHA', 'NUMERIC', 'ALPHANUMERIC'] as const;
export type FieldFormat = (typeof FIELD_FORMATS)[number];

/** The words that name a format. Longer phrases first is not needed: each is one word. */
export const FORMAT_WORDS: Record<FieldFormat, readonly string[]> = {
  ALPHA: ['alphabets', 'alphabet', 'alphabetic', 'alphabetical', 'letters', 'letter', 'alphabetic characters', 'text'],
  NUMERIC: ['numbers', 'number', 'numeric', 'numerals', 'digits', 'digit', 'numeric characters'],
  ALPHANUMERIC: ['alphanumeric', 'alphanumerics', 'alphanumeric characters'],
};

/** The format in the tester's plain words, for messages. */
export const FORMAT_LABEL: Record<FieldFormat, string> = { ALPHA: 'letters', NUMERIC: 'digits', ALPHANUMERIC: 'letters and digits' };

const FORMAT_OF = new Map<string, FieldFormat>();
for (const f of FIELD_FORMATS) for (const w of FORMAT_WORDS[f]) FORMAT_OF.set(w, f);

const ACCEPT = new Set(['accept', 'accepts', 'allow', 'allows', 'take', 'takes', 'permit', 'permits']);
const MODAL = new Set(['should', 'must', 'will', 'can', 'shall', 'to']);
/** A subject that is no name: it means the field the step before it typed in. */
const GENERIC = new Set(['text box', 'textbox', 'text field', 'textfield', 'input', 'input field', 'input box', 'field', 'it', 'this', 'box', 'this field']);

export interface FormatRule {
  format: FieldFormat;
  /** The field the note names; undefined when it says only "the text box", and the field of the step before it is meant. */
  field?: string;
}

const isWordChar = (c: string): boolean => c.toLowerCase() !== c.toUpperCase() || (c >= '0' && c <= '9');

const clean = (w: string): string => {
  let from = 0;
  let to = w.length;
  while (from < to && !isWordChar(w[from] as string)) from++;
  while (to > from && !isWordChar(w[to - 1] as string)) to--;
  return w.slice(from, to);
};

/** Reads "<field> should accept only <format>". It needs "only": "accepts numbers" does not say that letters are refused. */
export function formatRuleOf(text: string): FormatRule | undefined {
  const words = text.replaceAll('\n', ' ').replaceAll('\t', ' ').split(' ').map(clean).filter(Boolean);
  const lower = words.map((w) => w.toLowerCase());
  const at = lower.findIndex((w) => ACCEPT.has(w));
  if (at < 0) return undefined;
  const rest = lower.slice(at + 1);
  if (rest[0] !== 'only' && rest[0] !== 'just') return undefined;
  const tail = rest.slice(1).filter((w) => w !== 'and' && w !== 'the');
  const format = FORMAT_OF.get(tail.join(' ')) ?? (tail.length === 1 ? FORMAT_OF.get(tail[0] as string) : undefined);
  if (!format) return undefined;
  const subject = words
    .slice(0, at)
    .filter((w, i) => !(MODAL.has(w.toLowerCase()) && i === words.slice(0, at).length - 1))
    .filter((w, i) => !(i === 0 && ['the', 'a', 'an'].includes(w.toLowerCase())));
  const name = subject.join(' ');
  if (!name || GENERIC.has(name.toLowerCase())) return { format };
  return { format, field: name };
}

/** The key a format rule is kept under: the same key the data resolver compares field names by. */
export const formatKeyOf = (field: string): string => compactKey(field);

/** Kinds of field the format decides: a secret, a file, an email or a date has a shape of its own. */
export const FORMAT_APPLIES: ReadonlySet<FieldKind> = new Set<FieldKind>(['personName', 'number', 'code', 'text', 'phone']);
