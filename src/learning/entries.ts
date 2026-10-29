/**
 * What the engine has learned from people (GV-01), as the entries kept in `learned_entries` (migration 0008). This is the only
 * source a run reads a tester's earlier answer from. An entry changes a run only while it is `active`: it passed its checks, and
 * nobody switched it off.
 */

export const ENTRY_KINDS = ['label', 'reading', 'approval', 'pick', 'decision'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * - `active`       passed every check; the only status that changes a run
 * - `pending`      passed the format checks but could not be shown true (a label for a name the application was never seen to show); waits for a person
 * - `quarantined`  failed a check; kept with the reason, never used, and a person cannot switch it on without it passing again
 * - `disabled`     switched off by a person; kept, never used
 * - `removed`      taken out of the list by a person; the row and its history stay, and it is never used
 */
export const ENTRY_STATUSES = ['active', 'pending', 'quarantined', 'disabled', 'removed'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** "Employee ID" means the field the application shows as "Code". */
export interface LabelPayload {
  label: string;
  means: string;
  page?: string;
}

/** A sentence that is read as another sentence: a step or an expected result (the old project rules of kind step and check). */
export interface ReadingPayload {
  readingKind: 'step' | 'check';
  from: string;
  to: string;
  /** A test case and sentence it was made for, so a person can see what it was about. */
  example?: string;
}

/**
 * A person accepted an assumption the platform made. It is an acceptance of that assumption and nothing more: it does not say a
 * test passed, and it never replaces the evidence of a run (see `results/verdict.ts`).
 */
export interface ApprovalPayload {
  /** The assumption as the verdict states it. */
  assumption: string;
  /** The step or expected-result sentence the assumption was made for, when the text says. */
  sentence?: string;
  /** When the assumption is "the sentence is read as X (a project rule)": the reading it accepts. The approval is void when that reading is not active. */
  dependsOnReading?: { from: string; to: string };
}

export interface ValidationRecord {
  ok: boolean;
  /** The checks that were made and what each found, in words. */
  checks: string[];
  /** Why it is not `active`, when it is not. */
  problem?: string;
  validator: string;
}

export interface LearnedEntry<P = Record<string, unknown>> {
  id: string;
  projectId: string;
  kind: EntryKind;
  status: EntryStatus;
  /** What makes two entries the same thing; a new answer for the same key replaces the old one (with history). */
  key: string;
  payload: P;
  source: string;
  author: string;
  /** The project rule this entry was made from, when it was migrated. */
  legacyRuleId?: string;
  validation: ValidationRecord;
  validatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type NewEntry<P = Record<string, unknown>> = Pick<LearnedEntry<P>, 'kind' | 'status' | 'key' | 'payload' | 'source' | 'author' | 'validation'> & {
  legacyRuleId?: string;
};

export interface EntryHistory {
  id: number;
  entryId: string;
  at: string;
  action: string;
  actor: string;
  statusBefore?: EntryStatus;
  statusAfter?: EntryStatus;
  detail: unknown;
}

/** Only an active entry changes a run. */
export const isActive = (e: Pick<LearnedEntry, 'status'>): boolean => e.status === 'active';
