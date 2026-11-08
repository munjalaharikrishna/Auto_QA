import type { HeldCase, Store } from '../db/store.js';
import { labelOf } from '../results/labels.js';
import type { Status, TestVerdict } from '../results/verdict.js';

/**
 * E0.19 step 7, the holding area for flaky cases. A case that passed only on a second try (label `flaky`) can be held by a person: an
 * owner, a reason, and a day it ends, at most 30 days away. While it is held the case still runs and its result is still shown, but it is
 * not one of the questions of a run: the owner has it. When the day passes, the hold ends by itself: the case is asked again, marked
 * overdue with its owner, until someone holds it again or releases it. Nothing is ever hidden: every hold is listed with who and why.
 */

export const MAX_HOLD_DAYS = 30;
export const DEFAULT_HOLD_DAYS = 7;

export class HoldRefused extends Error {}

/** A hold is in force until its day; after it, it is overdue and no longer keeps the case out of the questions. */
export const isOverdue = (h: Pick<HeldCase, 'until'>, at: Date = new Date()): boolean => Date.parse(h.until) <= at.getTime();

/** The cases held now (not overdue), by test case id. */
export function inForce(holds: readonly HeldCase[], at: Date = new Date()): Map<string, HeldCase> {
  return new Map(holds.filter((h) => h.status === 'held' && !isOverdue(h, at)).map((h) => [h.testId, h]));
}

const text = (given: unknown, what: string, min: number, max: number): string => {
  if (typeof given !== 'string') throw new HoldRefused(`${what} must be text.`);
  const t = given.trim();
  if (t.length < min) throw new HoldRefused(min > 1 ? `${what} needs at least ${min} characters.` : `${what} is empty.`);
  if (t.length > max) throw new HoldRefused(`${what} is longer than ${max} characters.`);
  for (const c of t) if (c.charCodeAt(0) < 32) throw new HoldRefused(`${what} holds a control character.`);
  return t;
};

export class HoldService {
  constructor(private readonly store: Store) {}

  list(projectId: string, all = false): Promise<HeldCase[]> {
    return this.store.heldCases(projectId, { all });
  }

  /** Holds a flaky case of a run. Refused for a case that was not flaky in that run: a hold is for a flaky case, not for any FAIL. */
  async hold(
    jobId: string,
    testId: string,
    input: { owner: unknown; reason: unknown; days?: unknown; who?: unknown },
    at: Date = new Date(),
  ): Promise<HeldCase> {
    const owner = text(input.owner, 'The owner', 1, 80);
    const reason = text(input.reason, 'The reason', 3, 500);
    const days = input.days === undefined ? DEFAULT_HOLD_DAYS : Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_HOLD_DAYS) throw new HoldRefused(`A hold is 1 to ${MAX_HOLD_DAYS} whole days.`);
    const who = input.who === undefined || input.who === '' ? await this.store.currentUserName() : text(input.who, 'Your name', 1, 80);
    const job = await this.store.job(jobId);
    if (!job) throw new HoldRefused('There is no such job.');
    const row = (await this.store.verdicts(jobId)).find((r) => r.testId === testId);
    if (!row) throw new HoldRefused(`${testId} is not in this run.`);
    const v = row.verdict as TestVerdict;
    if (labelOf({ ...v, status: row.status as Status }) !== 'flaky')
      throw new HoldRefused(`${testId} was not flaky in this run (it is ${row.status}): only a case that passed only on a second try is held.`);
    const until = new Date(at.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    return this.store.holdCase({ projectId: job.projectId, testId, owner, reason, until, by: who });
  }

  async release(projectId: string, testId: string, input: { note?: unknown; who?: unknown }): Promise<HeldCase> {
    const note = input.note === undefined ? '' : text(input.note, 'The note', 0, 500);
    const who = input.who === undefined || input.who === '' ? await this.store.currentUserName() : text(input.who, 'Your name', 1, 80);
    const released = await this.store.releaseHold(projectId, testId, who, note);
    if (!released) throw new HoldRefused(`${testId} is not held.`);
    return released;
  }
}
