/**
 * The review reduction metric (GV-08): `1 - current reviews / baseline reviews`, shown per batch and per module. A review
 * is a test case a person has to look at. The target is about 90%, the owner's minimum 80%. A baseline with no reviews has
 * nothing to reduce: the metric is then not defined, and says so instead of showing 100% or 0%.
 */

export const REVIEW_REDUCTION_TARGET = 0.9;
export const REVIEW_REDUCTION_MINIMUM = 0.8;

export interface ReviewCount {
  /** Test cases a person has to look at (review or blocked). */
  reviews: number;
  testCases: number;
}

export interface ReviewReduction {
  baseline: ReviewCount;
  current: ReviewCount;
  /** Undefined when the baseline had no reviews. May be negative: more reviews than the baseline. */
  reduction?: number;
  meetsMinimum: boolean;
  meetsTarget: boolean;
}

export function reviewReduction(baseline: ReviewCount, current: ReviewCount): ReviewReduction {
  const reduction = baseline.reviews > 0 ? 1 - current.reviews / baseline.reviews : undefined;
  return {
    baseline,
    current,
    ...(reduction === undefined ? {} : { reduction }),
    meetsMinimum: reduction !== undefined && reduction >= REVIEW_REDUCTION_MINIMUM,
    meetsTarget: reduction !== undefined && reduction >= REVIEW_REDUCTION_TARGET,
  };
}

/** Review reduction for each named group (a workbook, a module): the same formula on each, and on the sum. */
export function reviewReductionBy(
  baseline: Record<string, ReviewCount>,
  current: Record<string, ReviewCount>,
): { byGroup: Record<string, ReviewReduction>; total: ReviewReduction } {
  const sum = (m: Record<string, ReviewCount>, keys: string[]): ReviewCount => ({
    reviews: keys.reduce((n, k) => n + (m[k]?.reviews ?? 0), 0),
    testCases: keys.reduce((n, k) => n + (m[k]?.testCases ?? 0), 0),
  });
  const keys = Object.keys(baseline).filter((k) => k in current);
  const byGroup: Record<string, ReviewReduction> = {};
  for (const k of keys) byGroup[k] = reviewReduction(baseline[k] as ReviewCount, current[k] as ReviewCount);
  return { byGroup, total: reviewReduction(sum(baseline, keys), sum(current, keys)) };
}

export const percent = (r: number | undefined): string => (r === undefined ? 'not defined' : `${(r * 100).toFixed(1)}%`);
