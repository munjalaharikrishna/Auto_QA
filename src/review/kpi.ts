import { z } from 'zod';
import type { AnswerKey } from '../engine/governance/index.js';
import { labelCounts, labelOf, type ReviewLabel } from '../results/labels.js';
import type { Status, TestVerdict } from '../results/verdict.js';
import { buildReviewCards, type StoredVerdict } from './cards.js';

/**
 * E0.19 step 1: the review KPIs of a run, measured at run time, against one frozen baseline with fixed denominators (§10.4 E0.19
 * item 3). The question the KPIs answer is the engine's goal: how much does a person still have to look at after a run.
 *
 * - Set aside: test cases a person has to look at: NEEDS REVIEW, NOT VERIFIED and BLOCKED (a person fixes the account, data or
 *   setup before it can run). The legacy baseline had no BLOCKED case.
 * - Questions: what a person actually decides, one per review card (cases with one cause are one card).
 * - Reviews per 100 steps: questions over the steps of the workbook as written. The steps come from the baseline, so a run that
 *   skips or splits steps cannot make the rate look better.
 * - Flake rate, wrong PASS and wrong FAIL (against an answer key), active review time and walkthroughs.
 *
 * Nothing here moves the baseline: it is a file written by hand (`test/baseline/kpi-baseline.json`).
 */

export const KpiModuleSchema = z.object({
  label: z.string().min(1),
  workbook: z.string().min(1),
  engine: z.string().min(1),
  testCases: z.number().int().positive(),
  steps: z.number().int().positive(),
  caseIds: z.array(z.string().min(1)).min(1),
  setAside: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
  statuses: z.record(z.string(), z.number().int().nonnegative()),
});
export const KpiBaselineSchema = z.object({
  version: z.string().min(1),
  frozenOn: z.string().min(1),
  about: z.string().optional(),
  modules: z.record(z.string(), KpiModuleSchema),
});
export type KpiModule = z.infer<typeof KpiModuleSchema>;
export type KpiBaseline = z.infer<typeof KpiBaselineSchema>;

/** A pause longer than this between two review actions is time away, not review time. */
export const REVIEW_IDLE_MS = 10 * 60 * 1000;

/** When a person opened the review of a run, and when they decided: ISO times. */
export interface ReviewActivity {
  views: readonly string[];
  decisions: readonly string[];
}

export interface WalkthroughSpan {
  startedAt?: string;
  finishedAt?: string;
}

export interface Change {
  before: number;
  after: number;
  /** `1 - after / before`; undefined when the baseline had none. Negative when there are more than before. */
  reduction?: number;
}

const STATUSES: readonly Status[] = ['PASS', 'FAIL', 'BLOCKED', 'NEEDS REVIEW', 'NOT VERIFIED'];

export interface RunKpi {
  /** The run: a job id or a batch file. */
  run: string;
  label: string;
  /** The baseline module the run was matched to, by its test case ids. */
  module?: string;
  testCases: number;
  statuses: Record<Status, number>;
  setAside: number;
  questions: number;
  /** Steps that were run, for the record; the rate uses `denominator.steps`. */
  stepsRun: number;
  denominator: { testCases: number; steps: number; fixed: boolean };
  reviewsPer100Steps: number;
  flaky: number;
  flakeRate: number;
  labels: Array<[ReviewLabel, number]>;
  answerKey?: { signedOff: boolean; compared: number; matched: number; wrongPass: string[]; wrongFail: string[]; notInKey: string[] };
  reviewTime?: { decisions: number; activeMs: number; perDecisionMs?: number };
  walkthroughs?: { count: number; totalMs: number };
  /** Cases held by a person (E0.19 step 7): listed, with owner and day, and not counted as questions. */
  held?: Array<{ testId: string; owner: string; until: string }>;
  vsBaseline?: { setAside: Change; questions: Change; reviewsPer100Steps: Change };
}

const change = (before: number, after: number): Change => ({ before, after, ...(before > 0 ? { reduction: 1 - after / before } : {}) });
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The baseline module that holds most of the run's test cases; none when fewer than half of them are in any. */
export function matchModule(baseline: KpiBaseline, ids: readonly string[]): string | undefined {
  let best: { key: string; overlap: number } | undefined;
  for (const [key, m] of Object.entries(baseline.modules)) {
    const known = new Set(m.caseIds);
    const overlap = ids.filter((id) => known.has(id)).length;
    if (!best || overlap > best.overlap) best = { key, overlap };
  }
  return best && best.overlap > 0 && best.overlap * 2 >= ids.length ? best.key : undefined;
}

/**
 * Active review time: each decision counts the time since the action before it (opening the review or the decision before), when
 * that pause is not longer than `REVIEW_IDLE_MS`. A first decision with nothing before it counts nothing: the time is not known.
 */
export function activeReviewTime(activity: ReviewActivity, idleMs = REVIEW_IDLE_MS): { decisions: number; activeMs: number; perDecisionMs?: number } {
  const events = [
    ...activity.views.map((at) => ({ at: Date.parse(at), decision: false })),
    ...activity.decisions.map((at) => ({ at: Date.parse(at), decision: true })),
  ]
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at || Number(a.decision) - Number(b.decision));
  let activeMs = 0;
  let decisions = 0;
  for (const [i, e] of events.entries()) {
    if (!e.decision) continue;
    decisions += 1;
    const before = events[i - 1];
    if (before && e.at - before.at <= idleMs) activeMs += e.at - before.at;
  }
  return { decisions, activeMs, ...(decisions > 0 ? { perDecisionMs: Math.round(activeMs / decisions) } : {}) };
}

const VERDICT_NAME: Record<string, string> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  'NEEDS REVIEW': 'NEEDS_REVIEW',
  'NOT VERIFIED': 'NOT_VERIFIED',
};

/** Wrong PASS: a PASS where the key says anything else. Wrong FAIL: a FAIL where the key says PASS. */
export function compareWithKey(key: AnswerKey, rows: readonly StoredVerdict[]): NonNullable<RunKpi['answerKey']> {
  const expected = new Map(key.cases.map((c) => [c.id, c.expected as string]));
  const out = { signedOff: key.signedOff, compared: 0, matched: 0, wrongPass: [] as string[], wrongFail: [] as string[], notInKey: [] as string[] };
  for (const r of rows) {
    const want = expected.get(r.testId);
    if (want === undefined) {
      out.notInKey.push(r.testId);
      continue;
    }
    const got = VERDICT_NAME[r.status] ?? r.status;
    out.compared += 1;
    if (got === want) out.matched += 1;
    else if (got === 'PASS') out.wrongPass.push(r.testId);
    else if (got === 'FAIL' && want === 'PASS') out.wrongFail.push(r.testId);
  }
  return out;
}

export interface KpiInput {
  run: string;
  label?: string;
  rows: readonly StoredVerdict[];
  baseline?: KpiBaseline;
  key?: AnswerKey;
  activity?: ReviewActivity;
  walkthroughs?: readonly WalkthroughSpan[];
  /** Cases in the holding area now (E0.19 step 7), by test case id: shown apart, not questions or cases set aside. Overdue holds are not here. */
  held?: ReadonlyMap<string, { owner: string; until: string }>;
}

export function runKpiOf(input: KpiInput): RunKpi {
  const rows = input.rows;
  const statuses = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of rows) if (r.status in statuses) statuses[r.status as Status] += 1;
  const module = input.baseline
    ? matchModule(
        input.baseline,
        rows.map((r) => r.testId),
      )
    : undefined;
  const base = module ? input.baseline?.modules[module] : undefined;
  const stepsRun = rows.reduce((n, r) => n + r.verdict.steps.length, 0);
  const denominator = base ? { testCases: base.testCases, steps: base.steps, fixed: true } : { testCases: rows.length, steps: stepsRun, fixed: false };
  // A held case still ran and is counted in the statuses; it is not a question or a case set aside while its owner has it.
  const open = input.held?.size ? rows.filter((r) => !input.held?.has(r.testId)) : rows;
  const questions = buildReviewCards(open, new Map()).length;
  const setAside = open.filter((r) => r.status === 'NEEDS REVIEW' || r.status === 'NOT VERIFIED' || r.status === 'BLOCKED').length;
  const heldHere = rows
    .filter((r) => input.held?.has(r.testId))
    .map((r) => ({ testId: r.testId, ...(input.held?.get(r.testId) as { owner: string; until: string }) }));
  const verdicts: TestVerdict[] = rows.map((r) => ({ ...r.verdict, status: r.status as Status }));
  const flaky = verdicts.filter((v) => labelOf(v) === 'flaky').length;
  const rate = denominator.steps > 0 ? round1((questions * 100) / denominator.steps) : 0;
  const walks = input.walkthroughs ?? [];
  return {
    run: input.run,
    label: input.label ?? base?.label ?? input.run,
    ...(module ? { module } : {}),
    testCases: rows.length,
    statuses,
    setAside,
    questions,
    stepsRun,
    denominator,
    reviewsPer100Steps: rate,
    flaky,
    flakeRate: denominator.testCases > 0 ? flaky / denominator.testCases : 0,
    labels: labelCounts(verdicts),
    ...(heldHere.length ? { held: heldHere } : {}),
    ...(input.key ? { answerKey: compareWithKey(input.key, rows) } : {}),
    ...(input.activity ? { reviewTime: activeReviewTime(input.activity) } : {}),
    ...(input.walkthroughs
      ? {
          walkthroughs: {
            count: walks.length,
            totalMs: walks.reduce((n, w) => {
              const ms = w.startedAt && w.finishedAt ? Date.parse(w.finishedAt) - Date.parse(w.startedAt) : 0;
              return n + (Number.isFinite(ms) && ms > 0 ? ms : 0);
            }, 0),
          },
        }
      : {}),
    ...(base
      ? {
          vsBaseline: {
            setAside: change(base.setAside, setAside),
            questions: change(base.questions, questions),
            reviewsPer100Steps: change(round1((base.questions * 100) / base.steps), rate),
          },
        }
      : {}),
  };
}

/** The runs matched to the baseline, added up: the one number the 80% bar is about. */
export function kpiTotal(kpis: readonly RunKpi[]): { questions: Change; setAside: Change; modules: number } | undefined {
  const matched = kpis.filter((k) => k.vsBaseline);
  if (!matched.length) return undefined;
  const sum = (pick: (k: RunKpi) => Change, side: 'before' | 'after') => matched.reduce((n, k) => n + pick(k)[side], 0);
  const q = (k: RunKpi) => k.vsBaseline?.questions as Change;
  const s = (k: RunKpi) => k.vsBaseline?.setAside as Change;
  return { modules: matched.length, questions: change(sum(q, 'before'), sum(q, 'after')), setAside: change(sum(s, 'before'), sum(s, 'after')) };
}

const pct = (r: number | undefined): string => (r === undefined ? 'n/a' : `${r < 0 ? '+' : '−'}${Math.abs(Math.round(r * 100))}%`);
const minutes = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);

export function kpiText(kpis: readonly RunKpi[], baseline?: KpiBaseline, minimum = 0.8): string {
  const lines: string[] = [];
  if (baseline) lines.push(`Baseline: ${baseline.version}, frozen ${baseline.frozenOn} (${Object.keys(baseline.modules).length} workbooks, legacy engine)`);
  for (const k of kpis) {
    lines.push('', `${k.label}  (${k.run})`);
    lines.push(
      `  ${k.testCases} test cases: ${STATUSES.filter((s) => k.statuses[s] > 0)
        .map((s) => `${k.statuses[s]} ${s}`)
        .join(', ')}`,
    );
    const b = k.vsBaseline;
    lines.push(`  Set aside for a person: ${k.setAside}${b ? `   (baseline ${b.setAside.before}, ${pct(b.setAside.reduction)})` : ''}`);
    lines.push(`  Questions to answer:    ${k.questions}${b ? `   (baseline ${b.questions.before}, ${pct(b.questions.reduction)})` : ''}`);
    lines.push(
      `  Reviews per 100 steps:  ${k.reviewsPer100Steps}${b ? `   (baseline ${b.reviewsPer100Steps.before})` : ''}   over ${k.denominator.steps} steps${k.denominator.fixed ? ' (fixed)' : ' (as run: no baseline)'}`,
    );
    lines.push(
      `  Flaky: ${k.flaky} (${(k.flakeRate * 100).toFixed(1)}%)${k.labels.length ? `   reasons: ${k.labels.map(([l, n]) => `${n} ${l}`).join(', ')}` : ''}`,
    );
    if (k.answerKey?.compared === 0) lines.push('  Answer key: none of these test cases is in it, wrong PASS not measured');
    else if (k.answerKey)
      lines.push(
        `  Answer key${k.answerKey.signedOff ? '' : ' (draft, not signed off)'}: ${k.answerKey.matched} of ${k.answerKey.compared} match; wrong PASS ${k.answerKey.wrongPass.length}${k.answerKey.wrongPass.length ? ` (${k.answerKey.wrongPass.join(', ')})` : ''}; wrong FAIL ${k.answerKey.wrongFail.length}${k.answerKey.wrongFail.length ? ` (${k.answerKey.wrongFail.join(', ')})` : ''}`,
      );
    else lines.push('  Answer key: none given, wrong PASS not measured');
    if (k.reviewTime)
      lines.push(
        `  Review time: ${k.reviewTime.decisions} decisions, ${minutes(k.reviewTime.activeMs)} active${k.reviewTime.perDecisionMs !== undefined ? ` (${minutes(k.reviewTime.perDecisionMs)} each)` : ''}`,
      );
    if (k.held?.length)
      lines.push(`  Held (not counted as questions): ${k.held.map((h) => `${h.testId} by ${h.owner} until ${h.until.slice(0, 10)}`).join(', ')}`);
    if (k.walkthroughs) lines.push(`  Walkthroughs after the run: ${k.walkthroughs.count}, ${minutes(k.walkthroughs.totalMs)}`);
  }
  const total = kpiTotal(kpis);
  if (total) {
    const r = total.questions.reduction;
    lines.push(
      '',
      `All matched workbooks (${total.modules}): questions ${total.questions.before} → ${total.questions.after} (${pct(r)}); set aside ${total.setAside.before} → ${total.setAside.after} (${pct(total.setAside.reduction)})`,
      `Owner's bar: ${Math.round(minimum * 100)}% fewer questions: ${r !== undefined && r >= minimum ? 'met' : 'not met yet'}`,
    );
  }
  return lines.join('\n');
}

/**
 * What the saved live runs block in the gate (E0.19 step 6): any wrong PASS against the answer key, draft or not; and, once the owner
 * declared the minimum engine, fewer questions saved than the minimum (or no run to measure on). Before the declaration the reduction is
 * shown and does not block.
 */
export function runGateProblems(
  kpis: readonly RunKpi[],
  options: { declared: boolean; minimum: number; waived?: boolean; draftKey?: boolean },
): Array<{ module: string; what: string }> {
  const problems = kpis.flatMap((k) =>
    (k.answerKey?.wrongPass ?? []).map((id) => ({ module: k.run, what: `wrong PASS on ${id} against the answer key${options.draftKey ? ' (draft)' : ''}` })),
  );
  if (!options.declared || options.waived) return problems;
  const total = kpiTotal(kpis);
  const r = total?.questions.reduction;
  if (!total) problems.push({ module: 'all', what: 'the minimum engine is declared, and there is no saved live run to measure the review reduction on' });
  else if (r === undefined || r < options.minimum)
    problems.push({
      module: 'all',
      what: `questions at run time are ${r === undefined ? 'not measurable' : `${Math.round(r * 100)}% fewer`} than the legacy engine's (${total.questions.before} before, ${total.questions.after} now), below the minimum of ${Math.round(options.minimum * 100)}%`,
    });
  return problems;
}
