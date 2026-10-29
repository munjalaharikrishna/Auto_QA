import type { Coverage } from '../language/coverage.js';
import type { PreflightStatus } from '../language/preflight.js';
import type { BenchmarkReport } from './benchmark.js';
import { percent, type ReviewCount, type ReviewReduction } from './metrics.js';

/**
 * The automated protection gate (GV-13). Any change to the grammar, vocabulary, ontology, patterns or registries is
 * measured against the last accepted numbers. It is blocked when the understood rate of steps or checks goes down, when the
 * number of ready test cases goes down, or when a wrong PASS appears. A number that goes up is accepted and becomes the new
 * baseline only by an explicit update: the gate never moves its own bar.
 */

/** What is measured about one workbook (or module) with no browser: the numbers of the T6 measurement. */
export interface Measure {
  testCases: number;
  ready: number;
  /** Test cases a person has to look at: everything that is not ready. */
  reviews: number;
  steps: { understood: number; total: number };
  expectations: { understood: number; total: number };
}

export interface GateBaseline {
  /** The version the numbers were accepted at. */
  version: string;
  modules: Record<string, Measure>;
}

export const measureOf = (statuses: readonly PreflightStatus[], coverage: Pick<Coverage, 'steps' | 'expectations'>): Measure => {
  const ready = statuses.filter((s) => s === 'ready').length;
  return { testCases: statuses.length, ready, reviews: statuses.length - ready, steps: coverage.steps, expectations: coverage.expectations };
};

export const reviewCountOf = (m: Measure): ReviewCount => ({ reviews: m.reviews, testCases: m.testCases });

export interface GateProblem {
  module: string;
  what: string;
}

export interface GateResult {
  /** True only when nothing is worse than the baseline and there is no wrong PASS. */
  ok: boolean;
  problems: GateProblem[];
  /** What got better: a reason to update the baseline, never a reason to block. */
  improvements: GateProblem[];
}

const rateOf = (r: { understood: number; total: number }): number => (r.total === 0 ? 1 : r.understood / r.total);
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;

export interface ReductionBar {
  /** The review reduction of all modules against the legacy baseline (GV-08). */
  total: ReviewReduction;
  /** The least reduction that lets the gate pass: the owner's minimum, 80%. */
  minimum: number;
}

/**
 * The gate measures against the last accepted numbers, and also against the owner's bar: a review reduction below the minimum
 * blocks, even when nothing got worse. An undefined reduction (a baseline with no reviews) cannot show the bar is met, so it blocks too.
 */
export function checkGate(baseline: GateBaseline, current: Record<string, Measure>, benchmark?: BenchmarkReport, bar?: ReductionBar): GateResult {
  const problems: GateProblem[] = [];
  const improvements: GateProblem[] = [];
  const compare = (module: string, what: string, before: number, after: number, show: (n: number) => string): void => {
    if (after < before) problems.push({ module, what: `${what} went down: ${show(before)} to ${show(after)}` });
    else if (after > before) improvements.push({ module, what: `${what} went up: ${show(before)} to ${show(after)}` });
  };
  for (const [module, was] of Object.entries(baseline.modules)) {
    const now = current[module];
    if (!now) {
      problems.push({ module, what: 'was measured before and is missing now' });
      continue;
    }
    compare(module, 'steps understood', rateOf(was.steps), rateOf(now.steps), pct);
    compare(module, 'checks understood', rateOf(was.expectations), rateOf(now.expectations), pct);
    compare(module, 'test cases ready', was.ready, now.ready, String);
  }
  if (bar) {
    const r = bar.total.reduction;
    if (r === undefined || r < bar.minimum)
      problems.push({
        module: 'all',
        what: `review reduction is ${percent(r)}, below the minimum of ${percent(bar.minimum)} (${bar.total.current.reviews} reviews now, ${bar.total.baseline.reviews} before)`,
      });
  }
  if (benchmark && benchmark.wrongPass > 0) {
    for (const o of benchmark.outcomes.filter((x) => x.status === 'wrong-pass')) {
      problems.push({ module: o.module, what: `wrong PASS on ${o.id}: expected ${o.expected} (source: ${o.source ?? 'unknown'})` });
    }
  }
  return { ok: problems.length === 0, problems, improvements };
}

export function gateText(r: GateResult): string {
  const lines = [`Protection gate: ${r.ok ? 'passed' : 'BLOCKED'}`];
  for (const p of r.problems) lines.push(`  blocked  ${p.module}: ${p.what}`);
  for (const p of r.improvements) lines.push(`  better   ${p.module}: ${p.what}`);
  if (r.ok && r.improvements.length) lines.push('  (accept the better numbers with: npm run engine:gate -- --update)');
  return lines.join('\n');
}
