import { readFileSync } from 'node:fs';
import type { RunTrace } from '../execute/executor.js';
import { fingerprintOf, type LearningBook } from './learn.js';
import type { Verdict } from './verdict.js';

/**
 * Layer 53, the user review card (VD-11, DEC-05). When the engine cannot prove an expectation it does not guess: it shows
 * what was expected, what the page showed, and the pictures before and after, and a person clicks PASS or FAIL. The click
 * is stored with who and when and the verdict is marked "decided by user"; the engine's own verdict and the evidence stay
 * as they were. Cases that share one cause are one card, so a person decides once. A decision with a message on the
 * page is learned (BP-4), so the next run of the same case needs no review for it.
 */

export interface ReviewCard {
  /** The same for every case that shares the cause. */
  id: string;
  cause: string;
  expected: string;
  actual: string;
  why: string;
  /** The test cases the card covers. */
  cases: string[];
  /** The tester's words the card is about. */
  clause: string;
  step?: string;
  evidence: { before?: string; after?: string; changes: string[] };
  /** The message that was on the page, when there was one: what a decision is learned from. */
  message?: string;
  decision?: { decision: 'PASS' | 'FAIL'; who: string; when: string; note?: string };
}

export interface Reviewed {
  verdict: Verdict;
  trace?: RunTrace;
}

/** The cards for the runs that need a person, one card for each cause (VD-11). */
export function buildCards(runs: readonly Reviewed[]): ReviewCard[] {
  const cards = new Map<string, ReviewCard>();
  for (const { verdict, trace } of runs) {
    if (verdict.verdict !== 'NEEDS_REVIEW' || verdict.decidedByUser) continue;
    const ev = verdict.evaluations.find((e) => e.result === 'unproven');
    const cause = verdict.reviewCause ?? verdict.reason;
    const key = fingerprintOf(cause, '');
    const existing = cards.get(key);
    if (existing) {
      if (!existing.cases.includes(verdict.testId)) existing.cases.push(verdict.testId);
      continue;
    }
    const record = trace?.steps.find((s) => s.step === ev?.step) ?? trace?.steps.at(-1);
    const page = record?.after;
    const message = page ? [...page.messages, ...page.fieldErrors.map((f) => f.message)].find((m) => !(record?.before?.messages ?? []).includes(m)) : undefined;
    cards.set(key, {
      id: key,
      cause,
      expected: ev?.expected ?? verdict.reason,
      actual: ev?.actual ?? 'the run stopped before the page could be read',
      why: ev?.why ?? verdict.reason,
      cases: [verdict.testId],
      clause: ev?.clause ?? '',
      ...(ev?.step ? { step: ev.step } : {}),
      evidence: {
        ...(record?.screenshots?.before ? { before: record.screenshots.before } : {}),
        ...(record?.screenshots?.after ? { after: record.screenshots.after } : {}),
        changes: record?.changes ?? [],
      },
      ...(message ? { message } : {}),
    });
  }
  return [...cards.values()];
}

export interface Click {
  decision: 'PASS' | 'FAIL';
  who: string;
  note?: string;
  when?: string;
}

/**
 * Applies a person's click to every case of a card. A decision never changes the evidence: the engine's verdict is kept
 * as `engineVerdict`. The decision is remembered in the learning book when one is given.
 */
export function decide(card: ReviewCard, verdicts: readonly Verdict[], click: Click, book?: LearningBook): Verdict[] {
  const when = click.when ?? new Date().toISOString();
  if (book) {
    for (const testId of card.cases) {
      book.decide({
        fingerprint: fingerprintOf(card.clause, card.actual),
        testId,
        clause: card.clause,
        decision: click.decision,
        who: click.who,
        when,
        ...(click.note ? { note: click.note } : {}),
        ...(card.message ? { message: card.message } : {}),
      });
    }
  }
  return verdicts.map((v) =>
    card.cases.includes(v.testId) && v.verdict === 'NEEDS_REVIEW'
      ? {
          ...v,
          engineVerdict: v.verdict,
          verdict: click.decision,
          ...(click.decision === 'FAIL' ? { rootCause: 'APPLICATION' as const } : {}),
          reason: `decided by user: ${click.decision}`,
          decidedByUser: { who: click.who, when, ...(click.note ? { note: click.note } : {}), remembered: false },
        }
      : v,
  );
}

const esc = (s: string): string => s.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
const inline = (file?: string): string => {
  if (!file) return '<em>no picture</em>';
  try {
    return `<img alt="screenshot" src="data:image/png;base64,${readFileSync(file).toString('base64')}">`;
  } catch {
    return '<em>no picture</em>';
  }
};

/** The card as one self-contained page: expected, actual, the two pictures and the PASS and FAIL buttons. */
export function renderCardHtml(card: ReviewCard): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Review ${esc(card.id)}</title>
<style>body{font:15px system-ui;margin:24px;max-width:1000px}.row{display:flex;gap:16px}.row>div{flex:1}img{max-width:100%;border:1px solid #ccc}
h2{margin:.2em 0}.exp{background:#eef6ee;padding:8px}.act{background:#fbeeee;padding:8px}button{font-size:16px;padding:8px 20px;margin-right:8px}</style>
<h2>Needs your decision</h2><p>${esc(card.why)}</p>
<p>Covers ${card.cases.length} test case(s): ${card.cases.map(esc).join(', ')}</p>
<div class="row"><div class="exp"><b>Expected</b><br>${esc(card.expected)}</div><div class="act"><b>Actual</b><br>${esc(card.actual)}</div></div>
<div class="row"><div><b>Before</b><br>${inline(card.evidence.before)}</div><div><b>After</b><br>${inline(card.evidence.after)}</div></div>
<ul>${card.evidence.changes
    .slice(0, 12)
    .map((c) => `<li>${esc(c)}</li>`)
    .join('')}</ul>
<p><button data-decision="PASS" data-card="${esc(card.id)}">PASS</button><button data-decision="FAIL" data-card="${esc(card.id)}">FAIL</button></p></html>`;
}

/** The card as text, for the terminal. */
export function renderCard(card: ReviewCard): string {
  const lines = [`Review ${card.id}: ${card.why}`, `  covers: ${card.cases.join(', ')}`, `  expected: ${card.expected}`, `  actual:   ${card.actual}`];
  if (card.evidence.before) lines.push(`  before: ${card.evidence.before}`);
  if (card.evidence.after) lines.push(`  after:  ${card.evidence.after}`);
  for (const c of card.evidence.changes.slice(0, 8)) lines.push(`    ${c}`);
  return lines.join('\n');
}
