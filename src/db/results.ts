/**
 * What is queryable about a result (DATABASE.md §5.7). The whole verdict is kept as JSON because it is read whole;
 * these are the parts that are filtered, joined and counted. A verdict that is not a test verdict (an unreadable
 * sheet row has only a problem text) simply has none of them.
 */

export interface ResultColumns {
  automationId: string | null;
  category: string | null;
  failedStep: string | null;
  reason: string | null;
  expected: string | null;
  actual: string | null;
  durationMs: number | null;
  startedAt: string | null;
  executionId: string | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function resultColumns(verdict: unknown): ResultColumns {
  const v = (verdict && typeof verdict === 'object' ? verdict : {}) as Record<string, unknown>;
  return {
    automationId: text(v.automationId),
    category: text(v.category),
    failedStep: text(v.failedStep),
    reason: text(v.reason) ?? text(v.problem),
    expected: text(v.expected),
    actual: text(v.actual),
    durationMs: typeof v.durationMs === 'number' ? Math.round(v.durationMs) : null,
    startedAt: text(v.startedAt),
    executionId: text(v.executionId),
  };
}

/** The internal id of an execution: unique across projects, though `EXEC-…` numbers of older runs are only unique within one. */
export const runId = (projectId: string, execId: string) => `RUN-${projectId}-${execId}`;

export const EXEC_ID = /^EXEC-(\d{4})-(\d+)$/;

export const execIdOf = (year: number | string, n: number) => `EXEC-${year}-${String(n).padStart(5, '0')}`;
