/**
 * The arithmetic of release tracking: what a change does to the date, how far the scope has grown, how much of it is
 * covered by test cases. Pure functions, so every number shown in the UI can be checked here.
 * Dates are `YYYY-MM-DD` strings (a day, not a moment), worked out in UTC so the time zone never moves a date.
 */

export type ReleaseStatus = 'planned' | 'in-progress' | 'released' | 'cancelled';

export interface FeatureLike {
  id: string;
  title: string;
  effortDays: number;
  status: 'planned' | 'in-progress' | 'done';
  addedAfterBaseline: boolean;
  removed: boolean;
  caseIds: string[];
}

export interface ReleaseLike {
  baselineDate: string;
  dueDate: string;
  teamSize: number;
  status: ReleaseStatus;
}

const DAY = 86_400_000;
const asTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const asDate = (time: number) => new Date(time).toISOString().slice(0, 10);

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && asDate(asTime(s)) === s;
export const today = (): string => asDate(Date.now());

/** Days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((asTime(b) - asTime(a)) / DAY);
}

/** `days` working days (Monday to Friday) after `date`. Weekends are skipped; 0 returns the date itself. */
export function addWorkingDays(date: string, days: number): string {
  let t = asTime(date);
  let left = Math.ceil(days);
  while (left > 0) {
    t += DAY;
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return asDate(t);
}

/** The date a release can move to when `effortDays` of work is added: the effort shared by the team, in working days. */
export function suggestDate(dueDate: string, effortDays: number, teamSize: number): string {
  return addWorkingDays(dueDate, effortDays / Math.max(1, teamSize));
}

export interface CaseStatus {
  extId: string;
  lastStatus?: string;
  approved: boolean;
}

export interface ReleaseSummary {
  /** Features in the baseline, features added since, and features taken out. */
  baselineFeatures: number;
  addedFeatures: number;
  removedFeatures: number;
  doneFeatures: number;
  /** Effort of the baseline and of what is in scope now, and the growth between them. */
  baselineEffortDays: number;
  currentEffortDays: number;
  scopeGrowthPercent: number;
  /** Calendar days the date has moved since the baseline (positive = later). */
  slipDays: number;
  /** Calendar days from today to the date (negative = overdue). */
  daysLeft: number;
  /** Features with at least one linked test case, and the test cases behind them. */
  featuresWithCases: number;
  featuresWithoutCases: number;
  coveragePercent: number;
  cases: { total: number; approved: number; pass: number; fail: number; other: number; notRun: number };
  /** `ok`, or why the date is at risk, in words. */
  health: { level: 'ok' | 'watch' | 'late' | 'done'; reason: string };
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

export function summarize(release: ReleaseLike, features: FeatureLike[], cases: CaseStatus[], now = today()): ReleaseSummary {
  const live = features.filter((f) => !f.removed);
  const baseline = features.filter((f) => !f.addedAfterBaseline);
  const sum = (list: FeatureLike[]) => list.reduce((n, f) => n + f.effortDays, 0);
  const baselineEffort = sum(baseline);
  const currentEffort = sum(live);
  const withCases = live.filter((f) => f.caseIds.length);

  const byId = new Map(cases.map((c) => [c.extId, c]));
  const linked = [...new Set(live.flatMap((f) => f.caseIds))].map((id) => byId.get(id)).filter((c): c is CaseStatus => !!c);
  const count = (test: (c: CaseStatus) => boolean) => linked.filter(test).length;
  const counts = {
    total: linked.length,
    approved: count((c) => c.approved),
    pass: count((c) => c.lastStatus === 'PASS'),
    fail: count((c) => c.lastStatus === 'FAIL'),
    notRun: count((c) => !c.lastStatus),
    other: 0,
  };
  counts.other = counts.total - counts.pass - counts.fail - counts.notRun;

  const daysLeft = daysBetween(now, release.dueDate);
  const slipDays = daysBetween(release.baselineDate, release.dueDate);
  const untested = counts.notRun + counts.fail + counts.other;
  let health: ReleaseSummary['health'];
  if (release.status === 'released') health = { level: 'done', reason: 'Released.' };
  else if (release.status === 'cancelled') health = { level: 'done', reason: 'Cancelled.' };
  else if (daysLeft < 0) health = { level: 'late', reason: `${-daysLeft} day(s) past the date.` };
  else if (counts.fail) health = { level: 'watch', reason: `${counts.fail} linked test case(s) failing.` };
  else if (daysLeft <= 3 && untested) health = { level: 'watch', reason: `${daysLeft} day(s) left and ${untested} linked test case(s) not passing yet.` };
  else if (live.length && !withCases.length) health = { level: 'watch', reason: 'No feature has a test case linked yet.' };
  else health = { level: 'ok', reason: 'On track.' };

  return {
    baselineFeatures: baseline.filter((f) => !f.removed).length,
    addedFeatures: live.filter((f) => f.addedAfterBaseline).length,
    removedFeatures: features.filter((f) => f.removed).length,
    doneFeatures: live.filter((f) => f.status === 'done').length,
    baselineEffortDays: baselineEffort,
    currentEffortDays: currentEffort,
    scopeGrowthPercent: baselineEffort ? Math.round(((currentEffort - baselineEffort) / baselineEffort) * 100) : 0,
    slipDays,
    daysLeft,
    featuresWithCases: withCases.length,
    featuresWithoutCases: live.length - withCases.length,
    coveragePercent: pct(withCases.length, live.length),
    cases: counts,
    health,
  };
}
