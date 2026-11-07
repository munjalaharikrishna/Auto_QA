import type { Page } from 'playwright';
import { containerRef } from '../ir/container.js';
import { scopeNames } from './containers.js';
import { prepareFrame, readSettled, sameFrame, visibleFrames } from './frames.js';
import { anchorFor, elementsInside, HOLDER_SELECTOR, type PageHolder, readHolders } from './holders.js';
import type { DomElement } from './types.js';

/**
 * E0.17 item 1, container anchors: "Click Edit in the Job section" is done inside the Job section and nowhere else. A page that marks
 * its sections (an `article`, a `section` with a heading, UI-07) is scoped by the locator itself. A page that does not (OrangeHRM 2.5
 * lays every section out as plain `div`s) is scoped here, by the part of the page whose title is the name (`anchorFor`).
 *
 * - One part has that title: only the elements inside it are candidates.
 * - Several separate parts have it: the step is not done, and says so (the engine does not choose a section).
 * - None has it: a repeated widget ("the Backpack card") must be found, so the locator keeps the name and reports it missing; an area
 *   ("the Employment section") is read as before, on the whole page, and the run says that it was.
 */
export type AnchorScope =
  | { status: 'unscoped' }
  | { status: 'scoped'; elements: DomElement[]; note: string }
  | { status: 'whole-page'; note: string }
  | { status: 'ambiguous'; why: string };

const keyOf = (frame: readonly string[], xpath: string): string => `${frame.join('>')}|${xpath}`;

/** For each element, how deep the closest ancestor it shares with another element is (-1 when one is gone). Runs in the page. */
export function sharedDepths(args: { from: string; xpaths: string[] }): number[] {
  const at = (xpath: string): Node | null => {
    try {
      return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch {
      return null;
    }
  };
  const depth = (n: Node): number => {
    let d = 0;
    for (let p = n.parentNode; p; p = p.parentNode) d++;
    return d;
  };
  const from = at(args.from);
  return args.xpaths.map((x) => {
    const el = at(x);
    if (!from || !el) return -1;
    let common: Node | null = el;
    while (common && !common.contains(from)) common = common.parentNode;
    return common ? depth(common) : -1;
  });
}

/**
 * Of controls that are alike, the one in the part of the page the case is working in (E0.17 item 3, owner, 6 Nov 2026): the one that
 * shares the deepest part of the page with the element the step before acted on. When two share it as deeply, or the element before is
 * in another frame or gone, there is no such one, and undefined is returned.
 */
export async function nearestTo(page: Page, last: { frame: readonly string[]; xpath: string }, alike: readonly DomElement[]): Promise<DomElement | undefined> {
  const same = alike.filter((e) => sameFrame(e.frame, last.frame));
  if (same.length < 2) return same.length === 1 && alike.length > 1 ? same[0] : undefined;
  const frame = (await visibleFrames(page)).find((f) => sameFrame(f.path, last.frame))?.frame;
  if (!frame) return undefined;
  await prepareFrame(frame);
  const depths = await frame.evaluate(sharedDepths, { from: last.xpath, xpaths: same.map((e) => e.xpath) }).catch(() => undefined);
  if (!depths) return undefined;
  const best = Math.max(...depths);
  if (best < 0 || depths.filter((d) => d === best).length !== 1) return undefined;
  return same[depths.indexOf(best)];
}

export async function anchorScope(page: Page, within: string | undefined, elements: readonly DomElement[]): Promise<AnchorScope> {
  const ref = containerRef(within);
  if (!within || !ref) return { status: 'unscoped' };
  // A container the page marks with a title is the locator's own (UI-07).
  const named = scopeNames(
    within,
    elements.flatMap((e) => e.containers ?? []),
  );
  if (named?.names.size) return { status: 'unscoped' };
  const holders: PageHolder[] = [];
  for (const { frame, path } of await visibleFrames(page)) {
    await prepareFrame(frame);
    const read = await readSettled(frame, () => frame.evaluate(readHolders, { selector: HOLDER_SELECTOR, limit: 600, minControls: 1 })).catch(() => undefined);
    if (read?.ok) holders.push(...read.value.map((h) => ({ ...h, frame: [...path] })));
  }
  const found = anchorFor(ref.text, holders);
  if (found.status === 'ambiguous') return { status: 'ambiguous', why: found.why };
  if (found.status === 'not-found')
    return ref.repeated
      ? { status: 'unscoped' }
      : { status: 'whole-page', note: `${found.why}: "${within}" is not on this page as a part of its own, so the whole page was searched` };
  const anchor = found.anchor;
  const candidates = elements.filter((e) => sameFrame(e.frame, anchor.frame));
  const frame = (await visibleFrames(page)).find((f) => sameFrame(f.path, anchor.frame))?.frame;
  if (!frame) return { status: 'whole-page', note: `the frame of "${within}" could not be read again, so the whole page was searched` };
  const inside = await frame.evaluate(elementsInside, { anchor: anchor.xpath, xpaths: candidates.map((e) => e.xpath) });
  const allowed = new Set(candidates.filter((_, i) => inside[i]).map((e) => keyOf(e.frame, e.xpath)));
  return {
    status: 'scoped',
    elements: elements.filter((e) => allowed.has(keyOf(e.frame, e.xpath))),
    note: `"${within}" is ${found.why}: only what is inside it was searched (${allowed.size} element(s))`,
  };
}
