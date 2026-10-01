import type { RunResult } from '../executor/runner.js';
import type { Status, TestVerdict } from './verdict.js';

/** Terminal report for a run (FR-HI-01, FR-HI-07 summary line). */

const MARK: Record<Status, string> = {
  PASS: '✔ PASS',
  FAIL: '✖ FAIL',
  BLOCKED: '■ BLOCKED',
  'NEEDS REVIEW': '? NEEDS REVIEW',
  'NOT VERIFIED': '○ NOT VERIFIED',
};
const STEP_MARK = { passed: '✔', failed: '✖', 'not run': '·', 'not checked': '?', 'not verified': '○' } as const;

export function formatVerdict(v: TestVerdict): string {
  const lines = [`━━ ${v.testId}  ${v.title}   ${MARK[v.status]}${v.category ? ` (${v.category})` : ''}   ${seconds(v.durationMs)}`];
  lines.push(`   ${v.reason}`);
  for (const s of v.steps) lines.push(`   ${STEP_MARK[s.result]} ${s.id.padEnd(4)} ${s.raw}`);
  for (const c of v.checks) {
    lines.push(`   ${STEP_MARK[c.result]} ${c.id.padEnd(4)} Expected: ${c.expected}`);
    if (c.actual) lines.push(`          Actual:   ${c.actual}`);
  }
  // Assertion and health check failures are already explained by the checks above.
  const explained = v.category === 'Assertion' || /Health check failed/.test(v.error ?? '');
  if (v.status !== 'PASS' && v.error && !explained) lines.push(`   Error: ${v.error.split('\n')[0]}`);
  for (const s of v.evidence.screenshots) lines.push(`   Screenshot: ${s}`);
  if (v.evidence.trace) lines.push(`   Trace: ${v.evidence.trace}  (npx playwright show-trace <file>)`);
  return lines.join('\n');
}

export function summaryLine(verdicts: TestVerdict[]): string {
  const count = (s: Status) => verdicts.filter((v) => v.status === s).length;
  return `${count('PASS')} pass · ${count('FAIL')} fail · ${count('BLOCKED')} blocked · ${count('NEEDS REVIEW')} need review · ${count('NOT VERIFIED')} not verified`;
}

export function formatRun(run: RunResult): string {
  return [...run.verdicts.map(formatVerdict), `${run.executionId}: ${summaryLine(run.verdicts)}   (${seconds(run.durationMs)})`, `Saved ${run.dir}`].join(
    '\n\n',
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
