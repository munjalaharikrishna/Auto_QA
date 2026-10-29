import { containerRef, matchContainers } from '../ir/container.js';

/**
 * What the page marks as a named container (UI-07). A container is an element that groups things and has a title: an `article`, a list
 * item, a section, a fieldset, or anything given the matching ARIA role, whose title is its `aria-label`, what `aria-labelledby`
 * points at, or the first heading that is its own (not one of a container inside it). A box of the page with no such markup is not a
 * container: the engine does not guess at a card from how it looks. These are passed to the code that runs in the page, so the
 * inspector and the observation read the same containers.
 */

export const CONTAINER_SELECTOR = 'article, li, section, fieldset, details, aside, [role="article"], [role="listitem"], [role="group"], [role="region"]';
export const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"], legend, summary';

/** The names of the containers on a page that a phrase means, or undefined when the phrase names none. */
export function scopeNames(within: string | undefined, onPage: Iterable<string>): { repeated: boolean; names: Set<string> } | undefined {
  const ref = containerRef(within);
  if (!ref) return undefined;
  const distinct = [...new Set(onPage)].map((name) => ({ name }));
  return { repeated: ref.repeated, names: new Set(matchContainers(ref, distinct).map((c) => c.name)) };
}
