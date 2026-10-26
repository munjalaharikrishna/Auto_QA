import { type LocatorSpec, spec } from '../../locators/locator.js';
import { labelKey, nameWords } from '../knowledge/labels.js';
import { type DomElement, type Ignored, LEVELS, type Level, type LocateQuery, type LocateResult, type Tried, WEIGHT } from './types.js';

/**
 * Layers 23 and 24, the locator candidate engine and zero-tolerance ambiguity (LC-01, LA-01).
 *
 * LC-01: the ways of finding an element are tried in a fixed order, from the one that says most about it to the one that
 * says least: test id, role, accessible name, label, placeholder, name, id, text, relationships, XPath, inspection. The
 * first level that finds an element that can be used decides. Every level tried is recorded with its weight.
 *
 * LA-01: nothing is chosen that is not clear. No match, several equal matches, layers on top of each other, and
 * elements that are hidden, disabled or covered are all reported with their reason; none is picked silently, and none
 * can end in a PASS (`passAllowed: false`). Where one of two equal matches is hidden and the other is not, the one that
 * can be used is chosen and the other is listed as ignored, with why.
 */

const CONTROL_TAGS: ReadonlySet<string> = new Set(['input', 'select', 'textarea']);
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color']);

/** Whether the element has a role that suits a class of the ontology (the strict fit of the role level). */
export function roleFits(ontology: string | undefined, el: DomElement): boolean {
  const role = el.role;
  switch (ontology) {
    case 'Button':
      return ['button', 'link', 'menuitem', 'tab'].includes(role);
    case 'Link':
      return ['link', 'button', 'menuitem'].includes(role);
    case 'Field':
    case 'Username':
    case 'Password':
      return ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role) && !(el.tag === 'input' && NON_TEXT_INPUTS.has(el.type ?? ''));
    case 'Dropdown':
      return ['combobox', 'listbox'].includes(role);
    case 'Checkbox':
      return ['checkbox', 'switch'].includes(role);
    case 'RadioButton':
      return role === 'radio';
    case 'Heading':
      return role === 'heading';
    case 'Table':
      return role === 'table';
    case 'Row':
      return role === 'row';
    case 'Tab':
      return role === 'tab';
    case 'Image':
      return role === 'img';
    default:
      return role !== 'generic' && role !== 'paragraph' && role !== 'cell';
  }
}

/** Whether the element could be what the class means at all. Looser than the role: a label cell is never a field. */
export function broadFit(ontology: string | undefined, el: DomElement): boolean {
  switch (ontology) {
    case 'Field':
    case 'Username':
    case 'Password':
      return (
        (CONTROL_TAGS.has(el.tag) && !(el.tag === 'input' && NON_TEXT_INPUTS.has(el.type ?? ''))) ||
        ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(el.role)
      );
    case 'Dropdown':
      return el.tag === 'select' || ['combobox', 'listbox'].includes(el.role);
    case 'Checkbox':
      return (el.tag === 'input' && el.type === 'checkbox') || ['checkbox', 'switch'].includes(el.role);
    case 'RadioButton':
      return (el.tag === 'input' && el.type === 'radio') || el.role === 'radio';
    case 'Button':
    case 'Link':
      return (
        ['button', 'link', 'menuitem', 'tab'].includes(el.role) ||
        el.tag === 'button' ||
        el.tag === 'a' ||
        (el.tag === 'input' && ['button', 'submit', 'reset', 'image', 'file'].includes(el.type ?? ''))
      );
    default:
      return true;
  }
}

/**
 * The name the element carries with its role: written for assistive tools, or the words on a button or a link. A name
 * that comes from a `<label>` is the label level's own (LC-01 lists them apart), so it is not part of this one.
 */
export function accessibleName(el: DomElement): string {
  if (el.ariaName) return el.ariaName;
  if (['button', 'link', 'menuitem', 'tab', 'option', 'heading', 'checkbox', 'radio'].includes(el.role)) return el.text;
  return '';
}

const hiddenWhy = (el: DomElement): string | undefined =>
  !el.visible
    ? `hidden (${el.hiddenReason ?? 'not visible'})`
    : el.covered
      ? `covered by ${el.coveredBy ?? 'another element'}`
      : el.disabled
        ? 'disabled'
        : undefined;

/** Whether the element can be used for the purpose: to act on it, it must be seen, uncovered and enabled. To look at it, any will do. */
const usable = (el: DomElement, purpose: 'act' | 'inspect'): boolean => purpose === 'inspect' || hiddenWhy(el) === undefined;

const overlap = (a: DomElement, b: DomElement): boolean => {
  const w = Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
  const h = Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
  return w > 0 && h > 0;
};

export interface LocateOptions {
  /** The last level (MCP inspection): asked only when nothing else found anything. */
  inspection?: (query: LocateQuery) => readonly DomElement[];
}

/** Whether `have` holds every word of `want` in the same order, with at most three words more than `want` (so a sentence is not a name). */
function holdsInOrder(have: readonly string[], want: readonly string[]): boolean {
  if (have.length === 0 || have.length > want.length + 3) return false;
  let at = 0;
  for (const w of have) if (w === want[at]) at++;
  return at === want.length;
}

/** The elements that match a query at one level. */
function matchesAt(level: Level, query: LocateQuery, names: ReadonlySet<string>, elements: readonly DomElement[], options: LocateOptions): DomElement[] {
  const hit = (text: string | undefined): boolean => text !== undefined && text !== '' && names.has(labelKey(text));
  const broad = (e: DomElement): boolean => broadFit(query.ontology, e);
  switch (level) {
    case 'testId':
      return elements.filter((e) => e.testId !== undefined && (hit(e.testId) || e.testId === query.testId));
    case 'role':
      return elements.filter((e) => roleFits(query.ontology, e) && hit(accessibleName(e)));
    case 'accessibleName':
      return elements.filter((e) => broad(e) && hit(e.ariaName));
    case 'label':
      return elements.filter((e) => broad(e) && e.labels.some(hit));
    case 'placeholder':
      return elements.filter((e) => broad(e) && hit(e.placeholder));
    case 'name':
      return elements.filter((e) => broad(e) && hit(e.nameAttr));
    case 'id':
      return elements.filter((e) => broad(e) && hit(e.id));
    case 'text':
      return elements.filter((e) => broad(e) && hit(e.text));
    case 'relationship':
      return elements.filter((e) => broad(e) && hit(e.nearbyText));
    case 'words': {
      // "Forgot password" is the link "Forgot your password?": the words of the name, in order, with a few more between or after.
      const wanted = [...new Set([query.name, ...(query.aliases ?? [])])].map(nameWords).filter((w) => w.length >= 2);
      return elements.filter((e) => broad(e) && wanted.some((w) => [accessibleName(e), e.text].some((t) => holdsInOrder(nameWords(t), w))));
    }
    case 'xpath':
      return query.xpath ? elements.filter((e) => e.xpath === query.xpath) : [];
    case 'inspection':
      return options.inspection ? [...options.inspection(query)] : [];
  }
}

const inContainer = (e: DomElement, within: string | undefined): boolean => {
  if (!within) return true;
  const key = labelKey(within);
  return (e.form !== undefined && labelKey(e.form) === key) || e.parents.some((p) => labelKey(p).includes(key));
};

/** Finds the element a step means, or says why it cannot (LC-01, LA-01). Pure: the same page and query always give the same result. */
export function locate(query: LocateQuery, page: readonly DomElement[], options: LocateOptions = {}): LocateResult {
  const names = new Set([query.name, ...(query.aliases ?? [])].map(labelKey).filter(Boolean));
  const purpose = query.purpose ?? 'act';
  const elements = page.filter((e) => inContainer(e, query.within));
  const tried: Tried[] = [];

  for (const level of LEVELS) {
    const matches = matchesAt(level, query, names, elements, options);
    const weight = WEIGHT[level];
    if (!matches.length) {
      tried.push({ level, weight, matches: 0, active: 0, outcome: 'nothing' });
      continue;
    }
    const active = matches.filter((e) => usable(e, purpose));
    const ignored = (chosen: readonly DomElement[]): Ignored[] =>
      matches.filter((e) => !chosen.includes(e)).map((element) => ({ element, reason: hiddenWhy(element) ?? 'another match was used' }));

    if (active.length === 0) {
      tried.push({ level, weight, matches: matches.length, active: 0, outcome: 'inactive' });
      const candidates = ignored([]);
      return {
        status: 'inactive',
        candidates,
        level,
        reason: `found by ${level}, but it cannot be used: ${candidates.map((c) => c.reason).join('; ')}`,
        tried,
        passAllowed: false,
      };
    }

    let chosen = active;
    // A dialog that is open holds the user: when some matches are in it and some are not, the ones in it are meant (CX-06).
    if (chosen.length > 1 && chosen.some((e) => e.inDialog) && chosen.some((e) => !e.inDialog)) chosen = chosen.filter((e) => e.inDialog);

    if (chosen.length > 1) {
      tried.push({ level, weight, matches: matches.length, active: active.length, outcome: 'ambiguous' });
      return {
        status: 'ambiguous',
        candidates: chosen,
        level,
        reason: `${chosen.length} equal candidates found by ${level}: ${chosen.map((e) => `${e.tag}${e.id ? `#${e.id}` : ''} at ${e.box.x},${e.box.y}`).join(' and ')}`,
        tried,
        ignored: ignored(chosen),
        passAllowed: false,
      };
    }

    const one = chosen[0] as DomElement;
    // A usable element with a covered twin underneath it: layers that sit on each other are not one element.
    const stacked = matches.find((e) => e !== one && e.covered && overlap(e, one));
    if (stacked && purpose === 'act') {
      tried.push({ level, weight, matches: matches.length, active: active.length, outcome: 'ambiguous' });
      return {
        status: 'ambiguous',
        candidates: [one, stacked],
        level,
        reason: `overlapping layers: two elements called alike sit on each other at ${one.box.x},${one.box.y}`,
        tried,
        ignored: [],
        passAllowed: false,
      };
    }
    tried.push({ level, weight, matches: matches.length, active: active.length, outcome: 'used' });
    return { status: 'found', element: one, level, weight, tried, ignored: ignored([one]), passAllowed: true };
  }
  return { status: 'not-found', tried, reason: `nothing on the page is called ${[...names].map((n) => `"${n}"`).join(' or ')}`, passAllowed: false };
}

/** A value written inside double quotes in a CSS attribute selector: the backslash and the quote are escaped. */
const cssString = (value: string): string =>
  value.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92)).split('"').join(String.fromCharCode(92, 34));

/** The Playwright locator for a found element, from the level that found it: what the executor and the generated code use. */
export function toLocatorSpec(level: Level, el: DomElement): LocatorSpec | undefined {
  switch (level) {
    case 'testId':
      return el.testId ? spec('getByTestId', el.testId) : undefined;
    case 'role':
      return spec('getByRole', el.role, { name: accessibleName(el), exact: true });
    case 'accessibleName':
      // `getByLabel` would also find a <label> with the same words; the attribute itself is exact.
      return el.ariaLabel ? spec('locator', `[aria-label="${cssString(el.ariaLabel)}"]`) : spec('getByLabel', el.ariaName, { exact: true });
    case 'label':
      return spec('getByLabel', el.labels[0] ?? '', { exact: true });
    case 'placeholder':
      return el.placeholder ? spec('getByPlaceholder', el.placeholder, { exact: true }) : undefined;
    case 'name':
      return el.nameAttr ? spec('locator', `[name="${el.nameAttr}"]`) : undefined;
    case 'id':
      return el.id ? spec('locator', `#${el.id}`) : undefined;
    case 'text':
      return spec('getByText', el.text, { exact: true });
    default:
      return spec('locator', el.xpath);
  }
}
