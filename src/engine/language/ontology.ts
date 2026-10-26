import type { IrAction } from '../ir/schema.js';

/**
 * Layer 11, the QA ontology (ON-01, PD-3). The core model every application shares: what kinds of thing a test step
 * talks about, what may be done to each, and what may be said about it. Domain classes of one application (an
 * Applicant, an Expert, an Employee) belong to that application's own knowledge (AK-01), not here.
 *
 * Every target in QA-IR has a class from this list. An action the class does not allow is a paradox (VD-04): "enter a
 * value in a button" is stopped before anything runs.
 */

export type AssertionKind = 'VISIBILITY' | 'TEXT' | 'URL' | 'STATE' | 'AUTHENTICATION' | 'VALUE' | 'ENABLED' | 'COUNT' | 'HEALTH' | 'LAYOUT' | 'MASKED';

export interface OntologyClass {
  name: string;
  /** A class this one specializes: it allows everything the parent allows. */
  parent?: string;
  /** `core`: in ON-01. `ui`: a common interface part added to the core model so real text can be classified. */
  origin: 'core' | 'ui';
  actions: readonly IrAction[];
  assertions: readonly AssertionKind[];
}

const c = (name: string, origin: 'core' | 'ui', actions: readonly IrAction[], assertions: readonly AssertionKind[], parent?: string): OntologyClass => ({
  name,
  origin,
  actions,
  assertions,
  ...(parent ? { parent } : {}),
});

const SEE: readonly AssertionKind[] = ['VISIBILITY', 'LAYOUT'];

export const ONTOLOGY: readonly OntologyClass[] = [
  c('User', 'core', ['LOGIN', 'LOGOUT'], ['AUTHENTICATION', 'URL', 'STATE']),
  c('Applicant', 'core', ['LOGIN', 'LOGOUT'], ['AUTHENTICATION', 'URL', 'STATE']),
  c('Expert', 'core', ['LOGIN', 'LOGOUT'], ['AUTHENTICATION', 'URL', 'STATE']),
  c('Admin', 'core', ['LOGIN', 'LOGOUT'], ['AUTHENTICATION', 'URL', 'STATE']),
  c('Username', 'core', [], [], 'Field'),
  c('Password', 'core', [], [], 'Field'),
  c('Field', 'core', ['ENTER_VALUE', 'CLEAR', 'CLICK', 'SEARCH', 'EDIT', 'UPLOAD', 'HOVER', 'SCROLL'], [...SEE, 'ENABLED', 'VALUE', 'TEXT', 'MASKED']),
  c(
    'Button',
    'core',
    [
      'CLICK',
      'HOVER',
      'SUBMIT',
      'SAVE',
      'CANCEL',
      'CLOSE',
      'LOGIN',
      'LOGOUT',
      'SEARCH',
      'DELETE',
      'EDIT',
      'REMOVE',
      'UPLOAD',
      'DOWNLOAD',
      'EXPAND',
      'COLLAPSE',
      'DRAG',
      'DROP',
      'REFRESH',
      'SCROLL',
    ],
    [...SEE, 'ENABLED', 'TEXT'],
  ),
  c('Link', 'core', ['CLICK', 'HOVER', 'NAVIGATE', 'DOWNLOAD', 'LOGOUT', 'EXPAND', 'COLLAPSE', 'SCROLL'], [...SEE, 'ENABLED', 'TEXT', 'URL']),
  c('Dropdown', 'core', ['SELECT', 'CLICK', 'CLEAR', 'EXPAND', 'COLLAPSE', 'SEARCH'], [...SEE, 'ENABLED', 'VALUE', 'TEXT', 'COUNT']),
  c('Checkbox', 'core', ['CHECK', 'UNCHECK', 'CLICK', 'HOVER'], [...SEE, 'ENABLED', 'STATE']),
  c('RadioButton', 'core', ['SELECT', 'CHECK', 'CLICK', 'HOVER'], [...SEE, 'ENABLED', 'STATE']),
  c('Table', 'core', ['SCROLL', 'SEARCH', 'DOWNLOAD', 'CLICK'], [...SEE, 'COUNT', 'TEXT']),
  c('Row', 'core', ['CLICK', 'SELECT', 'CHECK', 'DELETE', 'EDIT', 'REMOVE', 'EXPAND', 'COLLAPSE', 'HOVER'], [...SEE, 'TEXT', 'STATE']),
  c('Column', 'core', ['CLICK', 'SCROLL'], [...SEE, 'TEXT', 'COUNT']),
  c('Modal', 'core', ['CLOSE', 'CANCEL', 'SUBMIT', 'SCROLL', 'SAVE'], [...SEE, 'TEXT']),
  c('Page', 'core', ['NAVIGATE', 'REFRESH', 'SCROLL', 'BACK', 'FORWARD', 'CLOSE', 'DOWNLOAD'], [...SEE, 'URL', 'TEXT', 'HEALTH', 'STATE']),
  c('Section', 'core', ['EXPAND', 'COLLAPSE', 'SCROLL', 'CLICK', 'HOVER'], [...SEE, 'TEXT']),
  c('Message', 'core', ['CLOSE', 'CLICK'], [...SEE, 'TEXT']),
  c('Error', 'core', ['CLOSE', 'CLICK'], [...SEE, 'TEXT'], 'Message'),
  c('Validation', 'core', ['CLOSE', 'CLICK'], [...SEE, 'TEXT'], 'Message'),
  c('Dashboard', 'core', ['NAVIGATE', 'SCROLL'], [...SEE, 'URL', 'TEXT'], 'Page'),
  c('URL', 'core', ['NAVIGATE', 'ENTER_VALUE'], ['URL', 'TEXT']),
  c('File', 'core', ['UPLOAD', 'DOWNLOAD', 'SELECT', 'REMOVE', 'DELETE'], ['VISIBILITY', 'TEXT', 'STATE']),
  c('Record', 'core', ['CLICK', 'SELECT', 'EDIT', 'DELETE', 'REMOVE', 'SAVE'], ['VISIBILITY', 'TEXT', 'COUNT', 'VALUE', 'STATE']),
  c('ApiResponseStatus', 'core', [], ['COUNT', 'TEXT', 'HEALTH']),
  // Common interface parts the 26 core classes do not name, added so real test text can be classified.
  c('Tab', 'ui', ['CLICK', 'SELECT', 'HOVER', 'CLOSE'], [...SEE, 'STATE', 'TEXT']),
  c('Menu', 'ui', ['CLICK', 'HOVER', 'EXPAND', 'COLLAPSE', 'SELECT'], [...SEE, 'TEXT']),
  c('Heading', 'ui', ['CLICK', 'SCROLL'], [...SEE, 'TEXT']),
  c('Label', 'ui', [], [...SEE, 'TEXT']),
  c('Image', 'ui', ['CLICK', 'HOVER', 'UPLOAD'], [...SEE]),
  c('Form', 'ui', ['SUBMIT', 'CLEAR', 'SAVE', 'CANCEL', 'SCROLL'], [...SEE, 'TEXT']),
  c(
    'Element',
    'ui',
    ['CLICK', 'HOVER', 'ENTER_VALUE', 'CLEAR', 'SELECT', 'CHECK', 'UNCHECK', 'SCROLL', 'DRAG', 'DROP'],
    [...SEE, 'ENABLED', 'TEXT', 'VALUE', 'STATE'],
  ),
];

const BY_NAME = new Map(ONTOLOGY.map((cls) => [cls.name, cls]));

export const ontologyClass = (name: string): OntologyClass | undefined => BY_NAME.get(name);

/** A class and everything it specializes, nearest first. */
export function lineage(name: string): OntologyClass[] {
  const chain: OntologyClass[] = [];
  for (let cls = BY_NAME.get(name); cls && !chain.includes(cls); cls = cls.parent ? BY_NAME.get(cls.parent) : undefined) chain.push(cls);
  return chain;
}

/** Whether a class allows an action, its own or a parent's (VD-04). */
export const allowsAction = (name: string, action: IrAction): boolean => lineage(name).some((cls) => cls.actions.includes(action));

export const allowsAssertion = (name: string, kind: AssertionKind): boolean => lineage(name).some((cls) => cls.assertions.includes(kind));

/** The actions a class allows, for the message that explains a paradox. */
export const actionsOf = (name: string): IrAction[] => [...new Set(lineage(name).flatMap((cls) => cls.actions))];

/** The nouns a target ends in, and the class each stands for. The longest match wins. */
const HEAD_NOUNS: ReadonlyArray<readonly [phrase: string, cls: string]> = [
  ['upload button', 'Button'],
  ['radio button', 'RadioButton'],
  ['text box', 'Field'],
  ['text field', 'Field'],
  ['input field', 'Field'],
  ['input box', 'Field'],
  ['drop down', 'Dropdown'],
  ['dropdown list', 'Dropdown'],
  ['check box', 'Checkbox'],
  ['status code', 'ApiResponseStatus'],
  ['error message', 'Error'],
  ['validation message', 'Validation'],
  ['button', 'Button'],
  ['btn', 'Button'],
  ['link', 'Link'],
  ['field', 'Field'],
  ['textbox', 'Field'],
  ['input', 'Field'],
  ['box', 'Field'],
  ['dropdown', 'Dropdown'],
  ['checkbox', 'Checkbox'],
  ['radio', 'RadioButton'],
  ['table', 'Table'],
  ['row', 'Row'],
  ['column', 'Column'],
  ['popup', 'Modal'],
  ['pop-up', 'Modal'],
  ['modal', 'Modal'],
  ['dialog', 'Modal'],
  ['page', 'Page'],
  ['screen', 'Page'],
  ['section', 'Section'],
  ['message', 'Message'],
  ['error', 'Error'],
  ['validation', 'Validation'],
  ['dashboard', 'Dashboard'],
  ['url', 'URL'],
  ['address', 'URL'],
  ['file', 'File'],
  ['photo', 'File'],
  ['document', 'File'],
  ['record', 'Record'],
  ['tab', 'Tab'],
  ['menu', 'Menu'],
  ['heading', 'Heading'],
  ['title', 'Heading'],
  ['header', 'Heading'],
  ['label', 'Label'],
  ['form', 'Form'],
  ['logo', 'Image'],
  ['image', 'Image'],
  ['icon', 'Image'],
  ['picture', 'Image'],
];

const PLURALS: Record<string, string> = {
  buttons: 'button',
  links: 'link',
  fields: 'field',
  boxes: 'box',
  textboxes: 'textbox',
  inputs: 'input',
  dropdowns: 'dropdown',
  checkboxes: 'checkbox',
  tables: 'table',
  rows: 'row',
  columns: 'column',
  pages: 'page',
  sections: 'section',
  messages: 'message',
  errors: 'error',
  files: 'file',
  photos: 'photo',
  records: 'record',
  tabs: 'tab',
  menus: 'menu',
  labels: 'label',
  forms: 'form',
  images: 'image',
  icons: 'icon',
  popups: 'popup',
  dialogs: 'dialog',
  headings: 'heading',
  documents: 'document',
};

/** The singular of a noun the ontology knows in the plural. */
export const singular = (word: string): string => PLURALS[word] ?? word;

/**
 * The class a phrase ends in: `login name text box` → Field, `add button` → Button. Returns the class and how many
 * words at the end of the phrase are the head noun, so the caller can take them off the name.
 */
export function headNounOf(words: readonly string[], exclude?: ReadonlySet<string>): { cls: string; length: number } | undefined {
  const tail = words.map((w, i) => (i === words.length - 1 ? singular(w) : w));
  for (const [phrase, cls] of HEAD_NOUNS) {
    if (exclude?.has(cls)) continue;
    const parts = phrase.split(' ');
    if (parts.length > tail.length) continue;
    if (tail.slice(tail.length - parts.length).join(' ') === phrase) return { cls, length: parts.length };
  }
  return undefined;
}

const USERNAME_NAMES = ['username', 'user name', 'login name', 'user id', 'userid', 'login id', 'user'];

/** A field named like a username or a password is that more exact class (the ontology's own refinement of Field). */
export function refineField(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('password') || lower.includes('passcode')) return 'Password';
  if (USERNAME_NAMES.some((n) => lower === n || lower.endsWith(` ${n}`) || lower.startsWith(`${n} `))) return 'Username';
  return 'Field';
}

export const ONTOLOGY_VERSION = '1.0.0';
