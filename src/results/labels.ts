import type { TestVerdict } from './verdict.js';

/**
 * E0.18 step 4: why a case needs review, in one word (owner, 7 Nov 2026: the five statuses stay, and NEEDS REVIEW carries a reason
 * label). Each is shown on the results and counted, and none is ever a PASS.
 */
export const REVIEW_LABELS = ['inconclusive', 'healed', 'chosen', 'flaky', 'not-found', 'hidden', 'ambiguous', 'wording'] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

/** What each label means, for the report, the results sheet and the guide. */
export const LABEL_MEANING: Record<ReviewLabel, string> = {
  inconclusive: 'it ran, but a check could not be proven or confirmed',
  healed: 'an element was found by what it was in an earlier run (its fingerprint)',
  chosen: 'the engine chose among alike elements, or made an assumption',
  flaky: 'it passed only when it was run again',
  'not-found': 'an element or a page is not there',
  hidden: 'the element is there, but hidden, disabled or covered',
  ambiguous: 'several elements or rows fit equally, and none was chosen',
  wording: 'a sentence of the test case needs a person to say what it means',
};

/** Words in a reason that say which label it is, the most specific first. Plain text, the reasons are the engine's own sentences. */
const SIGNS: Array<[ReviewLabel, readonly string[]]> = [
  ['flaky', ['passed only on retry', 'passed only when it was run again']],
  ['healed', ['found by what it was in an earlier run']],
  ['chosen', ['the first on the page was used', 'with assumptions', 'an assumption']],
  ['hidden', ['LOCATE_INACTIVE', 'cannot be used', 'hidden (', 'is disabled', 'covered by']],
  ['ambiguous', ['LOCATE_AMBIGUOUS', 'ROW_AMBIGUOUS', 'LOCATOR_NOT_UNIQUE', 'equal candidates', 'More than one element', 'fit about equally']],
  ['not-found', ['LOCATE_NOT_FOUND', 'ROW_NOT_FOUND', 'PAGE_UNKNOWN', 'could not find', 'nothing on the page is called', 'Nothing on this page looks like it']],
  [
    'wording',
    [
      'not understood',
      'ambiguous wording',
      'fits none of the grammar models',
      'unresolved reference',
      'unknown branch',
      'needs review before it can be automated',
      'reword',
      'Reword',
    ],
  ],
];

/**
 * The label of a verdict: the one set where the fact was known (a fingerprint, an alike choice, a retry, a PASS the shadow run did
 * not confirm), or the one its reason shows; `inconclusive` when it shows none. Only NEEDS REVIEW has a label.
 */
export function labelOf(v: TestVerdict): ReviewLabel | undefined {
  if (v.status !== 'NEEDS REVIEW') return undefined;
  if (v.label) return v.label;
  const text = [v.reason, v.failedStep ?? '', ...(v.review ?? []).flatMap((r) => [r.headline, r.why])].join(' ');
  for (const [label, signs] of SIGNS) if (signs.some((s) => text.includes(s))) return label;
  return 'inconclusive';
}

/** The verdicts with their label set: every NEEDS REVIEW has one, every other status none. */
export function withLabels(verdicts: readonly TestVerdict[]): TestVerdict[] {
  return verdicts.map((v) => {
    const label = labelOf(v);
    const { label: _old, ...rest } = v;
    return label ? { ...rest, label } : rest;
  });
}

/** How many of each label, in the order of `REVIEW_LABELS`, leaving out those with none. */
export function labelCounts(verdicts: readonly TestVerdict[]): Array<[ReviewLabel, number]> {
  return REVIEW_LABELS.map((l): [ReviewLabel, number] => [l, verdicts.filter((v) => labelOf(v) === l).length]).filter(([, n]) => n > 0);
}
