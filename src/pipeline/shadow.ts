import type { ReviewReason, TestVerdict } from '../results/verdict.js';

/**
 * Shadow mode (S6, U1). Two engines read every test case, and only one of them used to be asked for the result: a PASS from
 * the legacy route was never checked by the verdict engine's rules (fresh evidence, no vacuous check). Now a legacy PASS of a
 * case the verdict engine can judge stands only when the new engine, running the case itself, also says PASS. Anything else
 * is set aside for a person with both answers. A FAIL or a stop of the legacy route is not touched: it already goes to a person.
 */
export function reconcile(legacy: TestVerdict, shadow: TestVerdict | undefined): TestVerdict {
  if (legacy.status !== 'PASS' || !shadow || shadow.status === 'PASS') return legacy;
  const disagrees = shadow.status === 'FAIL';
  const why = disagrees
    ? `The old engine passed every check, but the new engine ran the same steps and found a check failing: ${shadow.actual || shadow.reason}`
    : `The old engine passed every check, but the new engine, which also judges whether each check was proven by this run, could not confirm it (${shadow.status}): ${shadow.reason}`;
  const reason: ReviewReason = {
    id: '',
    raw: '',
    headline: disagrees ? 'The two engines disagree: one says PASS, the other FAIL.' : 'A PASS the second engine could not confirm.',
    why,
    todo: [
      'Look at the screenshots of the steps in the report and decide PASS or FAIL on the review card.',
      ...(disagrees ? [] : ['If the check is worded loosely, rewrite the expected result as something the page shows, for example: Error "…" is shown.']),
    ],
  };
  return {
    ...legacy,
    status: 'NEEDS REVIEW',
    category: undefined,
    reason: `${disagrees ? 'The two engines disagree' : 'The new engine could not confirm the PASS'}. ${why}`,
    review: [...(legacy.review ?? []), reason],
  };
}
