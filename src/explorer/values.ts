import type { ValueRef } from '../model/test-model.js';

/**
 * Turns a step's value reference into the text to type (FR-PA-10, FR-TD-04).
 * Values from the environment are treated as secret: they are masked wherever they could be shown (FR-EV-03).
 */

export interface ValueContext {
  env: Record<string, string | undefined>;
  data: Record<string, string>;
  /** Fixed "now" so one exploration generates consistent values. */
  now: Date;
}

export type Resolved = { ok: true; value: string; secret: boolean } | { ok: false; error: string };

export function resolveValue(ref: ValueRef, ctx: ValueContext): Resolved {
  switch (ref.kind) {
    case 'literal':
      return { ok: true, value: ref.value, secret: false };
    case 'data': {
      const value = ctx.data[ref.key];
      return value === undefined ? { ok: false, error: `Test Data has no "${ref.key}".` } : { ok: true, value, secret: false };
    }
    case 'env': {
      const value = ctx.env[ref.name];
      return value === undefined || value === ''
        ? { ok: false, error: `Set ${ref.name} in the environment (or in the .env file).` }
        : { ok: true, value, secret: true };
    }
    case 'generator': {
      const value = generate(ref.name, ctx.now);
      return value === undefined
        ? { ok: false, error: `Unknown generator {{${ref.name}}}. Known: ${GENERATORS.join(', ')}.` }
        : { ok: true, value, secret: false };
    }
  }
}

export const GENERATORS = ['unique.email', 'unique.number', 'unique.text', 'invalid.text', 'today'];

function generate(name: string, now: Date): string | undefined {
  const stamp = now.getTime().toString(36);
  switch (name) {
    case 'unique.email':
      return `auto-qa.${stamp}@example.com`;
    case 'unique.number':
      return String(now.getTime() % 1_000_000_000);
    case 'unique.text':
      return `auto-qa-${stamp}`;
    case 'invalid.text':
      return `invalid-${stamp}`;
    case 'today':
      return now.toISOString().slice(0, 10);
    default:
      return undefined;
  }
}

/** Replaces each secret with •••• (longest first, so one secret inside another is fully hidden). */
export function masker(secrets: Iterable<string>): (text: string) => string {
  const list = [...new Set(secrets)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  return (text) => list.reduce((t, s) => t.split(s).join('••••'), text);
}
