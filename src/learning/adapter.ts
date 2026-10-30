import { type ParserRules, ruleKey } from '../parser/rules.js';
import type { ApprovalPayload, EntryKind, EntryStatus, LabelPayload, LearnedEntry, ReadingPayload } from './entries.js';
import { labelProblem, readingProblem, validateApproval } from './validate.js';

/**
 * What a run reads from the learned entries: the one adapter between the store and the code that executes (the legacy parser and
 * explorer, and the new engine's vocabulary). Only `active` entries are asked for, and each is checked again here, so an entry that
 * was changed by hand in the database, or whose status says more than its content supports, does not reach a run. There is no
 * other way a tester's earlier answer reaches execution.
 */

export interface EntryReader {
  learnedEntries(projectId: string, filter?: { kind?: EntryKind; status?: EntryStatus }): Promise<LearnedEntry[]>;
}

export interface LearnedForRun {
  /** For the parser and the explorer: how sentences are read and which name on the screen a word means. */
  rules: ParserRules;
  /** `ruleKey` of each assumption a person accepted, for the verdict (DEC-05). An acceptance, never evidence. */
  approvedAssumptions: Set<string>;
  /** The words testers use for elements, for the application's vocabulary (D1). */
  labels: Array<{ word: string; means: string }>;
  /**
   * Words a person gave for an element on one screen, in a walkthrough (E0.14b): they hold on that screen only, so they are not in
   * `rules` or `labels`, which hold everywhere.
   */
  screenLabels: Array<{ word: string; means: string; screen: string; element?: string }>;
  /** Active entries that did not pass their check at read time, and why. They are not used. */
  rejected: Array<{ id: string; kind: EntryKind; why: string }>;
}

export async function learnedForRun(reader: EntryReader, projectId: string): Promise<LearnedForRun> {
  const active = await reader.learnedEntries(projectId, { status: 'active' });
  const out: LearnedForRun = { rules: { step: {}, check: {}, element: {} }, approvedAssumptions: new Set(), labels: [], screenLabels: [], rejected: [] };
  const reject = (e: LearnedEntry, why: string): void => void out.rejected.push({ id: e.id, kind: e.kind, why });
  const readings: Array<{ from: string; to: string }> = [];

  for (const e of active.filter((x) => x.kind === 'reading')) {
    const p = e.payload as unknown as ReadingPayload;
    const problem = readingProblem(p);
    if (problem) {
      reject(e, problem);
      continue;
    }
    out.rules[p.readingKind][ruleKey(p.from)] = p.to;
    readings.push({ from: p.from, to: p.to });
  }
  for (const e of active.filter((x) => x.kind === 'label')) {
    const p = e.payload as unknown as LabelPayload;
    const problem = labelProblem(p);
    if (problem) {
      reject(e, problem);
      continue;
    }
    if (p.screen) {
      out.screenLabels.push({ word: ruleKey(p.label), means: p.means, screen: p.screen, ...(p.element ? { element: p.element } : {}) });
      continue;
    }
    out.rules.element[ruleKey(p.label)] = p.means;
    out.labels.push({ word: ruleKey(p.label), means: p.means });
  }
  for (const e of active.filter((x) => x.kind === 'approval')) {
    const p = e.payload as unknown as ApprovalPayload;
    const outcome = validateApproval(p, readings);
    if (outcome.status !== 'active') {
      reject(e, outcome.validation.problem ?? 'it did not pass its check');
      continue;
    }
    out.approvedAssumptions.add(ruleKey(p.assumption));
  }
  return out;
}
