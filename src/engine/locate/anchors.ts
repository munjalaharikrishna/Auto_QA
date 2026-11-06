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
