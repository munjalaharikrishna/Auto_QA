/**
 * The project's confidence policy (D30, REAL-WORLD-TEST-CASES.md §6): how much the platform may decide on its own.
 *
 * - strict:   anything unclear, made up or learned is asked about, so the test case waits.
 * - balanced: the default. An unclear *check* never blocks: it runs and is reported NOT VERIFIED. Made-up values and
 *             messages learned from the application are used, marked as assumed or learned.
 * - lenient:  balanced, and of two equally good elements the first is used, marked as assumed.
 */
export const POLICIES = ['strict', 'balanced', 'lenient'] as const;
export type Policy = (typeof POLICIES)[number];
export const DEFAULT_POLICY: Policy = 'balanced';

export function isPolicy(value: unknown): value is Policy {
  return typeof value === 'string' && (POLICIES as readonly string[]).includes(value);
}
