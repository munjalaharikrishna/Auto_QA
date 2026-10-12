/**
 * What the engine knows about one element of a page, read by the DOM inspector (DM-01) and judged by the candidate
 * engine (LC-01) and the ambiguity rules (LA-01). It is plain data, so the same facts always give the same answer and
 * the engine can be tested without a browser.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomElement {
  /** The order of the element in the document: the same page always numbers its elements the same way. */
  index: number;
  tag: string;
  /** `type` of an input or button. */
  type?: string;
  /** The role it has: the one written, or the one its tag and type give. */
  role: string;
  /** The name written for assistive tools: aria-label, aria-labelledby, title, alt, the value of a button input. */
  ariaName: string;
  /** The `aria-label` attribute itself, when that is where the name comes from: a locator on the attribute is exact. */
  ariaLabel?: string;
  /** The text of the `<label>` elements that belong to it. */
  labels: string[];
  placeholder?: string;
  testId?: string;
  /** The `name` attribute. */
  nameAttr?: string;
  id?: string;
  /** Visible text: all of it for a button or a link, its own text for anything else. */
  text: string;
  visible: boolean;
  /** Why it is not visible: `display:none`, `visibility:hidden`, `no size`, `hidden attribute`, `opacity:0`. */
  hiddenReason?: string;
  disabled: boolean;
  readOnly: boolean;
  /** Another element is on top of its centre: a click would land on that one. */
  covered: boolean;
  coveredBy?: string;
  box: Box;
  focused: boolean;
  focusable: boolean;
  /** The nearest ancestors, nearest first: `td`, `tr`, `table#login`. */
  parents: string[];
  /** The text next to it that names it: the cell before it in a table row, the text before it in a line. */
  nearbyText: string;
  xpath: string;
  /** The id or name of the form it is in. */
  form?: string;
  /** It is inside a dialog. */
  inDialog: boolean;
  /** What the field holds now. A password is never read: it shows `••••` when there is one, and nothing when there is none. */
  value?: string;
  /** For a dropdown: the text of the option that is chosen. */
  selectedText?: string;
  /** A box or a switch: ticked or not. */
  checked?: boolean;
  /** The page says the field's value is not accepted (`aria-invalid`). */
  invalid: boolean;
  /** The text of the visible elements that describe the field (`aria-describedby`): its error message, when it has one (UI-04). */
  describedBy?: string;
  /** The iframes it is inside, outermost first. Empty for the main page. */
  frame: string[];
}

/** The ways of finding an element, from the one people trust most (LC-01). */
export const LEVELS = ['testId', 'role', 'accessibleName', 'label', 'placeholder', 'name', 'id', 'text', 'relationship', 'xpath', 'inspection'] as const;
export type Level = (typeof LEVELS)[number];

/** The weight of each level: the higher, the more a match there says about the element. Descending, by the order of LC-01. */
export const WEIGHT: Readonly<Record<Level, number>> = {
  testId: 1,
  role: 0.95,
  accessibleName: 0.9,
  label: 0.85,
  placeholder: 0.8,
  name: 0.75,
  id: 0.7,
  text: 0.65,
  relationship: 0.55,
  xpath: 0.45,
  inspection: 0.35,
};

export interface LocateQuery {
  /** The name the step uses. */
  name: string;
  /** Other names for the same component (LU-01): every one is searched. */
  aliases?: string[];
  /** The class of the QA ontology: `Button`, `Field`, `Username`. */
  ontology?: string;
  /** A test id written in the knowledge, when there is one. */
  testId?: string;
  /** An XPath written in the knowledge, for the level that is used when nothing else finds it. */
  xpath?: string;
  /** The container the tester named ("in the Employee section"): only elements inside a container with this name count. */
  within?: string;
  /** `act`: the element is to be clicked or typed into. `inspect`: a check looks at it, so a disabled one is the right one. */
  purpose?: 'act' | 'inspect';
}

export interface Tried {
  level: Level;
  weight: number;
  /** The elements that matched at this level. */
  matches: number;
  /** Of those, the ones that could be used. */
  active: number;
  outcome: 'used' | 'ambiguous' | 'inactive' | 'nothing';
}

export interface Ignored {
  element: DomElement;
  reason: string;
}

export type LocateResult =
  | { status: 'found'; element: DomElement; level: Level; weight: number; tried: Tried[]; ignored: Ignored[]; passAllowed: true }
  | { status: 'ambiguous'; candidates: DomElement[]; level: Level; reason: string; tried: Tried[]; ignored: Ignored[]; passAllowed: false }
  | { status: 'inactive'; candidates: Ignored[]; level: Level; reason: string; tried: Tried[]; passAllowed: false }
  | { status: 'not-found'; tried: Tried[]; reason: string; passAllowed: false };
