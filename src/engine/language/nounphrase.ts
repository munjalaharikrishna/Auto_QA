import type { IrTarget } from '../ir/schema.js';
import type { Token } from '../text/index.js';
import { headNounOf, refineField } from './ontology.js';
import { isSymbol, type Line, lw, originalOf } from './view.js';

/**
 * What a step or a check talks about. A noun phrase such as "the 'Login' button", "Login Name text box" or "tabs of
 * Admin, PIM and Leave" is read into targets of the ontology (ON-01): the head noun gives the class, the words before
 * it give the name as the tester wrote it. Nothing here looks at a page.
 */

/** Words that open a noun phrase and are not part of the name. */
const DETERMINERS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'these',
  'those',
  'its',
  'their',
  'his',
  'her',
  'both',
  'each',
  'every',
  'all',
  'any',
  'some',
  'respective',
  'appropriate',
  'actual',
  'corresponding',
  'preferred',
  'required',
]);

/** Prepositions after which the words say where a thing is, not what it is. */
const PLACE_WORDS: ReadonlySet<string> = new Set(['of', 'in', 'on', 'under', 'at', 'from', 'within', 'inside', 'near', 'below', 'above', 'beside', 'for']);

/** Words that point at something said or done earlier: the engine does not guess what (RF-01, resolved in E0.5). */
const REFERENCE_WORDS: ReadonlySet<string> = new Set([
  'same',
  'above',
  'below',
  'previous',
  'corresponding',
  'associated',
  'newly',
  'entered',
  'uploaded',
  'added',
  'updated',
]);
const PRONOUNS: ReadonlySet<string> = new Set(['it', 'them', 'this', 'that', 'these', 'those']);

export interface NounPhrase {
  /** The word in the phrase that refers to something earlier ("same", "entered"). */
  reference?: string;
  /** Words cut off the end that are not understood ("as a default page"): they are not checked. */
  dropped?: string;
  /** One target for each thing named: "username and password fields" gives two. */
  targets: IrTarget[];
  /** The class of the head noun when the phrase had one ("button", "text box"). */
  headClass?: string;
  plural: boolean;
  /** Where the tester says it is: "in the Employee section". */
  within?: string;
  /** The tester's own words. */
  original: string;
  /** The words left after taking the determiners off, lower case. */
  words: string[];
  /** The tokens of each target's own name, parallel to `targets`. */
  itemTokens: Token[][];
}

const strip = (tokens: readonly Token[]): Token[] => {
  let i = 0;
  while (i < tokens.length && DETERMINERS.has(lw(tokens[i]))) i++;
  return tokens.slice(i);
};

/** Splits a run of tokens at commas and the word `and`. */
function splitList(tokens: readonly Token[]): Token[][] {
  const items: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (isSymbol(t, ',') || lw(t) === 'and') {
      if (cur.length) items.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) items.push(cur);
  return items;
}

/** A name that is a username or a password is that field, whatever the phrase did not say about it. */
const defaultTarget = (name: string | undefined, cls: string): IrTarget => {
  const refined = name && (cls === 'Field' || cls === 'Element') ? refineField(name) : cls;
  // "Field" is what refineField says about every other name: it must not turn a generic element into a field.
  return { ontology: refined === 'Field' && cls === 'Element' ? cls : refined, ...(name ? { name } : {}) };
};

/**
 * Reads the tokens of a noun phrase. `fallbackClass` is the class to use when the phrase has no head noun ("Click
 * Login": the verb says it is something to click, the phrase does not say what).
 */
/**
 * Head nouns that are also words inside the name of a field: "Job Title", "Name Label". After a verb that enters or
 * clears something, they are part of the name, not the kind of thing.
 */
const FIELD_CONTEXT_EXCLUDE: ReadonlySet<string> = new Set(['Heading', 'Label']);

export interface NounPhraseOptions {
  /** The phrase names a field to fill in: "title" and "label" are words of its name. */
  field?: boolean;
  /** The phrase is one thing ("Click Terms and Conditions"): an "and" is part of its name, not a list. */
  single?: boolean;
}

export function parseNounPhrase(line: Line, tokens: readonly Token[], fallbackClass = 'Element', options: NounPhraseOptions = {}): NounPhrase {
  const exclude = options.field ? FIELD_CONTEXT_EXCLUDE : undefined;
  const split = (parts: readonly Token[]): Token[][] => (options.single ? (parts.length ? [[...parts]] : []) : splitList(parts));
  const original = originalOf(line, tokens);
  // "Click it again": the word after the thing is not part of it.
  const trimmed = [...tokens];
  while (trimmed.length > 1 && ['again', 'also', 'too'].includes(lw(trimmed[trimmed.length - 1]))) trimmed.pop();
  const bodyAll = strip(trimmed);
  // "PIM as a default page": what follows "as" says something the engine does not read; it is reported, never dropped silently.
  const asAt = bodyAll.findIndex((t, k) => k > 0 && lw(t) === 'as');
  const body = asAt > 0 ? bodyAll.slice(0, asAt) : bodyAll;
  const dropped = asAt > 0 ? originalOf(line, bodyAll.slice(asAt)) : undefined;
  const referenceWord =
    body.map((t) => lw(t)).find((w) => REFERENCE_WORDS.has(w)) ?? (body.length === 1 && PRONOUNS.has(lw(body[0])) ? lw(body[0]) : undefined);
  const flags = { ...(dropped ? { dropped } : {}), ...(referenceWord ? { reference: referenceWord } : {}) };
  // A place qualifier: everything from the first place word on, when something comes before it.
  let cut = -1;
  for (let i = 1; i < body.length; i++)
    if (PLACE_WORDS.has(lw(body[i])) && body[i]?.kind === 'WORD') {
      cut = i;
      break;
    }
  const main = cut < 0 ? body : body.slice(0, cut);
  const place = cut < 0 ? [] : body.slice(cut + 1);
  const words = main.map((t) => lw(t));
  // The name as the tester wrote it: a quoted name without its quotes, no dangling slash or dash.
  const nameOf = (parts: readonly Token[]): string => {
    const only = parts.length === 1 ? parts[0] : undefined;
    if (only?.kind === 'LITERAL') return only.value ?? '';
    let ps = [...parts];
    while (ps.length && isSymbol(ps[ps.length - 1], '/', '-', ',', ':')) ps = ps.slice(0, -1);
    return originalOf(line, ps);
  };

  const head = headNounOf(
    words.filter((w) => w !== ',' && w !== 'and'),
    exclude,
  );
  const plural = main.length > 0 && words[words.length - 1] !== undefined && words[words.length - 1] !== lowerSingular(words[words.length - 1] as string);

  // "tabs of Admin, PIM and Leave": a plural head noun with a list after "of" names each one.
  if (head && plural && cut >= 0 && lw(body[cut]) === 'of' && main.length === head.length) {
    const items = splitList(place);
    if (items.length) {
      return {
        targets: items.map((item) => ({ ontology: head.cls, name: nameOf(item) })),
        headClass: head.cls,
        plural,
        original,
        words,
        itemTokens: items,
        ...flags,
      };
    }
  }

  // A list: "username and password fields" shares one head noun; "entered text boxes and uploaded photo" has one each.
  const listItems = split(main);
  if (listItems.length > 1) {
    const heads = listItems.map((item) =>
      headNounOf(
        item.map((t) => lw(t)),
        exclude,
      ),
    );
    const lastHead = heads[heads.length - 1];
    const shared = Boolean(lastHead && heads.slice(0, -1).every((h) => !h) && plural);
    const targets: IrTarget[] = [];
    const tokensOfTargets: Token[][] = [];
    listItems.forEach((item, k) => {
      const h = heads[k];
      const nameTokens = h && (k === listItems.length - 1 || !shared) ? item.slice(0, item.length - h.length) : item;
      if (!nameTokens.length) return;
      const cls = shared && lastHead ? lastHead.cls : (h?.cls ?? fallbackClass);
      const name = nameOf(nameTokens);
      targets.push({ ontology: cls === 'Field' ? refineField(name) : cls, name });
      tokensOfTargets.push(nameTokens);
    });
    return {
      targets,
      ...(shared && lastHead ? { headClass: lastHead.cls } : {}),
      plural,
      ...(place.length ? { within: nameOf(place) } : {}),
      original,
      words,
      itemTokens: tokensOfTargets,
      ...flags,
    };
  }

  if (head && main.length >= head.length) {
    const nameTokens = main.slice(0, main.length - head.length);
    const items = split(nameTokens);
    const headWord = main.slice(main.length - head.length);
    const targets = items.length
      ? items.map((item) => ({ ontology: refineIfField(head.cls, nameOf(item)), name: nameOf(item) }))
      : [{ ontology: head.cls, label: nameOf(headWord) }];
    return {
      targets,
      headClass: head.cls,
      plural,
      ...(place.length ? { within: nameOf(place) } : {}),
      original,
      words,
      itemTokens: items.length ? items : [headWord],
      ...flags,
    };
  }

  // No head noun: a list of names, or one name, of the class the verb suggests.
  const items = split(main);
  const targets = items.length ? items.map((item) => defaultTarget(nameOf(item), fallbackClass)) : [defaultTarget(undefined, fallbackClass)];
  return { targets, plural: false, ...(place.length ? { within: nameOf(place) } : {}), original, words, itemTokens: items.length ? items : [[]], ...flags };
}

const refineIfField = (cls: string, name: string): string => (cls === 'Field' ? refineField(name) : cls);

/** The singular a plural noun of the ontology goes back to; any other word comes back as it was. */
function lowerSingular(word: string): string {
  if (word.endsWith('xes') || word.endsWith('ches')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}
