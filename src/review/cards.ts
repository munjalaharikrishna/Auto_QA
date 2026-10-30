import { cacheKeyOf } from '../engine/cache/index.js';
import { fingerprintOf } from '../engine/verdict/learn.js';
import type { Status, TestVerdict } from '../results/verdict.js';

/**
 * The review cards of a job (VD-11, DEC-05), built from the verdicts that were stored. A case the engine could not decide is shown
 * with what was expected, what the page showed, and the pictures; a person says PASS or FAIL. Cases that share one cause are one
 * card, so a person decides once, and each case still gets a decision of its own.
 *
 * Only a case that is waiting for a person can be decided, and a PASS needs something to confirm: a run whose steps did not all
 * finish, or one with a check that failed, has nothing to confirm and cannot be passed by a click.
 */

/** The statuses a person may decide. A FAIL, a BLOCKED case and a PASS are the engine's own and are not overruled. */
export const DECIDABLE: ReadonlySet<Status> = new Set<Status>(['NEEDS REVIEW', 'NOT VERIFIED']);

export interface StoredVerdict {
  testId: string;
  row?: number;
  status: string;
  verdict: TestVerdict;
}

export interface Eligibility {
  /** A person may decide this case at all. */
  decidable: boolean;
  /** A person may say PASS. */
  canPass: boolean;
  /** Why not, in words. */
  refusal?: string;
  passRefusal?: string;
}

export function eligibility(status: string, v: TestVerdict): Eligibility {
  if (!DECIDABLE.has(status as Status)) {
    return {
      decidable: false,
      canPass: false,
      refusal: `A case that is ${status} is the engine's own verdict: only a case that needs review or could not be verified is decided by a person.`,
    };
  }
  const notDone = v.steps.filter((s) => s.result !== 'passed');
  const failed = v.checks.filter((c) => c.result === 'failed');
  const evidence = v.evidence.screenshots.length > 0 || v.checks.some((c) => c.actual.trim() !== '');
  const passRefusal = notDone.length
    ? `${notDone.length === 1 ? 'A step' : `${notDone.length} steps`} did not finish (${notDone.map((s) => s.id).join(', ')}), so there is nothing to confirm as a PASS.`
    : failed.length
      ? `${failed.length === 1 ? 'A check' : `${failed.length} checks`} failed (${failed.map((c) => c.id).join(', ')}): the page showed something else.`
      : !evidence
        ? 'The run left no picture and no actual result to look at.'
        : undefined;
  return { decidable: true, canPass: passRefusal === undefined, ...(passRefusal ? { passRefusal } : {}) };
}

/** What a person is shown, and what a decision is based on. Kept with the decision. */
export interface CardEvidence {
  status: string;
  reason: string;
  clause: string;
  expected: string;
  actual: string;
  checks: Array<{ id: string; raw: string; expected: string; actual: string; result: string }>;
  before?: string;
  after?: string;
  failedStep?: string;
}

export function evidenceOf(status: string, v: TestVerdict): CardEvidence {
  const unproven = v.checks.find((c) => c.result === 'not verified' || c.result === 'not run' || c.result === 'not checked');
  const shots = v.evidence.screenshots;
  return {
    status,
    reason: v.reason,
    clause: unproven?.raw ?? '',
    expected: unproven?.expected ?? v.expected,
    actual: unproven?.actual || v.actual,
    checks: v.checks.map((c) => ({ id: c.id, raw: c.raw, expected: c.expected, actual: c.actual, result: c.result })),
    // The last two pictures are the page before and after the last step: where the check was judged.
    ...(shots.length >= 2 ? { before: shots[shots.length - 2] } : {}),
    ...(shots.length >= 1 ? { after: shots[shots.length - 1] } : {}),
    ...(v.failedStep ? { failedStep: v.failedStep } : {}),
  };
}

/** The same cause gives the same card, whatever the test case: what was unproven, and what the page showed. */
export const cardIdOf = (e: CardEvidence): string => fingerprintOf(`${e.status}|${e.clause || e.reason}`, e.actual);

/** The hash of what a person was shown: a later change to the stored evidence is visible against it. */
export const evidenceHash = (e: CardEvidence): string => cacheKeyOf(e);

export interface DecisionView {
  id: string;
  decision: 'PASS' | 'FAIL';
  reviewer: string;
  note: string;
  decidedAt: string;
  engineStatus: string;
  supersedes?: string;
}

export interface CardCase {
  testId: string;
  row?: number;
  status: string;
  eligibility: Eligibility;
  evidence: CardEvidence;
  decision?: DecisionView;
  /**
   * The test case was changed after this run (E0.14b): a walkthrough or an edit saved a newer version. The result on the card is the
   * earlier version's, and is not changed; running the case again gives the new one's.
   */
  changedSince?: { version: number; reason: string; at: string };
}

export interface ReviewCardView {
  id: string;
  /** In words: why the engine could not decide. */
  why: string;
  clause: string;
  expected: string;
  actual: string;
  /** The pictures of the first case: every case has its own in `cases`. */
  before?: string;
  after?: string;
  cases: CardCase[];
  /** Every case has a current decision. */
  decided: boolean;
}

export function buildReviewCards(rows: readonly StoredVerdict[], decisions: ReadonlyMap<string, DecisionView>): ReviewCardView[] {
  const cards = new Map<string, ReviewCardView>();
  for (const r of rows) {
    if (!DECIDABLE.has(r.status as Status)) continue;
    const evidence = evidenceOf(r.status, r.verdict);
    const id = cardIdOf(evidence);
    const decision = decisions.get(`${r.testId}|${id}`);
    const entry: CardCase = {
      testId: r.testId,
      ...(r.row !== undefined ? { row: r.row } : {}),
      status: r.status,
      eligibility: eligibility(r.status, r.verdict),
      evidence,
      ...(decision ? { decision } : {}),
    };
    const card = cards.get(id);
    if (card) {
      card.cases.push(entry);
      continue;
    }
    cards.set(id, {
      id,
      why: r.verdict.review?.[0]?.why ?? r.verdict.reason,
      clause: evidence.clause,
      expected: evidence.expected,
      actual: evidence.actual,
      ...(evidence.before ? { before: evidence.before } : {}),
      ...(evidence.after ? { after: evidence.after } : {}),
      cases: [entry],
      decided: false,
    });
  }
  for (const c of cards.values()) c.decided = c.cases.every((x) => x.decision !== undefined);
  return [...cards.values()].sort((a, b) => b.cases.length - a.cases.length || a.id.localeCompare(b.id));
}
