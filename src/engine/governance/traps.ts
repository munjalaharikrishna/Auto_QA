import { z } from 'zod';
import type { RawTestCase } from '../../model/test-model.js';
import { type CompileResult, compileCase } from '../pipeline/compile.js';

/**
 * The wrong-PASS traps (T5, PD-2): test cases whose correct reading is known by hand. A trap names the case (a row of a
 * workbook, or written out) and what the engine must make of it. They run with no browser, in `npm test`, so they run after
 * every change. A trap is never deleted: a wrong PASS found anywhere is added here first and then fixed.
 */

const Expected = z.object({
  type: z.string(),
  negated: z.boolean().optional(),
  expect: z.string().optional(),
  fresh: z.boolean().optional(),
});

export const TrapSchema = z.object({
  id: z.string().min(1),
  origin: z.string().min(1),
  case: z.union([
    z.object({ workbook: z.string().min(1), id: z.string().min(1) }),
    z.object({ steps: z.string().min(1), expected: z.string().min(1), testData: z.string().optional() }),
  ]),
  expect: z.object({
    /** The compile statuses that are right: a trap that must not be ready lists only `needs-review`. */
    status: z.array(z.enum(['compiled', 'needs-review', 'error'])).min(1),
    /** The checks, in order, exactly: a missing or an extra check is a difference. */
    expectations: z.array(Expected).optional(),
    /** The value of a field, by the field's name. */
    values: z.record(z.string(), z.object({ class: z.string().optional(), source: z.string().optional(), value: z.string().optional() })).optional(),
    /** Issue codes that must be among the issues. */
    issueCodes: z.array(z.string()).optional(),
  }),
});
export type Trap = z.infer<typeof TrapSchema>;

export const TrapFileSchema = z.object({ about: z.string(), traps: z.array(TrapSchema).min(1) }).superRefine((f, ctx) => {
  const seen = new Set<string>();
  for (const [i, t] of f.traps.entries()) {
    if (seen.has(t.id)) ctx.addIssue({ code: 'custom', path: ['traps', i, 'id'], message: `${t.id} is in the file twice` });
    seen.add(t.id);
  }
});

/** Finds the raw test case of a workbook row; the caller reads the workbook. */
export type CaseLookup = (workbook: string, id: string) => RawTestCase | undefined;

export interface TrapOutcome {
  id: string;
  ok: boolean;
  /** What differed, in words; empty when the trap holds. */
  problems: string[];
}

export async function runTrap(trap: Trap, lookup: CaseLookup): Promise<TrapOutcome> {
  const problems: string[] = [];
  const raw: RawTestCase | undefined =
    'workbook' in trap.case
      ? lookup(trap.case.workbook, trap.case.id)
      : { id: trap.id, title: trap.id, steps: trap.case.steps, expected: trap.case.expected, ...(trap.case.testData ? { testData: trap.case.testData } : {}) };
  if (!raw) return { id: trap.id, ok: false, problems: [`the case is not in the workbook: ${JSON.stringify(trap.case)}`] };
  const result: CompileResult = await compileCase(raw, { env: {} });
  const want = trap.expect;

  if (!want.status.includes(result.status)) problems.push(`status is ${result.status}, wanted ${want.status.join(' or ')}`);

  if (want.expectations) {
    const got = result.ir?.expectations ?? [];
    if (got.length !== want.expectations.length) problems.push(`${got.length} checks, wanted ${want.expectations.length}`);
    for (const [i, w] of want.expectations.entries()) {
      const g = got[i];
      if (!g) continue;
      const have = { type: g.condition.type, negated: g.negated, expect: g.condition.expect, fresh: g.condition.fresh };
      for (const k of ['type', 'negated', 'expect', 'fresh'] as const) {
        if (w[k] !== undefined && w[k] !== have[k]) problems.push(`check ${i + 1}: ${k} is ${String(have[k])}, wanted ${String(w[k])}`);
      }
    }
  }

  if (want.values) {
    const values = Object.values(result.values ?? {});
    for (const [field, w] of Object.entries(want.values)) {
      const v = values.find((x) => x.field === field);
      if (!v) {
        problems.push(`no value for "${field}"`);
        continue;
      }
      const text = typeof v.value === 'string' ? v.value : v.value.reveal();
      if (w.class !== undefined && w.class !== v.class) problems.push(`"${field}": class is ${v.class}, wanted ${w.class}`);
      if (w.source !== undefined && w.source !== v.source) problems.push(`"${field}": source is ${v.source}, wanted ${w.source}`);
      if (w.value !== undefined && w.value !== text) problems.push(`"${field}": the value is not the one the sheet gives`);
    }
  }

  for (const code of want.issueCodes ?? []) if (!result.issues.some((i) => i.code === code)) problems.push(`no ${code} issue`);
  return { id: trap.id, ok: problems.length === 0, problems };
}
