import { PatternSet } from './engine.js';

/**
 * DS-01: production identifiers (a real customer number, an account id) are taken out of logs and reports. They are
 * described by patterns the project configures, so they are written here, in the pattern layer, like every regular
 * expression (RX-01): each is checked when it is loaded (RX-22) and run under the time limit (RX-21).
 */

export interface ProductionPattern {
  name: string;
  /** The regular expression source, e.g. `CUST-\d{6}`. */
  source: string;
  flags?: string;
}

export const REDACTED = '[redacted]';

export function redactProduction(text: string, patterns: readonly ProductionPattern[], replacement = REDACTED): { text: string; redacted: number } {
  if (!patterns.length) return { text, redacted: 0 };
  const set = new PatternSet(
    patterns.map((p) => ({
      name: p.name,
      req: 'DS-01',
      version: '1.0.0',
      priority: 1,
      source: p.source,
      flags: p.flags ?? '',
      examples: { match: [], noMatch: [] },
    })),
  );
  const found = set.scan(text, undefined, { resolve: true }).matches.filter((m) => m.end > m.start);
  let out = text;
  for (const m of [...found].sort((a, b) => b.start - a.start)) out = `${out.slice(0, m.start)}${replacement}${out.slice(m.end)}`;
  return { text: out, redacted: found.length };
}
