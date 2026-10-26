import type { Status, TestVerdict } from '../results/verdict.js';

/**
 * Compare mode: the same workbook through the legacy engine and through the new engine, one row per test case.
 * Nothing here runs anything. It turns two sets of verdicts into a table, and says for each case whether the engines agree.
 * The legacy result stays the official one; the new engine is only observed.
 */

export type OutcomeStatus = Status | 'NOT RUN';

export interface EngineOutcome {
  status: OutcomeStatus;
  /** One line: why this engine gave that status. */
  reason: string;
}

/**
 * - `same`: both gave the same status.
 * - `conflict`: both decided, and decided differently (a PASS against a FAIL is the one to look at first).
 * - `new decides`: the legacy engine set the case aside for a person and the new engine gave an answer.
 * - `legacy decides`: the new engine set the case aside and the legacy engine gave an answer.
 * - `new not run`: the new engine did not run the case at all (it did not understand it, or the verdict engine cannot judge a check of it).
 */
export type Agreement = 'same' | 'conflict' | 'new decides' | 'legacy decides' | 'new not run';

export interface CompareRow {
  testId: string;
  title: string;
  legacy: EngineOutcome;
  next: EngineOutcome;
  /** What compiling the case gave the new engine: `compiled`, `needs-review` or `error`, and the pre-flight answer. */
  compile: string;
  agreement: Agreement;
  /** What each engine could not understand or decide, one line per sentence: where it is, the words, and what is wrong. */
  legacyIssues: string[];
  newIssues: string[];
}

/** An answer, as opposed to "a person has to look". BLOCKED is an answer about the environment, so it counts. */
const decided = (s: OutcomeStatus): boolean => s !== 'NEEDS REVIEW' && s !== 'NOT RUN';

export function agreementOf(legacy: OutcomeStatus, next: OutcomeStatus): Agreement {
  if (next === 'NOT RUN') return 'new not run';
  if (legacy === next) return 'same';
  if (decided(legacy) && decided(next)) return 'conflict';
  if (!decided(legacy) && decided(next)) return 'new decides';
  return 'legacy decides';
}

/** A verdict as an outcome. A case with no verdict at all was not run by that engine. */
export function outcomeOf(verdict: TestVerdict | undefined, whenMissing: string): EngineOutcome {
  if (!verdict) return { status: 'NOT RUN', reason: whenMissing };
  return { status: verdict.status, reason: verdict.reason };
}

export function compareRow(input: {
  testId: string;
  title: string;
  legacy: TestVerdict | undefined;
  next: TestVerdict | undefined;
  /** Why the new engine did not run the case, when there is no verdict from it. */
  notRun?: string;
  compile: string;
  legacyIssues?: string[];
  newIssues?: string[];
}): CompareRow {
  // A case the legacy engine gave no verdict for was set aside before it could be judged.
  const legacy: EngineOutcome = input.legacy ? outcomeOf(input.legacy, '') : { status: 'NEEDS REVIEW', reason: 'no verdict' };
  const next = outcomeOf(input.next, input.notRun ?? 'not run');
  return {
    testId: input.testId,
    title: input.title,
    legacy,
    next,
    compile: input.compile,
    agreement: agreementOf(legacy.status, next.status),
    legacyIssues: input.legacyIssues ?? [],
    newIssues: input.newIssues ?? [],
  };
}

const cell = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim().replace(/\|/g, '/');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const tally = (statuses: OutcomeStatus[]): string => {
  const counts = new Map<OutcomeStatus, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return (['PASS', 'FAIL', 'BLOCKED', 'NEEDS REVIEW', 'NOT VERIFIED', 'NOT RUN'] as const)
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(' · ');
};

/** The comparison as a Markdown table, with the totals of each engine and how often they agree. */
export function compareTable(rows: CompareRow[], heading = 'Legacy engine against the new engine'): string {
  const lines = [
    `# ${heading}`,
    '',
    '| Case | Title | Legacy | Why (legacy) | New engine | Why (new engine) | Compiled | Not understood (legacy / new) | Agreement |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.testId} | ${cell(r.title, 42)} | ${r.legacy.status} | ${cell(r.legacy.reason, 110)} | ${r.next.status} | ${cell(r.next.reason, 110)} | ${r.compile} | ${r.legacyIssues.length} / ${r.newIssues.length} | ${r.agreement} |`,
    ),
    '',
    `Legacy: ${tally(rows.map((r) => r.legacy.status))}`,
    `New engine: ${tally(rows.map((r) => r.next.status))}`,
  ];
  const agreement = new Map<Agreement, number>();
  for (const r of rows) agreement.set(r.agreement, (agreement.get(r.agreement) ?? 0) + 1);
  lines.push(`Agreement: ${[...agreement].map(([a, n]) => `${n} ${a}`).join(' · ')}`);
  // What each engine could not understand, sentence by sentence: this is where the two readings can be compared.
  for (const r of rows) {
    if (!r.legacyIssues.length && !r.newIssues.length) continue;
    lines.push('', `## ${r.testId}: ${cell(r.title, 80)}`, '', `Legacy (${r.legacyIssues.length}):`);
    lines.push(...(r.legacyIssues.length ? r.legacyIssues.map((i) => `- ${cell(i, 200)}`) : ['- nothing']));
    lines.push('', `New engine (${r.newIssues.length}):`);
    lines.push(...(r.newIssues.length ? r.newIssues.map((i) => `- ${cell(i, 200)}`) : ['- nothing']));
  }
  return `${lines.join('\n')}\n`;
}
