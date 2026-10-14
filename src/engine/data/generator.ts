import { createHash } from 'node:crypto';
import type { DataClass } from '../ir/schema.js';
import type { FieldKind } from './classes.js';

/**
 * Layer 18, the test data generator (DG-01). Every generated value is reproducible: it depends on a seed made from the
 * test ID, the step and the run, and on nothing else (no clock, no random source of the machine). The same seed gives
 * the same value, on any machine, in any order. Every value comes with the rule that made it, for the execution log.
 */

export interface GeneratedValue {
  value: string;
  /** The rule that made it, e.g. `unique.email`, `invalid.number`, `long.string(255)`. */
  rule: string;
  seed: string;
  /** A generated secret is never written in a log, only its rule and seed. */
  secret: boolean;
}

export interface GenerateOptions {
  /** The length a MAXIMUM or BOUNDARY value is made to. The limit of a field comes from the application's knowledge; without it, 255. */
  maxLength?: number;
  /** The shortest value a field takes. Without it a value just under the minimum cannot be made: it is asked for, never guessed. */
  minLength?: number;
  /** The day dates are counted from. Fixed, so a date never depends on today. */
  referenceDate?: string;
}

export const DEFAULT_MAX_LENGTH = 255;
export const REFERENCE_DATE = '2024-02-21';

/** The seed of a value: the test, the step and the run say which value it is, so two steps never share one by accident. */
export const seedOf = (testId: string, step: string, run = 'run-1', key = ''): string =>
  createHash('sha256').update(`${testId}|${step}|${run}|${key}`).digest('hex');

/** mulberry32: a small generator with a 32-bit state, the same on every machine. */
function prng(seed: string): () => number {
  let a = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*';
const SYLLABLES = ['ma', 're', 'ko', 'li', 'sa', 'to', 'ne', 'vi', 'lo', 'da', 'mi', 'ra', 'su', 'be', 'no', 'ka'];

const pick = (next: () => number, chars: string): string => chars[Math.floor(next() * chars.length)] as string;
const run = (next: () => number, chars: string, n: number): string => Array.from({ length: n }, () => pick(next, chars)).join('');
const word = (next: () => number, syllables: number): string => {
  const w = Array.from({ length: syllables }, () => SYLLABLES[Math.floor(next() * SYLLABLES.length)]).join('');
  return `${w[0]?.toUpperCase()}${w.slice(1)}`;
};

/** A valid value of a kind (what the application should accept, as far as the kind of the field tells). */
function valid(kind: FieldKind, next: () => number, options: GenerateOptions): { value: string; rule: string; secret?: boolean } {
  switch (kind) {
    case 'email':
      return { value: `qa.${run(next, `${LOWER}${DIGITS}`, 8)}@example.test`, rule: 'unique.email' };
    case 'username':
      return { value: `qa_user_${run(next, `${LOWER}${DIGITS}`, 6)}`, rule: 'unique.username' };
    case 'password':
      return {
        value: `${pick(next, UPPER)}${pick(next, LOWER)}${pick(next, DIGITS)}${pick(next, SYMBOLS)}${run(next, `${UPPER}${LOWER}${DIGITS}`, 8)}`,
        rule: 'password.strong',
        secret: true,
      };
    case 'personName':
      return { value: word(next, 3), rule: 'person.name' };
    case 'number':
      return { value: run(next, DIGITS, 6), rule: 'number.digits(6)' };
    case 'code':
      return { value: `${pick(next, '123456789')}${run(next, DIGITS, 4)}`, rule: 'code.digits(5)' };
    case 'phone':
      return { value: `+1555${run(next, DIGITS, 7)}`, rule: 'phone.e164' };
    case 'date': {
      const base = new Date(`${options.referenceDate ?? REFERENCE_DATE}T00:00:00Z`);
      base.setUTCDate(base.getUTCDate() + Math.floor(next() * 365));
      return { value: base.toISOString().slice(0, 10), rule: 'date.offset' };
    }
    case 'file':
      return { value: `qa-${run(next, `${LOWER}${DIGITS}`, 6)}.txt`, rule: 'file.name' };
    default:
      return { value: `qa ${word(next, 2).toLowerCase()} ${run(next, DIGITS, 3)}`, rule: 'text.words' };
  }
}

/** A value of a kind that the application should reject. */
function invalid(kind: FieldKind, next: () => number): { value: string; rule: string } {
  switch (kind) {
    case 'email':
      return { value: `not-an-email-${run(next, LOWER, 4)}`, rule: 'invalid.email' };
    case 'username':
      return { value: `inv@lid user ${run(next, DIGITS, 3)}!`, rule: 'invalid.username' };
    case 'password':
      return { value: run(next, LOWER, 1), rule: 'invalid.password' };
    case 'personName':
      return { value: run(next, DIGITS, 5), rule: 'invalid.name' };
    case 'number':
    case 'code':
      return { value: `abc${run(next, UPPER, 3)}`, rule: `invalid.${kind}` };
    case 'phone':
      return { value: run(next, DIGITS, 2), rule: 'invalid.phone' };
    case 'date':
      return { value: '99/99/9999', rule: 'invalid.date' };
    default:
      return { value: `@@@###${run(next, DIGITS, 3)}`, rule: 'invalid.text' };
  }
}

/** A string of `length` characters that suits the kind: digits for a number, letters for a name. */
function long(kind: FieldKind, next: () => number, length: number): string {
  const chars = kind === 'number' || kind === 'code' || kind === 'phone' ? DIGITS : kind === 'personName' ? LOWER : `${LOWER}${DIGITS}`;
  return run(next, chars, length);
}

/**
 * The value of a class for a field of a kind. Throws for a class no generator can make: an EXISTING value is one the
 * application already has, which only the application (or the tester) knows.
 */
export function generate(cls: DataClass, kind: FieldKind, seed: string, options: GenerateOptions = {}): GeneratedValue {
  const next = prng(seed);
  const max = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const make = (value: string, rule: string, secret = false): GeneratedValue => ({ value, rule, seed, secret });
  switch (cls) {
    case 'VALID':
    case 'GENERATED': {
      const v = valid(kind, next, options);
      return make(v.value, v.rule, v.secret ?? kind === 'password');
    }
    case 'INVALID': {
      const v = invalid(kind, next);
      return make(v.value, v.rule, kind === 'password');
    }
    case 'RANDOM':
      return make(run(next, `${LOWER}${UPPER}${DIGITS}`, 8), 'random.string(8)', kind === 'password');
    case 'NON_EXISTING':
      return make(`nonexistent_${run(next, `${LOWER}${DIGITS}`, 8)}`, 'nonexistent.name');
    case 'MAXIMUM':
      return make(long(kind, next, max), `long.string(${max})`, kind === 'password');
    case 'BOUNDARY':
      return make(long(kind, next, max + 1), `boundary.max+1(${max})`, kind === 'password');
    case 'MINIMUM': {
      const min = Math.max(1, options.minLength ?? 1);
      return make(long(kind, next, min), `short.string(${min})`, kind === 'password');
    }
    case 'BELOW_MINIMUM': {
      if (options.minLength === undefined)
        throw new Error('the shortest value of this field is not known, so one just under it cannot be made: give the minimum in the application knowledge');
      return make(long(kind, next, Math.max(0, options.minLength - 1)), `boundary.min-1(${options.minLength})`, kind === 'password');
    }
    case 'WHITESPACE':
      // A no-break space, an em space, a thin space and an ideographic space: they look empty and are not.
      return make('   　', 'whitespace.unicode');
    case 'EMPTY':
    case 'BLANK':
      return make('', 'blank');
    default:
      throw new Error(`no generator makes a ${cls} value`);
  }
}
