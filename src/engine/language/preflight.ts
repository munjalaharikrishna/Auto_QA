import type { CaseLanguage, Unit } from './case.js';
import type { Issue, IssueCode } from './types.js';

/**
 * The quality pre-flight (GV-14): before anything runs, every test case is scanned for what would send it to review,
 * and the tester is told in plain words, with a clearer way to write each sentence (BP-5). It looks for missing data,
 * ambiguous wording, target conflicts and impossible objectives, and for text the engine could not read at all.
 */

export type PreflightStatus = 'ready' | 'review' | 'blocked';

export interface Rewording {
  where: string;
  /** The tester's own words. */
  original: string;
  suggestion: string;
}

export interface PreflightCase {
  testId: string;
  title: string;
  status: PreflightStatus;
  /** 0 (nothing to review) to 100 (cannot run): how likely this test case is to need a person. */
  riskScore: number;
  issues: Issue[];
  rewordings: Rewording[];
  /** The suggested wording as one text, for a results workbook. Empty when there is nothing to suggest. */
  suggestedWording: string;
  understood: { steps: [number, number]; checks: [number, number] };
}

export interface PreflightReport {
  cases: PreflightCase[];
  ready: number;
  review: number;
  blocked: number;
}

/** The heading each kind of issue is listed under. */
export const CATEGORY: Readonly<Record<IssueCode, string>> = {
  NOT_UNDERSTOOD: 'not understood',
  UNSUPPORTED: 'unsupported action',
  AMBIGUOUS: 'ambiguous wording',
  MISSING_DATA: 'missing data',
  PARADOX: 'impossible objective',
  UNKNOWN_BRANCH: 'unknown branch',
  NOT_CHECKED: 'note, not checked',
  NEEDS_REFERENCE: 'unresolved reference',
};

const WEIGHT = { blocking: 40, review: 15, info: 2 } as const;

/** Blocking issues weigh most, then those that need a decision; the score never reaches 100 unless something blocks the run. */
export function riskScore(issues: readonly Issue[]): number {
  const raw = issues.reduce((sum, i) => sum + WEIGHT[i.severity], 0);
  const blocking = issues.some((i) => i.severity === 'blocking');
  return Math.min(blocking ? 100 : 90, raw);
}

const countUnits = (units: readonly Unit[], kind: Unit['kind']): [number, number] => {
  const of = units.filter((u) => u.kind === kind);
  return [of.filter((u) => u.understood).length, of.length];
};

/** The clearer wordings the issues suggest (BP-5), each once, in the order of the test case. */
export function rewordingsOf(issues: readonly Issue[]): Rewording[] {
  const out: Rewording[] = [];
  for (const i of issues) {
    if (i.severity === 'info' || !i.suggestion) continue;
    if (!out.some((r) => r.where === i.where && r.original === i.original && r.suggestion === i.suggestion))
      out.push({ where: i.where, original: i.original, suggestion: i.suggestion });
  }
  return out;
}

/** The wordings as one text, for a cell of the results workbook. Empty when there is nothing to suggest. */
export const wordingOf = (issues: readonly Issue[]): string =>
  rewordingsOf(issues)
    .map((r) => `${r.where}: "${r.original}" → ${r.suggestion}`)
    .join('\n');

export function preflightOf(title: string, language: CaseLanguage): PreflightCase {
  const issues = language.issues;
  const blocking = issues.some((i) => i.severity === 'blocking');
  const review = issues.some((i) => i.severity === 'review');
  const rewordings = rewordingsOf(issues);
  return {
    testId: language.testId,
    title,
    status: blocking ? 'blocked' : review ? 'review' : 'ready',
    riskScore: riskScore(issues),
    issues,
    rewordings,
    suggestedWording: wordingOf(issues),
    understood: { steps: countUnits(language.units, 'step'), checks: countUnits(language.units, 'expectation') },
  };
}

export function preflightReport(cases: readonly PreflightCase[]): PreflightReport {
  return {
    cases: [...cases],
    ready: cases.filter((c) => c.status === 'ready').length,
    review: cases.filter((c) => c.status === 'review').length,
    blocked: cases.filter((c) => c.status === 'blocked').length,
  };
}

const MARK: Record<PreflightStatus, string> = { ready: 'READY  ', review: 'REVIEW ', blocked: 'BLOCKED' };

/** The report as text for the owner, one block per test case that has something to say. */
export function preflightText(report: PreflightReport, options: { all?: boolean } = {}): string {
  const lines = [`Pre-flight: ${report.cases.length} test case(s): ${report.ready} ready, ${report.review} need a decision, ${report.blocked} blocked`, ''];
  for (const c of report.cases) {
    if (c.status === 'ready' && !options.all) continue;
    lines.push(
      `${MARK[c.status]} ${c.testId}  risk ${c.riskScore}/100  steps ${c.understood.steps[0]}/${c.understood.steps[1]}  checks ${c.understood.checks[0]}/${c.understood.checks[1]}  ${c.title.split('\n').join(' ')}`,
    );
    const shown = new Set<string>();
    for (const i of c.issues) {
      if (i.severity === 'info') continue;
      const line = `    ${i.severity === 'blocking' ? '✗' : '?'} [${CATEGORY[i.code]}] ${i.where}: ${i.message}`;
      if (shown.has(line)) continue;
      shown.add(line);
      lines.push(line, `        "${i.original}"`);
      if (i.suggestion) lines.push(`        → ${i.suggestion}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
