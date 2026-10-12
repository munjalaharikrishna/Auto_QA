import type { DataClass } from '../ir/schema.js';
import { compactKey } from '../text/compound.js';

/**
 * Layer 16, test data understanding (TD-01). Every value of a test case has a class: what kind of value the text asks
 * for. "Leave the Login Name blank" is BLANK, "Enter an invalid username" is INVALID, `Username: cypress` is EXPLICIT.
 * The class is kept with the value, shown in review and written in the report.
 */

export interface DataClassDef {
  cls: DataClass;
  /** One line, for the review screen. */
  meaning: string;
  /** The words and phrases that name it in a step, lower case. */
  words: readonly string[];
  /** Whether the class needs no value from anyone: it is fixed by its meaning (a blank is nothing). */
  fixed?: boolean;
}

const d = (cls: DataClass, meaning: string, words: readonly string[], fixed = false): DataClassDef => ({ cls, meaning, words, ...(fixed ? { fixed } : {}) });

export const DATA_CLASS_DEFS: readonly DataClassDef[] = [
  d('EXPLICIT', 'a value the test case gives: in the Test Data column or in quotes in the step', []),
  d('VALID', 'a value the application accepts', ['valid', 'correct', 'right', 'proper', 'good', 'legal', 'acceptable']),
  d('INVALID', 'a value the application must reject', ['invalid', 'wrong', 'incorrect', 'bad', 'illegal', 'unacceptable', 'improper', 'unintended']),
  d('EMPTY', 'an empty string, typed in on purpose', ['empty string', 'empty value', 'zero length'], true),
  d('BLANK', 'a field left without a value', ['blank', 'empty', 'nothing', 'no value', 'left blank', 'left empty'], true),
  d('MISSING', 'no value at all: the field is not given to the application', ['missing', 'omitted', 'absent', 'not provided', 'not given'], true),
  d('NULL', 'the value null', ['null', 'none'], true),
  d('BOUNDARY', 'a value at the edge of what is allowed', ['boundary', 'edge', 'limit']),
  d('MAXIMUM', 'the longest or largest value allowed', ['max', 'maximum', 'max length', 'maximum length', 'longest', 'largest', 'highest']),
  d('MINIMUM', 'the shortest or smallest value allowed', ['min', 'minimum', 'min length', 'minimum length', 'shortest', 'smallest', 'lowest']),
  d('EXISTING', 'a value that is already in the application', ['existing', 'already registered', 'already existing', 'registered', 'present']),
  d('NON_EXISTING', 'a value that is not in the application', [
    'non-existing',
    'non existing',
    'nonexistent',
    'unregistered',
    'not registered',
    'not existing',
    'unknown',
  ]),
  d('DUPLICATE', 'a value that is already in the application and must be refused as a copy', ['duplicate', 'duplicated', 'repeated']),
  d('GENERATED', 'a value the engine makes, the same way every run', ['generated', 'auto-generated', 'unique']),
  d('RANDOM', 'a value the engine picks, the same way every run for the same seed', ['random', 'arbitrary', 'any']),
  d('CREDENTIAL', 'a secret from the credential store', ['credential']),
  d('ENVIRONMENT', 'a value from an environment variable', ['environment']),
  d('REFERENCE', 'a value kept somewhere else and named here', []),
];

const BY_WORD = new Map<string, DataClass>();
for (const def of DATA_CLASS_DEFS) for (const w of def.words) if (!BY_WORD.has(w)) BY_WORD.set(w, def.cls);

export const dataClassDef = (cls: DataClass): DataClassDef => DATA_CLASS_DEFS.find((x) => x.cls === cls) as DataClassDef;

export interface ClassWords {
  cls: DataClass;
  /** The positions of the words that named it, so the caller can take them off the phrase. */
  at: number[];
}

/** The class a phrase names, and which of its words did: "max length username" is MAXIMUM, words 0 and 1. */
export function classOfWords(words: readonly string[]): ClassWords | undefined {
  for (let i = 0; i < words.length; i++) {
    for (let len = Math.min(2, words.length - i); len >= 1; len--) {
      const cls = BY_WORD.get(words.slice(i, i + len).join(' '));
      if (cls) return { cls, at: Array.from({ length: len }, (_, k) => i + k) };
    }
  }
  return undefined;
}

/** What a field is for, judged from its name. The generator makes a different value for each kind. */
export type FieldKind = 'username' | 'password' | 'email' | 'personName' | 'number' | 'code' | 'phone' | 'date' | 'file' | 'text';

const HAS = (key: string, ...parts: string[]): boolean => parts.some((p) => key.includes(p));

export function fieldKindOf(name: string): FieldKind {
  const key = compactKey(name);
  if (HAS(key, 'password', 'passcode', 'pin')) return 'password';
  if (HAS(key, 'email')) return 'email';
  if (HAS(key, 'username', 'loginname', 'userid', 'login')) return 'username';
  if (HAS(key, 'phone', 'mobile', 'tel')) return 'phone';
  if (HAS(key, 'date', 'dob', 'birth')) return 'date';
  if (HAS(key, 'photo', 'file', 'upload', 'attachment', 'document', 'image')) return 'file';
  if (HAS(key, 'firstname', 'lastname', 'middlename', 'nickname', 'fullname', 'surname', 'name')) return 'personName';
  if (HAS(key, 'code', 'id', 'number', 'quantity', 'qty', 'age', 'amount', 'zip', 'postal'))
    return key.includes('code') || key.endsWith('id') ? 'code' : 'number';
  return 'text';
}

/** Kinds of value that only the application's own users, a secret store or a real file can give: a generated one would be wrong. */
export const NEEDS_REAL_VALUE: ReadonlySet<FieldKind> = new Set(['username', 'password', 'file']);
