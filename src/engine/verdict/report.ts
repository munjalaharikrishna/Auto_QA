import type { Verdict } from './verdict.js';

/** A verdict as text: the verdict, its reason, what was proven and not, and the twelve answers of the terminal verification (GV-16). */
export function renderVerdict(v: Verdict): string {
  const lines = [
    `${v.testId}: ${v.verdict}${v.rootCause ? ` (${v.rootCause})` : ''}${v.decidedByUser ? ` - decided by user ${v.decidedByUser.who}, ${v.decidedByUser.when}${v.decidedByUser.remembered ? ' (remembered)' : ''}` : ''}`,
    `  ${v.reason}`,
  ];
  for (const e of v.evaluations) lines.push(`  ${e.expectation} ${e.result}${e.doubt ? ` (${e.doubt})` : ''}: expected ${e.expected}; ${e.actual}`);
  for (const a of v.verification) lines.push(`  ${String(a.n).padStart(2)}. ${a.question} ${a.answer}${a.answer === 'not reached' ? '' : ` - ${a.detail}`}`);
  return lines.join('\n');
}
