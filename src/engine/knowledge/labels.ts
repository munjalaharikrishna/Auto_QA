import { compactKey } from '../text/compound.js';
import type { Application, Component, Page } from './schema.js';

/**
 * Layer 22, locator understanding: label consolidation (LU-01). "username", "username field", "login name", "user name
 * textbox" and "Username input" are five ways to write one component. They are brought to one through a central
 * mapping: the aliases stored with the component in the page knowledge (PK-01), and, when the application's knowledge
 * does not know the name, a short list of names that mean the same everywhere. The same words always give the same
 * component; a name that fits two components gives both, never one of them.
 */

/** Words a name can carry that say what kind of thing it is, not which one: "Username input", "Login Name text box". */
const KIND_WORDS: ReadonlySet<string> = new Set([
  'field',
  'box',
  'textbox',
  'text',
  'input',
  'control',
  'element',
  'the',
  'a',
  'an',
  'button',
  'link',
  'dropdown',
  'checkbox',
  'label',
]);

/** The words of a name with the kind-of-thing words and the decoration taken off: `Login Name :` → `login name`. */
export function nameWords(phrase: string): string[] {
  const words: string[] = [];
  let current = '';
  for (const ch of phrase.toLowerCase()) {
    if (ch.toLowerCase() !== ch.toUpperCase() || (ch >= '0' && ch <= '9')) current += ch;
    else if (current) {
      words.push(current);
      current = '';
    }
  }
  if (current) words.push(current);
  const kept = words.filter((w) => !KIND_WORDS.has(w));
  return kept.length ? kept : words;
}

/** One key for every way of writing a name: letters and digits only, lower case, `user name` and `username` the same. */
export const labelKey = (phrase: string): string => compactKey(nameWords(phrase).join(' '));

/** Names that mean the same in every application. The knowledge of an application adds to them and wins over them. */
export const CORE_LABELS: Readonly<Record<string, readonly string[]>> = {
  username: ['login name', 'user name', 'user id', 'login id', 'userid', 'account name'],
  password: ['passcode', 'pass word', 'pwd', 'secret'],
  email: ['e-mail', 'email address', 'mail address', 'mail'],
  firstname: ['first name', 'given name', 'forename'],
  lastname: ['last name', 'surname', 'family name'],
  phone: ['phone number', 'telephone', 'mobile', 'mobile number', 'contact number'],
};

const CORE_BY_KEY = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(CORE_LABELS)) {
  CORE_BY_KEY.set(labelKey(canonical), canonical);
  for (const a of aliases) if (!CORE_BY_KEY.has(labelKey(a))) CORE_BY_KEY.set(labelKey(a), canonical);
}

/** The name of a component with the names it goes by, as keys. */
export const keysOf = (c: Pick<Component, 'name' | 'aliases'>): string[] => [...new Set([labelKey(c.name), ...c.aliases.map(labelKey)])].filter(Boolean);

export interface Consolidation {
  /** `one`: exactly one component. `many`: the name fits several, and none is chosen. `none`: nothing known by that name. */
  status: 'one' | 'many' | 'none';
  /** The component or components in the application's knowledge. */
  components: Array<{ page: string; component: Component }>;
  /** The same-everywhere name, when the knowledge has none: `username`. */
  core?: string;
  /** The key every spelling of the name shares. */
  key: string;
}

/**
 * The component a name stands for. `page` limits the search to one page: a name is searched on the current page first
 * (CX-04), then on every page.
 */
export function consolidate(kb: Application | undefined, phrase: string, options: { page?: string } = {}): Consolidation {
  const key = labelKey(phrase);
  const core = CORE_BY_KEY.get(key);
  const coreKeys = core ? [labelKey(core), ...(CORE_LABELS[core] ?? []).map(labelKey)] : [];
  const searchIn = (pages: readonly Page[]): Consolidation['components'] => {
    const found: Consolidation['components'] = [];
    for (const p of pages) {
      for (const c of p.components) {
        const keys = keysOf(c);
        // A component stored under one name is reached by its other names, and by the same-everywhere names of its own.
        if (keys.includes(key) || (core !== undefined && keys.some((k) => coreKeys.includes(k)))) found.push({ page: p.name, component: c });
      }
    }
    return found;
  };
  const pages = kb?.pages ?? [];
  const here = options.page ? pages.filter((p) => compactKey(p.name) === compactKey(options.page ?? '')) : [];
  let components = here.length ? searchIn(here) : [];
  if (!components.length) components = searchIn(pages);
  const status = components.length === 0 ? 'none' : components.length === 1 ? 'one' : 'many';
  return { status, components, ...(core ? { core } : {}), key };
}
