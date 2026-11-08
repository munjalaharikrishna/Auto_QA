import { cacheKeyOf } from '../engine/cache/index.js';
import { fingerprintOf } from '../engine/verdict/learn.js';
import { LABEL_MEANING, labelOf, type ReviewLabel } from '../results/labels.js';
import type { Status, TestVerdict } from '../results/verdict.js';

/**
 * The review cards of a job (VD-11, DEC-05), built from the verdicts that were stored. A case the engine could not decide is shown
 * with what was expected, what the page showed, and the pictures; a person says PASS or FAIL. Cases that share one cause are one
 * card, so a person decides once, and each case still gets a decision of its own. Since E0.19 step 2 a card is one question: the
 * sentence the engine could not decide and why (`questionOf`); a question about wording is one card whatever each page showed.
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

/** The same cause gives the same card, whatever the test case: what was unproven, and what the page showed (before E0.19). */
export const cardIdOf = (e: CardEvidence): string => fingerprintOf(`${e.status}|${e.clause || e.reason}`, e.actual);

/** Labels whose question is about the sentence itself: what the page showed does not change the answer. */
const ABOUT_THE_SENTENCE: ReadonlySet<ReviewLabel> = new Set<ReviewLabel>(['wording']);

/** A sentence as a person reads it: no case, no extra spaces, no leading "Verify (that)", no closing full stop. */
export function sameSentence(s: string): string {
  let t = s.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  for (const lead of ['verify that ', 'verify ']) if (t.startsWith(lead)) t = t.slice(lead.length);
  while (t.endsWith('.')) t = t.slice(0, -1).trimEnd();
  return t;
}

/**
 * The question a case puts to a person (E0.19 step 2): the sentence the engine could not decide (the first review reason, else the
 * unproven check), why, and its label. One question is one card, whatever the test case.
 */
export interface CaseQuestion {
  sentence: string;
  /** Where the sentence is: a step line, or an expected result (of the case or of a step). An answer is a reading of that kind. */
  kind: 'step' | 'check';
  why: string;
  label?: ReviewLabel;
  /** The answer depends on what the page showed: cases whose pages showed different things are different questions. */
  byPage: boolean;
}

export function questionOf(status: string, v: TestVerdict): CaseQuestion {
  const first = v.review?.[0];
  const unproven = v.checks.find((c) => c.result === 'not verified' || c.result === 'not run' || c.result === 'not checked');
  const label = labelOf({ ...v, status: status as Status });
  return {
    sentence: first?.raw || unproven?.raw || v.failedStep || v.expected || '',
    kind: first?.id.startsWith('step') ? 'step' : 'check',
    why: first?.why ?? v.reason,
    ...(label ? { label } : {}),
    byPage: !(label && ABOUT_THE_SENTENCE.has(label)),
  };
}

/** One card per question: the same sentence, the same reason, and (when the answer depends on it) the same page. */
export const questionIdOf = (q: CaseQuestion, e: CardEvidence): string =>
  fingerprintOf(`${q.label ?? ''}|${sameSentence(q.sentence) || e.reason}|${q.why}`, q.byPage ? e.actual : '');

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
  /**
   * The case is in the holding area (E0.19 step 7): a person owns it until a day. `overdue` when the day has passed: the hold no longer
   * keeps it out of the questions, and its owner decides.
   */
  held?: { owner: string; until: string; reason: string; overdue: boolean };
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
  /** Why it needs review, in one word, with what that means (E0.18 step 7): kept beside the evidence, not in it. */
  label?: { name: ReviewLabel; meaning: string };
  /** A decision on this card is remembered for the next run of the same checks (E0.18 step 5): the checks it covers. */
  remembers?: number;
  /**
   * The card asks what a sentence means (E0.19 step 3): a person answers once with a sentence the engine can run, and every case of the
   * project with that sentence is read by it from the next run on. `kind` is where the sentence is.
   */
  asks?: { sentence: string; kind: 'step' | 'check' };
  /** Every case of the card is held, and none is overdue (E0.19 step 7): it is shown apart and is not a question of the run. */
  held?: boolean;
  /** The answer that is kept for that sentence now, with who gave it and when. */
  meaning?: { to: string; by: string; at: string };
  /** Sentences the engine can run, from what the screens showed, for a one-click answer (E0.19 step 4); and its pattern to fill in. */
  suggestions?: import('./suggest.js').Suggestions;
}

export function buildReviewCards(rows: readonly StoredVerdict[], decisions: ReadonlyMap<string, DecisionView>): ReviewCardView[] {
  const cards = new Map<string, ReviewCardView>();
  for (const r of rows) {
    if (!DECIDABLE.has(r.status as Status)) continue;
    const evidence = evidenceOf(r.status, r.verdict);
    const question = questionOf(r.status, r.verdict);
    const id = questionIdOf(question, evidence);
    // A case is on one card of its job, so a decision made when cards were grouped another way is still its decision.
    const decision = decisions.get(`${r.testId}|${id}`) ?? decisions.get(r.testId);
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
      why: question.why,
      // The headline is the sentence the person is asked about, not the first check that happened not to run.
      clause: question.sentence,
      expected: evidence.expected,
      actual: evidence.actual,
      ...(evidence.before ? { before: evidence.before } : {}),
      ...(evidence.after ? { after: evidence.after } : {}),
      cases: [entry],
      decided: false,
      ...(question.label ? { label: { name: question.label, meaning: LABEL_MEANING[question.label] } } : {}),
      ...(!question.byPage && question.sentence ? { asks: { sentence: question.sentence, kind: question.kind } } : {}),
      ...(r.verdict.approvals?.length ? { remembers: r.verdict.approvals.length } : {}),
    });
  }
  for (const c of cards.values()) c.decided = c.cases.every((x) => x.decision !== undefined);
  return [...cards.values()].sort((a, b) => b.cases.length - a.cases.length || a.id.localeCompare(b.id));
}
