import { isSecretName } from '../patterns/shapes.js';
import { compactKey } from '../text/compound.js';
import type { Token } from '../text/index.js';
import { canonical } from './synonyms.js';
import type { ValueSpec } from './types.js';
import { type Line, lw, originalOf, textOf } from './view.js';

/**
 * Where a step's value comes from. The Test Data cell of a test case gives named values ("Username: cypress"); a step
 * names one of them ("Enter username"), names a kind of value ("Enter an invalid username"), or writes one in quotes.
 * This binds the words of the step to one of those, or says it could not (never inventing a value: DR-01, E0.5).
 */

export interface DataEntry {
  key: string;
  /** The value exactly as written, without the quotes around it. */
  value: string;
  blank: boolean;
  secret: boolean;
}

const BLANK_WORDS: ReadonlySet<string> = new Set(['blank', 'empty', '<blank>', '<empty>', '(blank)', '(empty)', 'null', 'none', 'nothing']);

const QUOTES = ["'", '"'];

const unquote = (s: string): string => {
  const first = s[0];
  return s.length >= 2 && first !== undefined && QUOTES.includes(first) && s.endsWith(first) ? s.slice(1, -1) : s;
};

/** `Username: cypress` and `Wrong Password=nope`, one pair on a line or several split by `;`. */
export function parseTestData(text: string | undefined): DataEntry[] {
  const entries: DataEntry[] = [];
  for (const piece of (text ?? '').split('\n').flatMap((l) => l.split(';'))) {
    const colon = piece.indexOf(':');
    const equals = piece.indexOf('=');
    const at = colon >= 0 && (equals < 0 || colon < equals) ? colon : equals;
    if (at <= 0) continue;
    const key = piece.slice(0, at).trim();
    const raw = piece.slice(at + 1).trim();
    if (!key) continue;
    const value = unquote(raw);
    const blank = raw === '' || BLANK_WORDS.has(raw.toLowerCase());
    entries.push({ key, value: blank ? '' : value, blank, secret: isSecretName(key) });
  }
  return entries;
}

/** Nouns that stand for a value rather than being one: "Enter password" means the password of the test data. */
const VALUE_NOUNS: ReadonlySet<string> = new Set([
  'username',
  'password',
  'email',
  'emailaddress',
  'name',
  'firstname',
  'lastname',
  'middlename',
  'nickname',
  'fullname',
  'code',
  'id',
  'codeid',
  'phone',
  'phonenumber',
  'mobile',
  'address',
  'number',
  'date',
  'value',
  'text',
  'data',
  'url',
  'file',
  'photo',
  'credentials',
  'input',
  'details',
  'otp',
]);

const DATA_CLASS_WORD: Readonly<Record<string, 'VALID' | 'INVALID' | 'BLANK' | 'EXISTING' | 'NON_EXISTING'>> = {
  valid: 'VALID',
  invalid: 'INVALID',
  blank: 'BLANK',
  existing: 'EXISTING',
  'non-existing': 'NON_EXISTING',
};

/** The words that qualify a value without naming it: "username with leading/trailing spaces". */
const QUALIFIER_WORDS: ReadonlySet<string> = new Set(['with', 'having', 'containing', 'that', 'which', 'of']);

const DETERMINERS: ReadonlySet<string> = new Set(['the', 'a', 'an', 'some', 'any', 'same', 'new']);

export interface BoundValue {
  spec: ValueSpec;
  /** The test-data entry it came from. */
  entry?: DataEntry;
  decisions: string[];
}

const ENV_NAME: Readonly<Record<string, { name: string; secret: boolean }>> = {
  username: { name: 'TEST_USERNAME', secret: false },
  password: { name: 'TEST_PASSWORD', secret: true },
};

/**
 * Binds the words of a value to a source. `tokens` are the words after the verb that name the value; `field` is the
 * target's own name, used when the words say only "valid" or "invalid".
 */
export function bindValue(line: Line, tokens: readonly Token[], data: readonly DataEntry[], field?: string): BoundValue {
  const decisions: string[] = [];
  const only = tokens.length === 1 ? (tokens[0] as Token) : undefined;
  if (only && (only.kind === 'LITERAL' || only.kind === 'NUMBER' || only.kind === 'EMAIL' || only.kind === 'URL' || only.kind === 'DATE')) {
    return { spec: { kind: 'literal', value: textOf(only) }, decisions };
  }

  // Cut a description off the end: "username with leading/trailing spaces" is the username.
  let end = tokens.length;
  for (let i = 1; i < tokens.length; i++)
    if (QUALIFIER_WORDS.has(lw(tokens[i]))) {
      end = i;
      break;
    }
  if (end < tokens.length)
    decisions.push(`"${originalOf(line, tokens.slice(end))}" describes the value; the value itself is "${originalOf(line, tokens.slice(0, end))}"`);
  const head = tokens.slice(0, end).filter((t) => !DETERMINERS.has(lw(t)));
  const words = head.map((t) => lw(t));
  const classWord = words.map((w) => DATA_CLASS_WORD[canonical('Data', w) ?? w]).find((c) => c !== undefined);
  const plain = head.filter((t) => DATA_CLASS_WORD[canonical('Data', lw(t)) ?? lw(t)] === undefined);
  const fullKey = compactKey(words.join(' '));
  const plainKey = compactKey(plain.map((t) => lw(t)).join(' '));
  const fieldKey = field ? compactKey(field) : '';

  // 1. A named value of the test data. The whole phrase first ("wrong password"), then without its class word.
  const entry =
    data.find((d) => compactKey(d.key) === fullKey) ??
    (plainKey ? data.find((d) => compactKey(d.key) === plainKey) : undefined) ??
    (!plainKey && fieldKey ? data.find((d) => compactKey(d.key) === fieldKey) : undefined);
  if (entry) {
    decisions.push(`"${originalOf(line, head)}" is "${entry.key}" of the test data`);
    return { spec: { kind: 'data', key: entry.key }, entry, decisions };
  }

  if (classWord === 'BLANK') return { spec: { kind: 'blank' }, decisions };

  const fieldName = plain.length ? originalOf(line, plain) : (field ?? '');
  const credential = ENV_NAME[compactKey(fieldName)];

  // 2. A kind of value ("valid", "invalid"): only the credentials of the environment can be named without the data resolver.
  if (classWord === 'VALID') {
    if (credential) {
      decisions.push(`a valid ${compactKey(fieldName)} is the environment variable ${credential.name}`);
      return { spec: { kind: 'env', ...credential }, decisions };
    }
    return { spec: { kind: 'class', dataClass: 'VALID', field: fieldName }, decisions };
  }
  if (classWord) return { spec: { kind: 'class', dataClass: classWord, field: fieldName }, decisions };

  // 3. A noun that stands for a value ("Enter password"): the credential of the environment, or a value still to be named.
  const lastWord = words[words.length - 1] ?? '';
  if (VALUE_NOUNS.has(plainKey) || VALUE_NOUNS.has(lastWord)) {
    if (credential) {
      decisions.push(`no "${fieldName}" in the test data: the environment variable ${credential.name} is used`);
      return { spec: { kind: 'env', ...credential }, decisions };
    }
    return { spec: { kind: 'class', dataClass: 'VALID', field: fieldName }, decisions };
  }

  // 4. Anything else is written as the value itself: "Enter John in First name".
  return { spec: { kind: 'literal', value: originalOf(line, head) }, decisions };
}
