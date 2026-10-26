import path from 'node:path';
import { executePlan, openExecutionSession, type RunTrace } from '../engine/execute/index.js';
import { planActions } from '../engine/execute/planner.js';
import type { CompileResult } from '../engine/index.js';
import type { IrExpectation } from '../engine/ir/schema.js';
import type { Application } from '../engine/knowledge/schema.js';
import type { Evaluation } from '../engine/verdict/evaluate.js';
import { judge, type Verdict } from '../engine/verdict/index.js';
import type { TestModel } from '../model/test-model.js';
import type { CheckVerdict, ReviewReason, StepVerdict, TestVerdict } from '../results/verdict.js';

/**
 * Fallback-only semantic execution. A case the legacy route cannot complete is run through the E0.8 path instead (plan,
 * MCP, judge), but only when every check of it is one the judge decides. Nothing here decides PASS or FAIL: that is `judge`.
 * What this file adds is the guard in front of it (what may be run), and the translation after it (the five statuses of the
 * results sheet), where nothing can become a PASS and a FAIL that rests on a tester's loose wording is set aside for a person.
 */

/** The condition types `evaluateExpectation` decides. Any other type is never run through this path. */
const JUDGED = new Set(['VISIBILITY', 'TEXT', 'AUTHENTICATION', 'URL', 'ENABLED', 'VALUE', 'MASKED', 'HEALTH']);

export interface SemanticJob {
  model: TestModel;
  compiled: CompileResult;
  /** The address the case runs against. */
  baseUrl: string;
  headless?: boolean;
  testIdAttribute?: string;
  /** The login case, compiled: a case that starts "logged in" runs it first, in the same browser (E7). */
  login?: CompileResult;
  /** What the application calls things: the run finds an element by the names the application gives it (D1). */
  knowledge?: Application;
}

export type Support = { ok: true } | { ok: false; why: string };

/** May this compiled case be run by the semantic path? Everything that is not clearly yes is no. */
export function semanticSupport(compiled: CompileResult): Support {
  if (compiled.status !== 'compiled') return { ok: false, why: `the case did not compile cleanly (${compiled.status})` };
  if (!compiled.ir || !compiled.plan) return { ok: false, why: 'the case has no QA-IR or plan' };
  const blocking = compiled.issues.find((i) => i.severity === 'blocking');
  if (blocking) return { ok: false, why: `${blocking.where}: ${blocking.message}` };
  if (compiled.ir.expectations.length === 0) return { ok: false, why: 'the case has no expected result to judge' };
  const other = compiled.ir.expectations.find((e) => !JUDGED.has(e.condition.type));
  if (other) return { ok: false, why: `${other.id} is a ${other.condition.type} check, which the verdict engine does not judge yet` };
  return { ok: true };
}

const STATUS: Record<Verdict['verdict'], TestVerdict['status']> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  NEEDS_REVIEW: 'NEEDS REVIEW',
  NOT_VERIFIED: 'NOT VERIFIED',
  BLOCKED: 'BLOCKED',
  UNSUPPORTED: 'NEEDS REVIEW',
  AUTOMATION_ERROR: 'NEEDS REVIEW',
  ENVIRONMENT_ERROR: 'BLOCKED',
  TEST_DATA_ERROR: 'BLOCKED',
};

const CATEGORY: Partial<Record<NonNullable<Verdict['rootCause']>, TestVerdict['category']>> = {
  APPLICATION: 'Assertion',
  AUTOMATION: 'Locator',
  ENVIRONMENT: 'Environment',
  TEST_DATA: 'Test Data',
};

/** A check that a message is shown, with the words the tester wrote: the one kind of check a loose "appropriate" can fail wrongly. */
function wantsAMessage(exp: IrExpectation | undefined): boolean {
  if (!exp || exp.negated) return false;
  const c = exp.condition;
  if (c.expect === 'HIDDEN') return false;
  if (c.type === 'VISIBILITY') return c.target?.ontology === 'Message' || c.target?.ontology === 'Error' || c.text !== undefined;
  return c.type === 'TEXT' && (c.target?.ontology === 'Message' || c.target?.ontology === 'Error');
}

/**
 * What a step put on the page: messages tagged as alerts or status, and any other text that was not there before it. An old
 * page writes its error as plain text with no role, which the observer does not call a message, so "no message appeared" is
 * only a fact when no new text appeared either.
 */
function freshText(trace: RunTrace | undefined, step: string | undefined): string[] {
  const record = trace?.steps.find((s) => s.step === step);
  if (!record?.after) return [];
  const known = new Set([...(record.before?.messages ?? []), ...(record.before?.fieldErrors.map((f) => f.message) ?? []), ...(record.before?.lines ?? [])]);
  const now = [...record.after.messages, ...record.after.fieldErrors.map((f) => f.message), ...record.after.lines];
  return [...new Set(now.filter((t) => !known.has(t)))].slice(0, 5).map((t) => (t.length > 120 ? `${t.slice(0, 120)}…` : t));
}

/**
 * A FAIL stands when the page contradicts the case. It is set aside when every disproven check is "a message with these words
 * is shown" and the step did put new text on the page, only not in those words: whether that is the appropriate message is for a person to say.
 */
function looseWording(verdict: Verdict, trace: RunTrace | undefined, compiled: CompileResult): { shown: string[] } | undefined {
  if (verdict.verdict !== 'FAIL') return undefined;
  const disproven = verdict.evaluations.filter((e) => e.result === 'disproven');
  if (disproven.length === 0) return undefined;
  const shown: string[] = [];
  for (const e of disproven) {
    const exp = compiled.ir?.expectations.find((x) => x.id === e.expectation);
    const messages = freshText(trace, e.step);
    if (!wantsAMessage(exp) || messages.length === 0) return undefined;
    shown.push(...messages);
  }
  return { shown: [...new Set(shown)] };
}

const review = (id: string, raw: string, headline: string, why: string, todo: string[]): ReviewReason => ({ id, raw, headline, why, todo });

function reasonsFor(verdict: Verdict, loose: { shown: string[] } | undefined, trace: RunTrace | undefined): ReviewReason[] {
  const stop = trace?.stoppedAt;
  if (stop) {
    const record = trace?.steps.find((s) => s.step === stop.step);
    return [
      review(stop.step, record?.original ?? '', 'The new run stopped at a step it could not do:', `${stop.code}: ${stop.reason}`, [
        'Reword the step, or do it by hand and decide on the review card.',
      ]),
    ];
  }
  if (loose) {
    const e = verdict.evaluations.find((x) => x.result === 'disproven') as Evaluation;
    return [
      review(
        e.expectation,
        e.clause,
        'The page showed something, but not in the words of the expected result.',
        `Expected ${e.expected}; after the step the page showed new text: ${loose.shown.map((m) => `"${m}"`).join(', ')}.`,
        ['If that message is the appropriate one, decide PASS on the review card; otherwise reword the expected result with the exact message.'],
      ),
    ];
  }
  const open = verdict.evaluations.filter((e) => e.result === 'unproven');
  if (open.length > 0)
    return open.map((e) =>
      review(e.expectation, e.clause, 'Not proven:', e.why, [
        `Check on the screenshot what the page showed (${e.actual}); decide PASS or FAIL on the review card.`,
      ]),
    );
  return [review('', '', 'Not decided by the new engine:', verdict.reason, ['Open the review card for this case, or reword the sentence the reason names.'])];
}

const stepResult = (status: string | undefined): StepVerdict['result'] =>
  status === 'done' ? 'passed' : status === 'failed' || status === 'blocked' ? 'failed' : 'not run';
const checkResult = (e: Evaluation): CheckVerdict['result'] => (e.result === 'proven' ? 'passed' : e.result === 'disproven' ? 'failed' : 'not verified');

/**
 * The verdict of a semantic run as a row of the results sheet. A PASS only ever comes from a PASS of the judge; no other
 * verdict is turned into one. Nothing of the trace but picture files is copied over, so no value of the run is kept.
 */
export function toTestVerdict(
  model: TestModel,
  verdict: Verdict,
  trace: RunTrace | undefined,
  compiled: CompileResult,
  durationMs = 0,
  startedAt?: string,
): TestVerdict {
  // A run that stopped says nothing about the application: whatever the judge named it, it is set aside with the reason (never a PASS, FAIL or BLOCKED).
  const stoppedEarly = !!trace && trace.status !== 'completed';
  const loose = looseWording(verdict, trace, compiled);
  const status = stoppedEarly || loose ? 'NEEDS REVIEW' : STATUS[verdict.verdict];
  const disproven = verdict.evaluations.find((e) => e.result === 'disproven');
  const stop = trace?.stoppedAt;
  const failedStep = stop ? stop.step : status === 'FAIL' && disproven ? `${disproven.expectation} ${disproven.clause}` : undefined;
  const records = new Map((trace?.steps ?? []).map((s) => [s.step, s]));
  const shots = (trace?.steps ?? []).flatMap((s) => [s.screenshots?.before, s.screenshots?.after].filter((p): p is string => !!p));
  return {
    executionId: '',
    testId: model.id,
    title: model.title,
    automationId: model.id,
    status,
    ...(status === 'FAIL'
      ? { category: 'Assertion' as const }
      : (status === 'NEEDS REVIEW' || status === 'BLOCKED') && !stoppedEarly
        ? { category: verdict.rootCause ? CATEGORY[verdict.rootCause] : undefined }
        : {}),
    ...(failedStep ? { failedStep } : {}),
    reason: loose
      ? `${verdict.evaluations.find((e) => e.result === 'disproven')?.clause ?? ''}: the page showed new text (${loose.shown.map((m) => `"${m}"`).join(', ')}), but not in the words expected`
      : verdict.reason,
    ...(status === 'NEEDS REVIEW' ? { review: reasonsFor(verdict, loose, trace) } : {}),
    expected: model.assertions
      .map((a) => a.raw)
      .filter(Boolean)
      .join(' '),
    actual: verdict.evaluations.length
      ? verdict.evaluations
          .map((e) => (loose && e.result === 'disproven' ? `the page showed new text: ${loose.shown.map((m) => `"${m}"`).join(', ')}` : e.actual))
          .join(' | ')
      : verdict.reason,
    steps: model.steps.map((s) => {
      const r = records.get(s.id);
      return {
        id: s.id,
        raw: s.raw,
        result: stepResult(r?.status),
        ...(r?.status === 'failed' || r?.status === 'blocked' ? { error: r.reason } : {}),
      };
    }),
    checks: verdict.evaluations.length
      ? verdict.evaluations.map((e) => ({ id: e.expectation, raw: e.clause, expected: e.expected, actual: e.actual, result: checkResult(e) }))
      : model.assertions.map((a) => ({ id: a.id, raw: a.raw, expected: a.raw, actual: '', result: 'not run' as const })),
    durationMs,
    ...(startedAt ? { startedAt } : {}),
    evidence: { screenshots: shots },
  };
}

export interface SemanticRunOptions {
  /** Where the pictures of each case are kept: one folder per case. */
  screenshotDir?: string;
  onProgress?: (message: string) => void;
}

/**
 * Runs the offered cases in one browser, each from a clean state, and returns a verdict for every case that was run. A case
 * that could not be run at all has no entry, so the answer the legacy route gave it stays.
 */
export async function runSemanticJobs(jobs: readonly SemanticJob[], options: SemanticRunOptions = {}): Promise<Map<string, TestVerdict>> {
  const out = new Map<string, TestVerdict>();
  const runnable = jobs.filter((j) => j.compiled.ir && j.compiled.plan);
  if (runnable.length === 0) return out;
  const first = runnable[0] as SemanticJob;
  let session: Awaited<ReturnType<typeof openExecutionSession>>;
  try {
    session = await openExecutionSession({ headless: first.headless ?? true, testIdAttribute: first.testIdAttribute });
  } catch (e) {
    options.onProgress?.(`? the new engine could not open a browser (${(e as Error).message.split('\n')[0]}); these cases keep their review`);
    return out;
  }
  try {
    for (const job of runnable) {
      const { model, compiled } = job;
      const { ir, plan } = compiled;
      if (!ir || !plan) continue;
      options.onProgress?.(`… ${model.id}: running through the new engine`);
      const origin = new URL(job.baseUrl).origin;
      const pages = Object.fromEntries(Object.entries(compiled.pages ?? {}).map(([k, v]) => [k, v?.startsWith('/') ? `${origin}${v}` : v]));
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      try {
        await session.reset();
        const needsLogin = ir.preconditions.some((p) => p.type === 'LOGGED_IN');
        if (needsLogin && job.login?.ir && job.login.plan) {
          const loginPages = Object.fromEntries(
            Object.entries({ ...job.login.pages, ...compiled.pages }).map(([k, v]) => [k, v?.startsWith('/') ? `${origin}${v}` : v]),
          );
          const signedIn = await executePlan(
            { plan: planActions(job.login.ir, job.login.plan), values: job.login.values, pages: loginPages },
            {
              mcp: session.port,
              page: session.page,
              baseUrl: job.baseUrl,
              testIdAttribute: job.testIdAttribute,
              ...(job.knowledge ? { knowledge: job.knowledge } : {}),
            },
          );
          if (signedIn.status !== 'completed') {
            const why = signedIn.stoppedAt ? `${signedIn.stoppedAt.code}: ${signedIn.stoppedAt.reason}` : 'the login did not finish';
            options.onProgress?.(`? ${model.id}: the login that comes first did not work (${why}); it keeps its review`);
            continue;
          }
        } else if (needsLogin) {
          options.onProgress?.(`? ${model.id}: starts logged in and no login case is given; it keeps its review`);
          continue;
        }
        const trace = await executePlan(
          { plan: planActions(ir, plan), values: compiled.values, pages },
          {
            mcp: session.port,
            page: session.page,
            baseUrl: job.baseUrl,
            testIdAttribute: job.testIdAttribute,
            ...(job.knowledge ? { knowledge: job.knowledge } : {}),
            ...(options.screenshotDir ? { screenshotDir: path.join(options.screenshotDir, model.id) } : {}),
          },
        );
        out.set(model.id, toTestVerdict(model, judge({ compile: compiled, trace }), trace, compiled, Date.now() - started, startedAt));
      } catch (e) {
        options.onProgress?.(`? ${model.id}: the new engine could not run it (${(e as Error).message.split('\n')[0]}); it keeps its review`);
      }
    }
  } finally {
    await session.close();
  }
  return out;
}
