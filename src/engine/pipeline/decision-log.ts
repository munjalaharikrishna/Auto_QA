/**
 * The decision log (GV-03): every stage writes what it did and why, in the order it happened. It holds no times
 * and no random values, so the same test case and configuration give a byte-identical log (GV-05).
 */

export type DecisionKind = 'info' | 'decision' | 'assumption' | 'warning' | 'error';

export interface DecisionEntry {
  seq: number;
  stage: string;
  testId: string;
  kind: DecisionKind;
  message: string;
  /** Plain data only (strings, numbers, lists). Never a secret value. */
  data?: Record<string, unknown>;
}

export class DecisionLog {
  private readonly list: DecisionEntry[] = [];

  constructor(private readonly testId: string) {}

  add(stage: string, kind: DecisionKind, message: string, data?: Record<string, unknown>): void {
    this.list.push({ seq: this.list.length + 1, stage, testId: this.testId, kind, message, ...(data ? { data } : {}) });
  }

  get entries(): readonly DecisionEntry[] {
    return this.list;
  }

  /** The stages that wrote at least one entry, in the order they first did. */
  get stages(): string[] {
    return [...new Set(this.list.map((e) => e.stage))];
  }

  toJSON(): DecisionEntry[] {
    return [...this.list];
  }
}
