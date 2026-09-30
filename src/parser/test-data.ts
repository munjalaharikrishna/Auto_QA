import type { ValueRef } from '../model/test-model.js';
import { normKey, synonymsOf, type ParserConfig } from './config.js';
import { phraseRegex, splitList, unquote } from './text.js';

/**
 * Test Data column (FR-TD-01, FR-TD-02).
 *
 *   "Email=a@b.com; Name=Asha"   → data { Email: "a@b.com", Name: "Asha" }
 *   "Password=secret_sauce"      → not stored; bound to env TEST_PASSWORD
 *   "Email={{unique.email}}"     → generator unique.email
 */

export interface DataBinding {
  key: string;
  ref: ValueRef;
}

export interface ParsedTestData {
  /** Non-secret values only. */
  data: Record<string, string>;
  /** Every key, by normalised name, with where its value comes from. */
  bindings: Map<string, DataBinding>;
  /** Secret values found, so the caller can mask them in the raw text it keeps. */
  secrets: string[];
  warnings: Array<{ code: string; text: string }>;
}

export function parseTestData(cell: string, config: ParserConfig): ParsedTestData {
  const data: Record<string, string> = {};
  const bindings = new Map<string, DataBinding>();
  const warnings: ParsedTestData['warnings'] = [];
  const secrets: string[] = [];

  for (const item of splitList(cell, { semicolons: true })) {
    const sep = item.includes('=') ? '=' : item.includes(':') ? ':' : undefined;
    const at = sep ? item.indexOf(sep) : -1;
    const key = at > 0 ? item.slice(0, at).trim() : '';
    if (!key) {
      warnings.push({ code: 'DATA_UNPARSED', text: `"${item}" is not Key=value, so it was ignored` });
      continue;
    }
    const value = unquote(item.slice(at + 1));
    const norm = normKey(key);
    if (bindings.has(norm)) {
      warnings.push({ code: 'DATA_DUPLICATE', text: `"${key}" appears more than once; the last value is used` });
      delete data[bindings.get(norm)!.key];
    }

    let ref = parseValue(value);
    if (ref.kind === 'literal' && isSecret(key, config)) {
      ref = { kind: 'env', name: envNameFor(key) };
      if (value) secrets.push(value);
      warnings.push({
        code: 'SECRET_TO_ENV',
        text: `"${key}" looks secret, so its value is not stored. Set ${ref.name} in the environment instead.`,
      });
    } else if (ref.kind === 'literal') {
      data[key] = value;
      ref = { kind: 'data', key };
    }
    bindings.set(norm, { key, ref });
  }
  return { data, bindings, secrets, warnings };
}

/** `{{unique.email}}` → generator, `{{data.Email}}` → data, `{{env.X}}` → env, anything else → literal. */
export function parseValue(text: string): ValueRef {
  const m = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(text.trim());
  if (!m) return { kind: 'literal', value: text };
  const [scope, ...rest] = m[1].split('.');
  if (scope === 'data' && rest.length) return { kind: 'data', key: rest.join('.') };
  if (scope === 'env' && rest.length) return { kind: 'env', name: rest.join('.') };
  return { kind: 'generator', name: m[1] };
}

/** A key or field name that holds a password, token, PIN… (FR-TD-02). */
export function isSecret(name: string, config: ParserConfig): boolean {
  return config.lexicon.secretWords.some((w) => {
    const k = normKey(w);
    // Long words may be glued to others ("userpassword"); short ones must stand alone ("pin", not "shipping").
    return k.length > 4 ? normKey(name).includes(k) : phraseRegex(w).test(name.replace(/[_-]/g, ' '));
  });
}

/** "Wrong Password" → TEST_WRONG_PASSWORD */
export function envNameFor(name: string): string {
  const snake = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `TEST_${snake}`;
}

/**
 * Finds the Test Data key for a field. Exact names win over synonyms.
 * With a negative qualifier ("invalid password") only keys that say so ("Invalid Password",
 * "Wrong Password") match, never the plain "Password" that holds the valid value.
 */
export function lookupData(
  bindings: Map<string, DataBinding>,
  names: string[],
  config: ParserConfig,
  qualifier?: { kind: 'positive' | 'negative'; word: string },
  options: { synonyms?: boolean } = {},
): DataBinding | undefined {
  const words = qualifier ? config.lexicon.fillQualifiers[qualifier.kind].map(normKey) : [];
  const prefixes = qualifier?.kind === 'negative' ? words : [...words, ''];
  const keys = (list: (n: string) => string[]) =>
    prefixes.flatMap((p) => names.flatMap((n) => list(n).map((k) => p + k)));

  const candidates = [...keys((n) => [normKey(n)]), ...(options.synonyms === false ? [] : keys((n) => synonymsOf(config, n)))];
  for (const key of candidates) {
    const hit = bindings.get(key);
    if (hit) return hit;
  }
  return undefined;
}
