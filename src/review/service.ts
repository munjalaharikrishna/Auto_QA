import type { Store } from '../db/store.js';
import type { TestVerdict } from '../results/verdict.js';
import { buildReviewCards, type CardCase, type DecisionView, evidenceHash, type ReviewCardView, type StoredVerdict } from './cards.js';

/**
 * A person's PASS or FAIL on the cases of a review card (VD-11, DEC-05). Every rule is here, so the endpoint and the tests meet the
 * same ones:
 *  - the cases of a card are read from the stored verdicts, never from the request: a click cannot name a case that is not on the card;
 *  - only a case waiting for a person is decided, and a PASS needs a finished run with something to look at;
 *  - the time is the server's, and the reviewer is a name that is checked;
 *  - the same decision twice is one decision; a different one replaces it with a reason, and the first stays as history;
 *  - the result the decision is about is never changed: the engine's verdict and its evidence stay as they were.
 */

export class ReviewRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export type CaseOutcome = {
  testId: string;
  outcome: 'recorded' | 'duplicate' | 'replaced' | 'refused';
  id?: string;
  reason?: string;
};

const MAX_REVIEWER = 80;
const MAX_NOTE = 1000;

function checkedName(given: unknown, fallback: string): string {
  if (given === undefined || given === null || given === '') return fallback;
  if (typeof given !== 'string') throw new ReviewRefused('The reviewer must be a name.');
  const name = given.trim();
  if (!name) throw new ReviewRefused('The reviewer name is empty.');
  if (name.length > MAX_REVIEWER) throw new ReviewRefused(`The reviewer name is longer than ${MAX_REVIEWER} characters.`);
  for (const c of name) if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) throw new ReviewRefused('The reviewer name holds a control character.');
  return name;
}

function checkedNote(given: unknown): string {
  if (given === undefined || given === null) return '';
  if (typeof given !== 'string') throw new ReviewRefused('The note must be text.');
  const note = given.trim();
  if (note.length > MAX_NOTE) throw new ReviewRefused(`The note is longer than ${MAX_NOTE} characters.`);
  return note;
}

/** A control the engine chose among alike ones, as the verdict keeps it (E0.17 item 3). */
export type Pick = NonNullable<TestVerdict['picks']>[number];

export interface ReviewOptions {
  /**
   * Keeps a choice a person approved by passing the case: the word means that element on that screen from now on (E0.17 item 3). A
   * choice that cannot be kept does not undo the decision; the decision is the person's, the memory only saves asking again.
   */
  remember?: (projectId: string, pick: Pick, source: string, who: string) => Promise<unknown>;
  /**
   * Takes back what a PASS on this case taught (E0.18 step 5): when the decision is changed to FAIL, the elements that PASS kept for
   * their screens are switched off. `source` is the start of the source those entries were saved with.
   */
  forget?: (projectId: string, source: string, who: string) => Promise<unknown>;
}

export class ReviewService {
  constructor(
    private readonly store: Store,
    private readonly options: ReviewOptions = {},
  ) {}

  private async rows(jobId: string): Promise<StoredVerdict[]> {
    return (await this.store.verdicts(jobId)).map((r) => ({
      testId: r.testId,
      ...(r.row !== undefined ? { row: r.row } : {}),
      status: r.status,
      verdict: r.verdict as TestVerdict,
    }));
  }

  /** The cards of a job, with the decision each case has now. */
  async cards(jobId: string): Promise<ReviewCardView[]> {
    const job = await this.store.job(jobId);
    if (!job) throw new ReviewRefused('There is no such job.', 404);
    const current = new Map<string, DecisionView>();
    for (const d of await this.store.reviewDecisions(jobId)) current.set(`${d.testId}|${d.cardId}`, d);
    const cards = buildReviewCards(await this.rows(jobId), current);
    // A case changed after the run finished says so on its card (E0.14b); the run's own result stays as it was.
    if (job.finishedAt) {
      const changed = new Map<string, CardCase['changedSince']>();
      for (const id of new Set(cards.flatMap((c) => c.cases.map((x) => x.testId)))) {
        const record = await this.store.testCase(job.projectId, id);
        if (!record || record.updatedAt <= job.finishedAt) continue;
        const newer = (await this.store.testCaseVersions(record.id)).find((v) => v.createdAt > (job.finishedAt as string));
        if (newer) changed.set(id, { version: record.version, reason: newer.reason, at: newer.createdAt });
      }
      for (const card of cards) for (const c of card.cases) if (changed.get(c.testId)) c.changedSince = changed.get(c.testId);
    }
    return cards;
  }

  /** Everything that was decided, the replaced decisions too, oldest first. */
  async history(jobId: string) {
    if (!(await this.store.job(jobId))) throw new ReviewRefused('There is no such job.', 404);
    return this.store.reviewDecisions(jobId, { history: true });
  }

  async decide(
    jobId: string,
    cardId: string,
    input: { decision: unknown; who?: unknown; note?: unknown },
  ): Promise<{ cardId: string; results: CaseOutcome[] }> {
    if (input.decision !== 'PASS' && input.decision !== 'FAIL') throw new ReviewRefused('The decision is PASS or FAIL.');
    const decision = input.decision;
    const reviewer = checkedName(input.who, await this.store.currentUserName());
    const note = checkedNote(input.note);
    const job = await this.store.job(jobId);
    if (!job) throw new ReviewRefused('There is no such job.', 404);
    const card = (await this.cards(jobId)).find((c) => c.id === cardId);
    if (!card) throw new ReviewRefused('There is no such card on this job: it may have been decided against other results.', 404);

    const results: CaseOutcome[] = [];
    for (const c of card.cases) results.push(await this.decideCase(job.projectId, jobId, card, c, decision, reviewer, note));
    return { cardId, results };
  }

  private async decideCase(
    projectId: string,
    jobId: string,
    card: ReviewCardView,
    c: CardCase,
    decision: 'PASS' | 'FAIL',
    reviewer: string,
    note: string,
  ): Promise<CaseOutcome> {
    const refused = (reason: string): CaseOutcome => ({ testId: c.testId, outcome: 'refused', reason });
    if (!c.eligibility.decidable) return refused(c.eligibility.refusal ?? 'This case is not decided by a person.');
    if (decision === 'PASS' && !c.eligibility.canPass) return refused(c.eligibility.passRefusal ?? 'There is nothing to confirm as a PASS.');
    const result = await this.store.resultOf(jobId, c.testId);
    if (!result) return refused('The result is no longer there.');
    const saved = await this.store.recordReviewDecision({
      projectId,
      jobId,
      testResultId: result.id,
      ...(result.executionId ? { executionId: result.executionId } : {}),
      extId: c.testId,
      cardId: card.id,
      decision,
      engineStatus: c.status,
      engineReason: c.evidence.reason,
      reviewer,
      note,
      evidence: c.evidence,
      evidenceSha256: evidenceHash(c.evidence),
    });
    if (saved.outcome === 'refused') return refused(saved.reason);
    // A FAIL that replaces a PASS takes back what the PASS kept (E0.18 step 5); the FAIL itself is the decision the next run reads.
    if (decision === 'FAIL' && saved.outcome === 'replaced' && this.options.forget)
      await this.options.forget(projectId, `review of ${c.testId} in ${jobId} (`, reviewer).catch(() => undefined);
    // A PASS approves what the engine chose among alike controls in this run: it is remembered for that screen (E0.17 item 3).
    if (decision === 'PASS' && this.options.remember)
      for (const pick of (result.verdict as TestVerdict | undefined)?.picks ?? [])
        await this.options.remember(projectId, pick, `review of ${c.testId} in ${jobId} (${pick.step})`, reviewer).catch(() => undefined);
    return { testId: c.testId, outcome: saved.outcome, id: saved.id };
  }
}
