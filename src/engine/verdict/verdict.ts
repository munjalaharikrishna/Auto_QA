import type { BlockCode, RunTrace, StepRecord } from '../execute/executor.js';
import type { Observation } from '../execute/observe.js';
import type { IrExpectation } from '../ir/schema.js';
import type { CompileResult } from '../pipeline/compile.js';
import { type Evaluation, evaluateExpectation, saysTheSame, vacuity } from './evaluate.js';
import { fingerprintOf, type LearningBook } from './learn.js';

/**
 * Layers 45 to 52: preconditions, isolation, paradox, unsupported intent, recovery limits, root cause (VD-02 to VD-07),
 * the confidence invariant (VD-08), the PASS safety gate (VD-09), the nine verdicts (VD-10) and the terminal verification
 * of twelve answers (GV-16). Every run ends in exactly one verdict. A PASS needs every expectation proven by fresh evidence;
 * a doubt is never turned into a PASS, and nothing here reads a confidence: how sure the engine was about an element
 * steers how it worked, and never decides PASS or FAIL.
 */

export const VERDICTS = [
  'PASS',
  'FAIL',
  'NEEDS_REVIEW',
  'NOT_VERIFIED',
  'BLOCKED',
  'UNSUPPORTED',
  'AUTOMATION_ERROR',
  'ENVIRONMENT_ERROR',
  'TEST_DATA_ERROR',
] as const;
export type VerdictName = (typeof VERDICTS)[number];

/** The four places a failure can come from (VD-07). */
export type RootCause = 'APPLICATION' | 'AUTOMATION' | 'ENVIRONMENT' | 'TEST_DATA';

export interface Answer {
  n: number;
  question: string;
  /** `yes` is the answer that allows a PASS. */
  answer: 'yes' | 'no' | 'not reached';
  detail: string;
}

export interface UserDecision {
  who: string;
  when: string;
  note?: string;
  /** The decision was remembered from an earlier one, not made on this run. */
  remembered: boolean;
}

export interface Verdict {
  testId: string;
  verdict: VerdictName;
  /** The bucket a FAIL or an error belongs to, with the evidence in `reason` (VD-07). */
  rootCause?: RootCause;
  reason: string;
  evaluations: Evaluation[];
  /** The twelve answers of the terminal verification, stored with every verdict (GV-16). */
  verification: Answer[];
  /** What the engine decided, before a person did. Kept whatever a person decides (DEC-05). */
  engineVerdict?: VerdictName;
  decidedByUser?: UserDecision;
  /** Why the card exists: the cause that identical cases share (VD-11). */
  reviewCause?: string;
}

export interface JudgeInput {
  compile: CompileResult;
  trace?: RunTrace;
  /** What people decided before (BP-4). */
  learning?: LearningBook;
}

const ENVIRONMENT_WORDS = [
  'net::',
  'err_connection',
  'econnrefused',
  'enotfound',
  'err_name_not_resolved',
  'timed out',
  'err_timed_out',
  'service unavailable',
  'bad gateway',
  '502',
  '503',
  'maintenance',
];
const LOCKED_WORDS = ['locked', 'suspended', 'deactivated', 'too many attempts'];

const lower = (s: string): string => s.toLowerCase();
const has = (text: string, words: readonly string[]): string | undefined => words.find((w) => lower(text).includes(w));

const QUESTIONS = [
  'Was the test case understood?',
  'Was every action understood?',
  'Was the test data resolved?',
  'Was the correct target found?',
  'Was the correct action performed?',
  'Was the expected result understood?',
  'Was the actual behaviour observed?',
  'Does the evidence prove every expectation?',
  'Is there any ambiguity?',
  'Is there any contradiction?',
  'Is there any stale evidence?',
  'Is there any automation or environment error?',
] as const;

const BLOCK_VERDICT: Record<BlockCode, { verdict: VerdictName; cause?: RootCause }> = {
  TOOL_MISSING: { verdict: 'AUTOMATION_ERROR', cause: 'AUTOMATION' },
  LOCATE_NOT_FOUND: { verdict: 'NEEDS_REVIEW', cause: 'AUTOMATION' },
  LOCATE_AMBIGUOUS: { verdict: 'NEEDS_REVIEW' },
  LOCATE_INACTIVE: { verdict: 'NEEDS_REVIEW' },
  LOCATOR_NOT_UNIQUE: { verdict: 'NEEDS_REVIEW', cause: 'AUTOMATION' },
  VALUE_UNRESOLVED: { verdict: 'TEST_DATA_ERROR', cause: 'TEST_DATA' },
  ROW_NOT_FOUND: { verdict: 'NEEDS_REVIEW' },
  ROW_AMBIGUOUS: { verdict: 'NEEDS_REVIEW' },
  PAGE_UNKNOWN: { verdict: 'NEEDS_REVIEW' },
  FILE_MISSING: { verdict: 'TEST_DATA_ERROR', cause: 'TEST_DATA' },
  FILE_NOT_ALLOWED: { verdict: 'TEST_DATA_ERROR', cause: 'TEST_DATA' },
  UNSUPPORTED_ACTION: { verdict: 'UNSUPPORTED' },
  ACTION_FAILED: { verdict: 'AUTOMATION_ERROR', cause: 'AUTOMATION' },
};

function answers(a: Partial<Record<number, { answer: Answer['answer']; detail: string }>>): Answer[] {
  return QUESTIONS.map((question, i) => ({
    n: i + 1,
    question,
    answer: a[i + 1]?.answer ?? 'not reached',
    detail: a[i + 1]?.detail ?? 'the run did not get this far',
  }));
}

const make = (testId: string, verdict: VerdictName, reason: string, verification: Answer[], extra: Partial<Verdict> = {}): Verdict => ({
  testId,
  verdict,
  reason,
  evaluations: [],
  verification,
  ...extra,
});

/** What the run itself says about the environment or the test data, from the pages it saw. */
function environmentOf(steps: readonly StepRecord[]): { verdict: VerdictName; cause: RootCause; reason: string } | undefined {
  for (const s of steps) {
    const page = s.after;
    if (!page) continue;
    const text = [page.title, ...page.messages, ...page.lines.slice(0, 12)].join(' | ');
    const env = has(page.title, ['service unavailable', 'bad gateway', '502', '503', 'maintenance']);
    if (env) return { verdict: 'ENVIRONMENT_ERROR', cause: 'ENVIRONMENT', reason: `after ${s.step} the page is "${page.title}" (${env})` };
    const locked = [...page.messages, ...page.fieldErrors.map((f) => f.message)].find((m) => has(m, LOCKED_WORDS) && !(s.before?.messages ?? []).includes(m));
    if (locked)
      return { verdict: 'TEST_DATA_ERROR', cause: 'TEST_DATA', reason: `after ${s.step} the application says "${locked}": the account cannot be used` };
    if (has(text, ['err_connection']) && page.url.startsWith('chrome-error'))
      return { verdict: 'ENVIRONMENT_ERROR', cause: 'ENVIRONMENT', reason: `after ${s.step} the browser could not reach the application` };
  }
  return undefined;
}

/** Everything the run saw, for telling "never shown" from "not shown now". */
const everySeen = (steps: readonly StepRecord[]): Observation[] => steps.flatMap((s) => [s.before, s.after].filter((o): o is Observation => o !== undefined));

/** What the tester wrote the case to do, in words, for the guard against checks that cannot fail. */
const caseClause = (compile: CompileResult): string => compile.ir?.testCase.name ?? '';

/**
 * Judges one run: the compile result and the trace of the run. A verdict is one of nine, with the reason and the twelve
 * answers. It is a function of the compile result, the trace and what people decided before, and of nothing else.
 */
export function judge(input: JudgeInput): Verdict {
  const { compile, trace } = input;
  const id = compile.testId;
  const blocking = compile.issues.filter((i) => i.severity === 'blocking');

  // 1. The test case itself: unsupported intent first (VD-05), then data, then what a person has to decide (VD-04).
  const unsupported = blocking.find((i) => i.code === 'UNSUPPORTED');
  const understood = (q: number) => ({ answer: 'no' as const, detail: `${blocking[0]?.where ?? ''}: ${blocking[0]?.message ?? 'not understood'}`, n: q });
  if (compile.status === 'error' || !compile.ir || !compile.plan) {
    if (unsupported)
      return make(
        id,
        'UNSUPPORTED',
        `${unsupported.where}: "${unsupported.original}" is not an intent this engine supports, and nothing is guessed`,
        answers({ 1: understood(1), 2: understood(2) }),
        { rootCause: undefined },
      );
    const missing = blocking.find((i) => i.code === 'MISSING_DATA');
    if (missing)
      return make(
        id,
        'TEST_DATA_ERROR',
        `${missing.where}: ${missing.message}`,
        answers({ 1: { answer: 'yes', detail: 'understood' }, 3: { answer: 'no', detail: missing.message } }),
        { rootCause: 'TEST_DATA' },
      );
    if (compile.status === 'error')
      return make(
        id,
        'AUTOMATION_ERROR',
        `the engine failed at ${compile.stage ?? 'a stage'}: ${compile.error ?? 'no detail'}`,
        answers({ 1: { answer: 'no', detail: compile.error ?? '' } }),
        { rootCause: 'AUTOMATION' },
      );
    const first = blocking[0];
    const clearer = first?.suggestion ? ` Say it like this: ${first.suggestion}` : '';
    return make(
      id,
      'NEEDS_REVIEW',
      first ? `${first.where}: ${first.message}.${clearer}` : 'the test case could not be turned into checks',
      answers({ 1: understood(1) }),
      { reviewCause: first ? `${first.code}:${first.original}` : 'NOT_COMPILED' },
    );
  }
  const { ir, plan } = compile;

  // 2. The run: it must have started and finished (VD-02, VD-06).
  if (!trace)
    return make(
      id,
      'BLOCKED',
      'the run did not start',
      answers({ 1: { answer: 'yes', detail: 'understood' }, 2: { answer: 'yes', detail: 'understood' }, 3: { answer: 'yes', detail: 'resolved' } }),
    );
  const base = {
    1: { answer: 'yes' as const, detail: 'every sentence was read into the QA-IR' },
    2: { answer: 'yes' as const, detail: `${ir.steps.length} step(s) understood` },
    6: { answer: 'yes' as const, detail: `${ir.expectations.length} expectation(s) understood` },
  };
  if (trace.status !== 'completed') {
    const stop = trace.stoppedAt;
    const record = trace.steps.find((s) => s.step === stop?.step);
    const unresolved = stop?.code === 'VALUE_UNRESOLVED';
    const detail = `${stop?.step ?? 'the start'}: ${stop?.reason ?? 'the run stopped'}`;
    const a = answers({
      ...base,
      3: unresolved ? { answer: 'no', detail } : { answer: 'yes', detail: 'resolved' },
      4:
        stop?.code?.startsWith('LOCATE') || stop?.code?.startsWith('ROW')
          ? { answer: 'no', detail }
          : { answer: 'yes', detail: 'every target before the stop was found' },
      9: stop?.code?.includes('AMBIGUOUS') || stop?.code === 'LOCATOR_NOT_UNIQUE' ? { answer: 'yes', detail } : { answer: 'no', detail: 'none' },
      12: { answer: stop?.code === 'ACTION_FAILED' || stop?.code === 'TOOL_MISSING' ? 'yes' : 'no', detail },
    });
    if (stop?.code === 'START') {
      const env = has(stop.reason, ENVIRONMENT_WORDS);
      return make(id, env ? 'ENVIRONMENT_ERROR' : 'BLOCKED', `the run could not start: ${stop.reason}`, a, env ? { rootCause: 'ENVIRONMENT' } : {});
    }
    const mapped = BLOCK_VERDICT[(stop?.code ?? 'ACTION_FAILED') as BlockCode];
    if (stop?.code === 'ACTION_FAILED' && has(stop.reason, ENVIRONMENT_WORDS)) return make(id, 'ENVIRONMENT_ERROR', detail, a, { rootCause: 'ENVIRONMENT' });
    // A step whose action ended the page before the error was read: the application's own error page is the environment.
    const seenError = environmentOf(trace.steps);
    if (seenError) return make(id, seenError.verdict, seenError.reason, a, { rootCause: seenError.cause });
    return make(id, mapped.verdict, `${stop?.code ?? 'ACTION_FAILED'} at ${detail}`, a, {
      ...(mapped.cause ? { rootCause: mapped.cause } : {}),
      ...(mapped.verdict === 'NEEDS_REVIEW' ? { reviewCause: `${stop?.code}:${record?.original ?? stop?.step}` } : {}),
    });
  }

  const env = environmentOf(trace.steps);
  if (env)
    return make(id, env.verdict, env.reason, answers({ ...base, 3: { answer: 'yes', detail: 'resolved' }, 12: { answer: 'yes', detail: env.reason } }), {
      rootCause: env.cause,
    });

  // 3. The expectations (EX-06), with freshness (EX-07) and the vacuous guard (EX-08).
  const stepOf = new Map<string, string | undefined>();
  for (const c of trace.steps) for (const e of c.checksAfter) stepOf.set(e, c.step);
  const last = trace.steps.at(-1)?.step;
  const inPlan = new Set(plan.items.filter((i) => i.kind === 'expect').map((i) => i.ref));
  for (const e of ir.expectations) if (inPlan.has(e.id) && !stepOf.has(e.id)) stepOf.set(e.id, e.afterStep ?? last);
  const seen = everySeen(trace.steps);
  const ctx = { steps: trace.steps, stepOf, seen, clause: caseClause(compile), pages: compile.pages, ...(compile.values ? { values: compile.values } : {}) };
  const evaluations: Evaluation[] = [];
  const learnedUsed: string[] = [];
  let decided: Verdict['decidedByUser'];
  for (const exp of ir.expectations.filter((e) => inPlan.has(e.id))) {
    let ev = evaluateExpectation(exp, ctx);
    const empty = vacuity(exp, ctx);
    if (empty) {
      ev = { ...ev, result: 'unproven', doubt: 'VACUOUS', why: `a check that cannot fail: ${empty}`, fresh: false };
    } else if (ev.result === 'unproven' && input.learning) {
      const learned = learnedFor(exp, ev, input.learning, trace);
      if (learned) {
        ev = {
          ...ev,
          result: learned.decision === 'PASS' ? 'proven' : 'disproven',
          why: `${learned.decision === 'PASS' ? 'a person decided PASS' : 'a person decided FAIL'} on this before (${learned.who}, ${learned.when}): ${learned.message !== undefined ? `the message "${learned.message}" is shown again` : 'the page shows the same as then'}`,
          fresh: true,
        };
        learnedUsed.push(exp.id);
        decided = { who: learned.who, when: learned.when, ...(learned.note ? { note: learned.note } : {}), remembered: true };
      }
    }
    evaluations.push(ev);
  }
  const disproven = evaluations.filter((e) => e.result === 'disproven');
  const unproven = evaluations.filter((e) => e.result === 'unproven');
  const stale = evaluations.some((e) => e.doubt === 'STALE');
  const vacuous = evaluations.some((e) => e.doubt === 'VACUOUS');
  const guarded = !plan.passAllowed;
  const verification = answers({
    ...base,
    3: { answer: 'yes', detail: 'every value has a stated source' },
    4: { answer: 'yes', detail: `${trace.steps.filter((s) => s.located).length} target(s) found and checked` },
    5: { answer: 'yes', detail: `${trace.steps.length} step(s) done` },
    7: { answer: trace.steps.some((s) => s.after) ? 'yes' : 'no', detail: 'the page was read before and after each step' },
    8: {
      answer: unproven.length === 0 && disproven.length === 0 ? 'yes' : 'no',
      detail: `${evaluations.filter((e) => e.result === 'proven').length} proven, ${disproven.length} disproven, ${unproven.length} unproven of ${evaluations.length}`,
    },
    9: { answer: 'no', detail: 'no step or target was ambiguous' },
    10: { answer: 'no', detail: 'no contradiction was flagged' },
    11: { answer: stale ? 'yes' : 'no', detail: stale ? 'a message was on the page before the step' : 'every piece of evidence is from its step' },
    12: { answer: 'no', detail: 'no automation or environment error' },
  });
  const common = { evaluations, verification, ...(decided ? { decidedByUser: decided } : {}) };

  if (disproven.length > 0) {
    const e = disproven[0] as Evaluation;
    return { testId: id, verdict: 'FAIL', rootCause: 'APPLICATION', reason: `${e.expectation} "${e.clause}": expected ${e.expected}; ${e.actual}`, ...common };
  }
  if (unproven.length === 0 && evaluations.length > 0 && !guarded) {
    return {
      testId: id,
      verdict: 'PASS',
      reason: `all ${evaluations.length} expectation(s) proven by fresh evidence${learnedUsed.length ? ' (some by an earlier decision of a person)' : ''}`,
      ...common,
    };
  }
  if (evaluations.length === 0) return { testId: id, verdict: 'NOT_VERIFIED', reason: 'no expectation was judged', ...common };
  if (unproven.length > 0 && unproven.every((e) => e.doubt === 'NOT_OBSERVABLE') && !guarded) {
    const e = unproven[0] as Evaluation;
    return {
      testId: id,
      verdict: 'NOT_VERIFIED',
      reason: `the steps ran, but ${e.expectation} "${e.clause}" cannot be observed through the page: ${e.why}`,
      ...common,
    };
  }
  const first = unproven[0] ?? (evaluations[0] as Evaluation);
  const why =
    guarded && unproven.length === 0
      ? 'an assumption or an unknown condition in the test case means it cannot be a clean PASS'
      : `${first.expectation} "${first.clause}" is unproven: ${first.why}`;
  return {
    testId: id,
    verdict: 'NEEDS_REVIEW',
    reason: why,
    reviewCause: `${first.expectation}:${first.doubt ?? 'GUARD'}:${first.clause}:${first.actual}`,
    ...common,
    verification: verification.map((a) => (a.n === 11 && vacuous ? { ...a, detail: 'a check that cannot fail was rejected' } : a)),
  };
}

/** A decision a person made on this expectation before: by the message that came with it, or by the same page. */
function learnedFor(exp: IrExpectation, ev: Evaluation, book: LearningBook, trace: RunTrace) {
  const page = trace.steps.find((s) => s.step === ev.step)?.after;
  const shown = page ? [...page.messages, ...page.fieldErrors.map((f) => f.message)] : [];
  const byMessage = book.checkFor(exp.clause, shown, saysTheSame);
  if (byMessage) return byMessage;
  return book.decisionFor(fingerprintOf(exp.clause, ev.actual));
}
