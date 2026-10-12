import { inspect } from 'node:util';

/**
 * Layer 19, data safety (DS-02, DS-03). A secret is held in a `Secret`, which cannot be written by accident: turned into
 * text, JSON or an inspected object it is always `***`. The value is read only by `reveal()`, at the one place that
 * types it into the application. Text that may hold a secret is masked, and every output of a run can be scanned for
 * the values that must not be in it.
 */

export const MASK = '••••';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The value. Call it only where it is typed into the application. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '***';
  }

  toString(): string {
    return '***';
  }

  [inspect.custom](): string {
    return 'Secret(***)';
  }
}

export const isSecret = (x: unknown): x is Secret => x instanceof Secret;

/** Replaces every occurrence of a secret value in a text with `••••`. Longer secrets first, so one inside another is not left half showing. */
export function maskSecrets(text: string, secrets: Iterable<string>, mask = MASK): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.length > 0).sort((a, b) => b.length - a.length)) out = out.split(s).join(mask);
  return out;
}

export interface SecretFinding {
  /** Which output it was found in. */
  where: string;
  /** Which secret, by its position in the list: the value itself is never repeated. */
  secret: number;
}

/**
 * DS-03: scans stored outputs for secret values and returns where each was found. Nothing in the result repeats a
 * secret. A secret of fewer than three characters cannot be searched for without false alarms and is reported as skipped.
 */
export function scanForSecrets(outputs: Record<string, string>, secrets: readonly string[]): { findings: SecretFinding[]; skipped: number[] } {
  const findings: SecretFinding[] = [];
  const skipped: number[] = [];
  secrets.forEach((s, index) => {
    if (s.length < 3) {
      skipped.push(index);
      return;
    }
    for (const [where, text] of Object.entries(outputs)) if (text.includes(s)) findings.push({ where, secret: index });
  });
  return { findings, skipped };
}
