import type { Store } from '../db/store.js';
import type { Screen } from '../engine/knowledge/screens.js';
import { ruleKey, withReadings } from '../parser/rules.js';
import type { TestVerdict } from '../results/verdict.js';
import { buildReviewCards, type CardCase, type DecisionView, evidenceHash, type ReviewCardView, type StoredVerdict } from './cards.js';
import { isOverdue } from './holds.js';
import { suggestionsFor } from './suggest.js';

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
  /** The screens each test case of a project reached, by test case id (E0.14a): what the one-click rewrites are built from (E0.19 step 4). */
  screens?: (projectId: string) => Promise<ReadonlyMap<string, readonly Screen[]>>;
  /** Keeps a person's answer to what a sentence means as a project reading (E0.19 step 3); throws with the reason when it is refused. */
  read?: (
    projectId: string,
    reading: { readingKind: 'step' | 'check'; from: string; to: string; example?: string },
    source: string,
    who: string,
  ) => Promise<{ id: string }>;
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
    for (const d of await this.store.reviewDecisions(jobId)) {
      current.set(`${d.testId}|${d.cardId}`, d);
      // Oldest first, so the latest decision on a case is the one kept for it.
      current.set(d.testId, d);
    }
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
    // Held cases say so, with their owner and day; a card all of whose cases are held is shown apart, last (E0.19 step 7).
    const holds = await this.store.heldCases(job.projectId);
    if (holds.length) {
      const byCase = new Map(holds.map((h) => [h.testId, h]));
      for (const card of cards) {
        for (const c of card.cases) {
          const h = byCase.get(c.testId);
          if (h) c.held = { owner: h.owner, until: h.until, reason: h.reason, overdue: isOverdue(h) };
        }
        if (card.cases.every((c) => c.held && !c.held.overdue)) card.held = true;
      }
      cards.sort((a, b) => Number(!!a.held) - Number(!!b.held));
    }
    // A card that asks what a sentence means shows the answer kept for it now (E0.19 step 3).
    if (cards.some((c) => c.asks)) {
      const kept = new Map<string, { to: string; by: string; at: string }>();
      for (const e of await this.store.learnedEntries(job.projectId, { kind: 'reading', status: 'active' })) {
        const p = e.payload as { from?: string; to?: string };
        if (p.from && p.to) kept.set(ruleKey(p.from), { to: p.to, by: e.author, at: e.updatedAt });
      }
      for (const card of cards) {
        const m = card.asks ? kept.get(ruleKey(card.asks.sentence)) : undefined;
        if (m) card.meaning = m;
      }
      // A question nobody answered yet offers sentences that run, built from what the screens showed (E0.19 step 4).
      const open = cards.filter((c) => c.asks && !c.meaning);
      if (open.length) {
        const byCase = this.options.screens
          ? await this.options.screens(job.projectId).catch(() => new Map<string, readonly Screen[]>())
          : new Map<string, readonly Screen[]>();
        const rows = await this.rows(jobId);
        for (const card of open) {
          const first = rows.find((r) => r.testId === card.cases[0]?.testId);
          if (!first || !card.asks) continue;
          const own = card.cases.map((c) => byCase.get(c.testId) ?? []).find((s) => s.length) ?? [];
          card.suggestions = await suggestionsFor({ ...card.asks, why: card.why }, first.verdict, own, byCase);
        }
      }
    }
    return cards;
  }

  /**
   * E0.19 step 3, ask once: a person says what the sentence of a card means, as a sentence the engine can run. It is kept as a project
   * reading, checked like every reading (it must read as a real step or a check that judges something, and must not clash with another),
   * and every case of the project with that sentence is read by it from the next run on. This run's results stay as they were.
   */
  async answer(
    jobId: string,
    cardId: string,
    input: { means: unknown; who?: unknown },
  ): Promise<{ cardId: string; entryId: string; kind: 'step' | 'check'; sentence: string; means: string; casesOnCard: number; casesInProject: number }> {
    if (typeof input.means !== 'string' || !input.means.trim()) throw new ReviewRefused('Say what the sentence means, as a step or a check.');
    const means = input.means.trim();
    if (means.length > MAX_NOTE) throw new ReviewRefused(`The answer is longer than ${MAX_NOTE} characters.`);
    if (!this.options.read) throw new ReviewRefused('Answers cannot be kept here.');
    const reviewer = checkedName(input.who, await this.store.currentUserName());
    const job = await this.store.job(jobId);
    if (!job) throw new ReviewRefused('There is no such job.', 404);
    const card = (await this.cards(jobId)).find((c) => c.id === cardId);
    if (!card) throw new ReviewRefused('There is no such card on this job.', 404);
    if (!card.asks) throw new ReviewRefused('This card is about what the page showed: it is decided with PASS or FAIL, not answered with a sentence.');
    const { sentence, kind } = card.asks;
    if (ruleKey(sentence) === ruleKey(means)) throw new ReviewRefused('The answer is the same sentence: say what it means, in words the engine can run.');
    const source = `review card in ${jobId}: ${card.cases.map((c) => c.testId).join(', ')}`;
    // A sentence in a step line may be answered with a check ("the browser is open"), and the other way round: the other kind is tried
    // when the first is refused, and the first refusal is what the person is told.
    let saved: { id: string; kind: 'step' | 'check' } | undefined;
    let refusal: string | undefined;
    for (const k of kind === 'step' ? (['step', 'check'] as const) : (['check', 'step'] as const)) {
      try {
        const entry = await this.options.read(
          job.projectId,
          { readingKind: k, from: sentence, to: means, example: `${card.cases[0]?.testId}: ${sentence}` },
          source,
          reviewer,
        );
        saved = { id: entry.id, kind: k };
        break;
      } catch (e) {
        refusal ??= (e as Error).message;
      }
    }
    if (!saved) throw new ReviewRefused(refusal ?? 'The answer could not be kept.');
    const table = { [ruleKey(sentence)]: means };
    let casesInProject = 0;
    for (const record of await this.store.testCases(job.projectId))
      if (withReadings(record.raw, { step: table, check: table }).applied.length) casesInProject += 1;
    return { cardId, entryId: saved.id, kind: saved.kind, sentence, means, casesOnCard: card.cases.length, casesInProject };
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
