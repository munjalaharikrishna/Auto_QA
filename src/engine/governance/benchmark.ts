import { z } from 'zod';
import { VERDICTS, type VerdictName } from '../verdict/verdict.js';

/**
 * The regression benchmark (GV-06) and the wrong-PASS KPI (GV-09). The answer key is a file of test cases with the verdict a
 * person worked out by hand; a run gives the verdict the engine reached for each. The runner compares the two. A wrong PASS is
 * a PASS where the key says anything else: it is the most dangerous mistake, its target is 0, and any one fails the build.
 * The key starts with the 29 OrangeHRM cases and is filled in at E1.0; this is its format and the runner.
 */

/** Where a wrong PASS came from, so the fix goes to the right layer (GV-09). */
export const PASS_SOURCES = ['parser', 'locator', 'assertion', 'evidence', 'recovery', 'unknown'] as const;
export type PassSource = (typeof PASS_SOURCES)[number];

export const AnswerKeySchema = z
  .object({
    /** Who checked the key by hand, and when: a key nobody checked is not a key. */
    checkedBy: z.string().min(1),
    checkedOn: z.string().min(1),
    cases: z
      .array(
        z.object({
          id: z.string().min(1),
          /** The workbook or module the case belongs to: results are shown for each. */
          module: z.string().min(1),
          expected: z.enum(VERDICTS),
          /** A known tricky case (a trap, T5): kept so the wrong PASS it once caused cannot come back. */
          trap: z.string().optional(),
        }),
      )
      .min(1),
  })
  .superRefine((k, ctx) => {
    const seen = new Set<string>();
    for (const [i, c] of k.cases.entries()) {
      const id = `${c.module}/${c.id}`;
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'id'], message: `${id} is in the key twice` });
      seen.add(id);
    }
  });
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

export interface BenchmarkResult {
  id: string;
  module: string;
  verdict: VerdictName;
  /** For a PASS: which layer proved it. Unknown when the run did not say. */
  source?: PassSource;
}

export interface CaseOutcome {
  id: string;
  module: string;
  expected: VerdictName;
  actual?: VerdictName;
  status: 'match' | 'mismatch' | 'wrong-pass' | 'not-run';
  trap?: string;
  source?: PassSource;
}

export interface BenchmarkReport {
  outcomes: CaseOutcome[];
  matched: number;
  mismatched: number;
  notRun: number;
  wrongPass: number;
  wrongPassBySource: Record<PassSource, number>;
  /** Results that are not in the key: they cannot be judged, and are listed instead of ignored. */
  notInKey: string[];
  byModule: Record<string, { cases: number; matched: number; wrongPass: number }>;
  /** The build passes only with no wrong PASS (GV-09). */
  ok: boolean;
}

export function runBenchmark(key: AnswerKey, results: readonly BenchmarkResult[]): BenchmarkReport {
  const byId = new Map(results.map((r) => [`${r.module}/${r.id}`, r]));
  const wrongPassBySource = Object.fromEntries(PASS_SOURCES.map((s) => [s, 0])) as Record<PassSource, number>;
  const byModule: BenchmarkReport['byModule'] = {};
  const outcomes: CaseOutcome[] = [];
  for (const c of key.cases) {
    const r = byId.get(`${c.module}/${c.id}`);
    const m = (byModule[c.module] ??= { cases: 0, matched: 0, wrongPass: 0 });
    m.cases++;
    const base = { id: c.id, module: c.module, expected: c.expected, ...(c.trap ? { trap: c.trap } : {}) };
    if (!r) {
      outcomes.push({ ...base, status: 'not-run' });
    } else if (r.verdict === c.expected) {
      m.matched++;
      outcomes.push({ ...base, actual: r.verdict, status: 'match' });
    } else if (r.verdict === 'PASS') {
      m.wrongPass++;
      wrongPassBySource[r.source ?? 'unknown']++;
      outcomes.push({ ...base, actual: r.verdict, status: 'wrong-pass', source: r.source ?? 'unknown' });
    } else {
      outcomes.push({ ...base, actual: r.verdict, status: 'mismatch' });
    }
  }
  const inKey = new Set(key.cases.map((c) => `${c.module}/${c.id}`));
  const count = (s: CaseOutcome['status']): number => outcomes.filter((o) => o.status === s).length;
  const wrongPass = count('wrong-pass');
  return {
    outcomes,
    matched: count('match'),
    mismatched: count('mismatch'),
    notRun: count('not-run'),
    wrongPass,
    wrongPassBySource,
    notInKey: [...byId.keys()].filter((k) => !inKey.has(k)),
    byModule,
    ok: wrongPass === 0,
  };
}

export function benchmarkText(r: BenchmarkReport): string {
  const lines = [
    `Benchmark: ${r.matched} matched, ${r.mismatched} different, ${r.notRun} not run, ${r.wrongPass} wrong PASS (target 0) - ${r.ok ? 'OK' : 'FAILED'}`,
  ];
  for (const [m, x] of Object.entries(r.byModule)) lines.push(`  ${m}: ${x.matched} of ${x.cases} matched, ${x.wrongPass} wrong PASS`);
  if (r.wrongPass) {
    lines.push(
      `  wrong PASS by source: ${PASS_SOURCES.filter((s) => r.wrongPassBySource[s])
        .map((s) => `${s} ${r.wrongPassBySource[s]}`)
        .join(', ')}`,
    );
  }
  for (const o of r.outcomes.filter((x) => x.status === 'wrong-pass' || x.status === 'mismatch')) {
    lines.push(
      `  ${o.status === 'wrong-pass' ? 'WRONG PASS' : 'different'} ${o.module}/${o.id}: expected ${o.expected}, got ${o.actual}${o.trap ? ` (trap: ${o.trap})` : ''}`,
    );
  }
  if (r.notInKey.length) lines.push(`  not in the key: ${r.notInKey.join(', ')}`);
  return lines.join('\n');
}
