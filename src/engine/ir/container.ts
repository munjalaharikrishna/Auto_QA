/**
 * Named containers (UI-07): "the Backpack card", "the Order section". A step or a check that names one is about what is inside
 * that container and nothing else on the page. This is the one place that decides what such a phrase means, so the grammar that
 * reads it, the locator that scopes to it and the judge that checks inside it all agree.
 *
 * A container is named by its title: its `aria-label`, or the first heading of its own. A phrase ending in a word of a *repeated
 * widget* (card, tile, item, entry, listing) is always about one such widget, so it must be found: a card that is not on the page
 * is not a reason to look at the whole page. A phrase ending in an *area* word (section, panel, box, group) is scoped when such a
 * container is on the page, and read as before when none is (many applications show a section that no markup names).
 */

/** Widgets that repeat: several on a page look alike, and acting on or checking the wrong one is the risk. */
export const REPEATED_NOUNS: ReadonlySet<string> = new Set(['card', 'tile', 'item', 'entry', 'listing']);

/** Areas of a page that group things. */
export const AREA_NOUNS: ReadonlySet<string> = new Set(['section', 'panel', 'box', 'group', 'widget', 'area', 'block']);

const DETERMINERS: ReadonlySet<string> = new Set(['the', 'a', 'an']);

export interface ContainerRef {
  /** The name of the container, in words: "backpack" for "the 'Backpack' card". */
  text: string;
  words: string[];
  /** The kind of container the phrase ends with, when it does. */
  noun?: string;
  /** The phrase ends in a repeated-widget word: the container has to be found. */
  repeated: boolean;
}

/** The words of a text: lower case letters and digits, with quotes, punctuation and extra space gone. */
export function wordsOf(text: string): string[] {
  const out: string[] = [];
  let word = '';
  for (const c of text.toLowerCase()) {
    if (c.toLowerCase() !== c.toUpperCase() || (c >= '0' && c <= '9')) word += c;
    else if (word) {
      out.push(word);
      word = '';
    }
  }
  if (word) out.push(word);
  return out;
}

/** What a place phrase names, or undefined when it names no container ("the Personal Information page" is not one). */
export function containerRef(within: string | undefined): ContainerRef | undefined {
  if (!within) return undefined;
  const words = wordsOf(within);
  while (words.length && DETERMINERS.has(words[0] as string)) words.shift();
  const last = words[words.length - 1];
  if (last === undefined) return undefined;
  const noun = REPEATED_NOUNS.has(last) || AREA_NOUNS.has(last) ? last : undefined;
  if (!noun) return undefined;
  const core = words.slice(0, -1);
  // "list item" is one kind of container, not an item named "list".
  if (noun === 'item' && core[core.length - 1] === 'list') core.pop();
  if (!core.length) return undefined;
  return { text: core.join(' '), words: core, noun, repeated: REPEATED_NOUNS.has(noun) };
}

const holdsRun = (haystack: readonly string[], run: readonly string[]): boolean => {
  for (let i = 0; i + run.length <= haystack.length; i++) if (run.every((w, k) => haystack[i + k] === w)) return true;
  return false;
};

/**
 * The containers a phrase means, out of the ones on the page. A container whose title is the name is meant; only when there is none
 * is a container whose title holds the name ("Sauce Labs Backpack" for "the Backpack card"). Titles that tie are all returned: the
 * caller must treat more than one as ambiguous, never take the first.
 */
export function matchContainers<T extends { name: string }>(ref: ContainerRef, containers: readonly T[]): T[] {
  const exact = containers.filter((c) => wordsOf(c.name).join(' ') === ref.text);
  if (exact.length) return exact;
  return containers.filter((c) => holdsRun(wordsOf(c.name), ref.words));
}
