import { ruleKey } from '../parser/rules.js';
import type { ReviewReason, TestVerdict } from '../results/verdict.js';

/**
 * Grouped review (REAL-WORLD-TEST-CASES.md M8, FR-RV-09, FR-RV-10): the questions of a whole batch, grouped by the wording
 * that caused them, so "Leave the Login Name text box blank" is answered once for the four test cases that use it.
 */

export interface ReviewGroup {
  key: string;
  /** A step or an expected result. */
  kind: 'step' | 'check';
  /** The wording as the tester wrote it. */
  raw: string;
  headline: string;
  why: string;
  todo: string[];
  cases: Array<{ testId: string; id: string }>;
}

export interface AssumptionGroup {
  text: string;
  testIds: string[];
}

export interface ReviewGroups {
  questions: ReviewGroup[];
  /** Learned or assumed values that passed or were not verified, which the tester has not approved yet. */
  assumptions: AssumptionGroup[];
}

type Row = { testId: string; status: string; verdict: Partial<TestVerdict> & { review?: ReviewReason[]; assumptions?: string[] } };

/** `approved` holds the texts of assumptions the tester already accepted. */
export function reviewGroups(rows: Row[], approved: Set<string>): ReviewGroups {
  const questions = new Map<string, ReviewGroup>();
  const assumptions = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const reason of r.verdict.review ?? []) {
      if (!reason.raw.trim()) continue;
      const kind = reason.id.startsWith('A') ? 'check' : 'step';
      const key = `${kind}|${ruleKey(reason.raw)}`;
      const group = questions.get(key) ?? { key, kind, raw: reason.raw, headline: reason.headline, why: reason.why, todo: reason.todo, cases: [] };
      group.cases.push({ testId: r.testId, id: reason.id });
      questions.set(key, group);
    }
    for (const a of r.verdict.assumptions ?? []) {
      // "A2: the error message … was learned": the id is the test case's own, so groups ignore it.
      const text = a.replace(/^[SA]\d+(?:\.\d+)?:\s*/, '');
      if (approved.has(ruleKey(text))) continue;
      assumptions.set(text, (assumptions.get(text) ?? new Set()).add(r.testId));
    }
  }
  return {
    questions: [...questions.values()].sort((a, b) => b.cases.length - a.cases.length),
    assumptions: [...assumptions.entries()].map(([text, ids]) => ({ text, testIds: [...ids] })),
  };
}
