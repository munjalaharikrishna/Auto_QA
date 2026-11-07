import { labelKey } from '../knowledge/labels.js';
import { accessibleName } from './candidates.js';
import type { DomElement } from './types.js';

/**
 * E0.17 item 5, fallback fingerprints. When a step finds an element, the run keeps what made it that element: the locators that were
 * unique on the page then, in the order people trust them, and its features (role, name, label, handler, container, the text next to
 * it). When a later run cannot find it by any level (its label or id changed), the fingerprint is compared with what is on the page.
 *
 * The fallback is narrow on purpose:
 *  - it is tried only to act on an element (click, type), never for a check: a check that passes on a guessed element proves nothing;
 *  - role and frame must be the same, and the element must be usable;
 *  - exactly one element may score at or above `MIN_SCORE`, and it must lead the next one by `MARGIN`;
 *  - what it finds is an assumption: the case cannot PASS until a person approves it (as the identical-element rule, item 3).
 */

export const MIN_SCORE = 0.6;
export const MARGIN = 0.15;

export type LocatorKind = 'testId' | 'id' | 'name' | 'role' | 'label' | 'placeholder' | 'xpath';

export interface Fingerprint {
  /** The locators that found only this element when it was kept, in the order people trust them (LC-01). */
  locators: Array<{ kind: LocatorKind; value: string }>;
  role: string;
  tag: string;
  type?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  htmlId?: string;
  nameAttr?: string;
  handler?: string;
  container?: string;
  form?: string;
  nearby?: string;
  xpath: string;
  frame: string[];
}

/** How much each feature says about an element: the ones a page keeps when its words change weigh most. */
const WEIGHTS = {
  testId: 3,
  htmlId: 2,
  nameAttr: 2,
  handler: 1.5,
  xpath: 1.5,
  label: 1,
  name: 1,
  placeholder: 1,
  nearby: 1,
  container: 1,
  form: 0.5,
  type: 0.5,
} as const;
type Feature = keyof typeof WEIGHTS;

const nameOf = (e: DomElement): string => accessibleName(e) || e.labels[0] || e.text || e.placeholder || '';

const featureValue = (e: DomElement, f: Feature): string | undefined => {
  switch (f) {
    case 'testId':
      return e.testId;
    case 'htmlId':
      return e.id;
    case 'nameAttr':
      return e.nameAttr;
    case 'handler':
      return e.handler;
    case 'xpath':
      return e.xpath;
    case 'label':
      return e.labels[0];
    case 'name':
      return nameOf(e) || undefined;
    case 'placeholder':
      return e.placeholder;
    case 'nearby':
      return e.nearbyText || undefined;
    case 'container':
      return e.containers?.[0];
    case 'form':
      return e.form;
    case 'type':
      return e.type;
  }
};

const LOCATORS: Array<{ kind: LocatorKind; of: (e: DomElement) => string | undefined }> = [
  { kind: 'testId', of: (e) => e.testId },
  { kind: 'id', of: (e) => e.id },
  { kind: 'name', of: (e) => e.nameAttr },
  { kind: 'role', of: (e) => (accessibleName(e) ? `${e.role}|${labelKey(accessibleName(e))}` : undefined) },
  { kind: 'label', of: (e) => (e.labels[0] ? labelKey(e.labels[0]) : undefined) },
  { kind: 'placeholder', of: (e) => (e.placeholder ? labelKey(e.placeholder) : undefined) },
  { kind: 'xpath', of: (e) => e.xpath },
];

/** What a run keeps of an element it found, with the locators that found only it on the page it was on. */
export function fingerprintOf(element: DomElement, page: readonly DomElement[]): Fingerprint {
  const locators: Fingerprint['locators'] = [];
  for (const { kind, of } of LOCATORS) {
    const value = of(element);
    if (!value) continue;
    if (page.filter((e) => of(e) === value && e.frame.join('>') === element.frame.join('>')).length === 1) locators.push({ kind, value });
  }
  const pick = (f: Feature) => featureValue(element, f);
  const fp: Fingerprint = { locators, role: element.role, tag: element.tag, xpath: element.xpath, frame: [...element.frame] };
  const keep = (key: Exclude<keyof Fingerprint, 'locators' | 'role' | 'tag' | 'xpath' | 'frame'>, f: Feature) => {
    const v = pick(f);
    if (v) fp[key] = v;
  };
  keep('type', 'type');
  keep('name', 'name');
  keep('label', 'label');
  keep('placeholder', 'placeholder');
  keep('testId', 'testId');
  keep('htmlId', 'htmlId');
  keep('nameAttr', 'nameAttr');
  keep('handler', 'handler');
  keep('container', 'container');
  keep('form', 'form');
  keep('nearby', 'nearby');
  return fp;
}

const KEPT: Record<Feature, keyof Fingerprint> = {
  testId: 'testId',
  htmlId: 'htmlId',
  nameAttr: 'nameAttr',
  handler: 'handler',
  xpath: 'xpath',
  label: 'label',
  name: 'name',
  placeholder: 'placeholder',
  nearby: 'nearby',
  container: 'container',
  form: 'form',
  type: 'type',
};

/** How much of a fingerprint an element still has: the weight of the features that are the same, over the weight of those kept. */
export function scoreOf(fp: Fingerprint, e: DomElement): number {
  if (e.role !== fp.role || e.tag !== fp.tag || e.frame.join('>') !== fp.frame.join('>')) return 0;
  let total = 0;
  let same = 0;
  for (const f of Object.keys(WEIGHTS) as Feature[]) {
    const kept = fp[KEPT[f]];
    if (typeof kept !== 'string' || !kept) continue;
    total += WEIGHTS[f];
    const now = featureValue(e, f);
    if (now !== undefined && (f === 'xpath' || f === 'handler' ? now === kept : labelKey(now) === labelKey(kept))) same += WEIGHTS[f];
  }
  return total ? Math.round((same / total) * 100) / 100 : 0;
}

export type FingerprintMatch = { status: 'found'; element: DomElement; score: number; via?: LocatorKind; why: string } | { status: 'none'; why: string };

/**
 * The one usable element of the page that still has the fingerprint (E0.17 item 5), or none. A kept locator that finds one element is
 * named in the reason, but it does not decide alone: the element must also score above the minimum and lead the next one.
 */
export function matchFingerprint(fp: Fingerprint, page: readonly DomElement[]): FingerprintMatch {
  const usable = page.filter((e) => e.visible && !e.disabled && !e.covered);
  const scored = usable.map((element) => ({ element, score: scoreOf(fp, element) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const next = scored[1]?.score ?? 0;
  if (!best || best.score < MIN_SCORE)
    return { status: 'none', why: `no element on the page has enough of what it was (best ${best?.score ?? 0}, at least ${MIN_SCORE} needed)` };
  const above = scored.filter((s) => s.score >= MIN_SCORE).length;
  if (above > 1) return { status: 'none', why: `${above} elements have enough of what it was (${best.score} and ${next}): the engine does not choose` };
  if (best.score - next < MARGIN) return { status: 'none', why: `the best (${best.score}) is too close to the next (${next})` };
  const via = fp.locators.find((l) => {
    const of = LOCATORS.find((x) => x.kind === l.kind)?.of;
    return of && usable.filter((e) => of(e) === l.value).length === 1 && of(best.element) === l.value;
  })?.kind;
  return {
    status: 'found',
    element: best.element,
    score: best.score,
    ...(via ? { via } : {}),
    why: `found by what it was in an earlier run (score ${best.score}${via ? `, its ${via} is the same` : ''})`,
  };
}
