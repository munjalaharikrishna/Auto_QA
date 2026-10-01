import type { TestModel } from '../model/test-model.js';

export { DEFAULT_POLICY, isPolicy, POLICIES, type Policy } from '../model/policy.js';

/**
 * A check no pattern understands, or that is too general ("handles the whitespace according to the rules"), cannot
 * block the test: the steps still run, the other checks are verified, and this one is reported NOT VERIFIED with what
 * was seen (M7). An unreadable *step* still blocks, because the next steps depend on it.
 */
export function observeUnclearChecks(model: TestModel): TestModel {
  const convertible = new Set(['VAGUE_CHECK', 'NO_PATTERN']);
  const ids = new Set(model.assertions.filter((a) => a.status === 'unparsed' && convertible.has(a.reason?.code ?? '')).map((a) => a.id));
  if (!ids.size) return model;
  return {
    ...model,
    assertions: model.assertions.map((a) =>
      ids.has(a.id) ? { ...a, type: 'observe' as const, status: 'parsed' as const, intent: 'UNVERIFIABLE', expected: a.reason?.text, reason: undefined } : a,
    ),
    warnings: model.warnings.flatMap((w) =>
      w.code === 'UNPARSED' && w.at && ids.has(w.at)
        ? [
            {
              at: w.at,
              code: 'NOT_VERIFIABLE',
              text: 'This check cannot be verified from the page. The test runs and the check is reported NOT VERIFIED, with what was seen.',
            },
          ]
        : [w],
    ),
  };
}
