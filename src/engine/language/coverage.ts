import type { CaseLanguage } from './case.js';
import { CATEGORY } from './preflight.js';
import type { GrammarModel, Issue } from './types.js';

/**
 * The coverage report (the start of GV-07) and the progress measurement (T6, BP-2): how much of the real text the
 * engine understands, in which categories, and what the review reasons are, ranked. After each version the numbers are
 * recorded and compared with the one before, so the next work is chosen from the top reasons, not from a guess.
 */

export interface Rate {
  understood: number;
  total: number;
}

export interface Coverage {
  testCases: number;
  steps: Rate;
  expectations: Rate;
  /** Understood and total for each kind of step and check (a sentence counts in every category it produced). */
  byCategory: Record<string, Rate>;
  models: Partial<Record<GrammarModel, number>>;
  /** Test cases with nothing to review (ready) and nothing blocking (can be compiled). */
  ready: number;
  withDocument: number;
  /** The reasons that sent test cases to review, most frequent first. */
  topReasons: Array<{ reason: string; count: number }>;
}

/** An issue's message with the tester's own words (inside quotes) taken out, so the same reason groups together. */
export function reasonOf(issue: Pick<Issue, 'code' | 'message'>): string {
  const parts = issue.message.split('"');
  const text = parts.map((p, i) => (i % 2 === 1 ? '…' : p)).join('"');
  return `${CATEGORY[issue.code]}: ${text}`;
}

const rate = (): Rate => ({ understood: 0, total: 0 });

export function coverageOf(cases: readonly CaseLanguage[], top = 10): Coverage {
  const steps = rate();
  const expectations = rate();
  const byCategory: Record<string, Rate> = {};
  const models: Coverage['models'] = {};
  const reasons = new Map<string, number>();
  for (const c of cases) {
    for (const u of c.units) {
      const r = u.kind === 'step' ? steps : expectations;
      r.total++;
      if (u.understood) r.understood++;
      const cats = u.understood ? u.categories : ['(not understood)'];
      for (const cat of cats) {
        const slot = (byCategory[cat] ??= rate());
        slot.total++;
        if (u.understood) slot.understood++;
      }
    }
    for (const [m, n] of Object.entries(c.models)) models[m as GrammarModel] = (models[m as GrammarModel] ?? 0) + (n ?? 0);
    for (const i of c.issues) if (i.severity !== 'info') reasons.set(reasonOf(i), (reasons.get(reasonOf(i)) ?? 0) + 1);
  }
  return {
    testCases: cases.length,
    steps,
    expectations,
    byCategory: Object.fromEntries(Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))),
    models,
    ready: cases.filter((c) => !c.issues.some((i) => i.severity !== 'info')).length,
    withDocument: cases.filter((c) => c.ir).length,
    topReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([reason, count]) => ({ reason, count })),
  };
}

const pct = (r: Rate): string => (r.total ? `${Math.round((100 * r.understood) / r.total)}%` : '–');

export function coverageText(label: string, c: Coverage): string {
  const lines = [
    `Coverage: ${label}`,
    `  test cases           ${c.testCases}  (QA-IR built for ${c.withDocument}; nothing to review in ${c.ready})`,
    `  steps understood     ${c.steps.understood}/${c.steps.total}  ${pct(c.steps)}`,
    `  checks understood    ${c.expectations.understood}/${c.expectations.total}  ${pct(c.expectations)}`,
    '  by category:',
    ...Object.entries(c.byCategory).map(([cat, r]) => `    ${cat.padEnd(16)} ${String(r.understood).padStart(4)}/${String(r.total).padEnd(4)} ${pct(r)}`),
    `  grammar models used  ${Object.entries(c.models)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, n]) => `${m}×${n}`)
      .join(' ')}`,
    '  top review reasons:',
    ...c.topReasons.map((r) => `    ${String(r.count).padStart(4)}  ${r.reason}`),
  ];
  return lines.join('\n');
}
