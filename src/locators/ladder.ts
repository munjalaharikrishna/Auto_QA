import type { SnapshotNode } from '../explorer/snapshot-parser.js';
import { type LocatorSpec, STRATEGIES, sameSpec, spec } from './locator.js';

/**
 * Locator ladder (FR-LO-06): every way to address one element, in the order they are tried.
 * getByTestId → getByRole+name → getByLabel → getByPlaceholder → getByText → CSS → XPath.
 */

/** DOM facts about the element, read by the Locator Probe. The snapshot alone has no attributes. */
export interface ElementFacts {
  tag: string;
  /** `type` of an input or button. */
  type?: string;
  id?: string;
  /** The `name` attribute. */
  nameAttr?: string;
  placeholder?: string;
  /** Value of the project's test-id attribute (FR-LO-09). */
  testId?: string;
  /** Texts of the `<label>` elements (or aria-labelledby) that name it. */
  labels: string[];
  /** Visible text, trimmed, for buttons and links. */
  text?: string;
  /** id or name of the enclosing form. */
  form?: string;
  /** Path from the nearest ancestor with an id, e.g. `//form[@id='login']/div[2]/input`. */
  xpath: string;
}

const PLAIN_ROLES = new Set(['generic', 'text', 'paragraph']);
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox', 'checkbox', 'radio', 'switch', 'slider']);

/** Ids with long numbers or framework prefixes change between builds, so they make poor CSS locators. */
export function isStableId(id: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id) && !/^(ember|react|ng-|mui-|radix-|headlessui-|:r)/i.test(id);
}

export function buildLadder(node: SnapshotNode, facts: ElementFacts, suggestions: LocatorSpec[] = []): LocatorSpec[] {
  const out: LocatorSpec[] = [];
  const isField = FIELD_ROLES.has(node.role);

  if (facts.testId) out.push(spec('getByTestId', facts.testId));
  // Without a name, the role alone is still a valid rung when the page has one element of it.
  // Plain text has no useful role (`getByRole('generic')`), so it relies on test id and text.
  if (!PLAIN_ROLES.has(node.role)) out.push(node.name ? spec('getByRole', node.role, { name: node.name, exact: true }) : spec('getByRole', node.role));
  if (isField && facts.labels[0]) out.push(spec('getByLabel', facts.labels[0], { exact: true }));
  if (facts.placeholder) out.push(spec('getByPlaceholder', facts.placeholder, { exact: true }));
  if (!isField && facts.text) out.push(spec('getByText', facts.text, { exact: true }));
  if (facts.id && isStableId(facts.id)) out.push(spec('locator', `#${facts.id}`));
  else if (facts.nameAttr) out.push(spec('locator', `${facts.tag}[name="${facts.nameAttr.replace(/"/g, '\\"')}"]`));
  if (facts.xpath) out.push(spec('locator', `xpath=${facts.xpath}`));

  // MCP's suggestion (FR-LO-07) joins at its strategy's place unless it is already there.
  for (const s of suggestions) if (!out.some((o) => sameSpec(o, s))) out.push(s);
  // A role without a name only works while the page has one such element, so it ranks after CSS
  // (a stable id) but before XPath. Position-based locators break when the order changes, so they come last.
  const rank = (s: LocatorSpec) => {
    const base = s.strategy === 'role' && !s.options?.name ? STRATEGIES.indexOf('css') + 0.5 : STRATEGIES.indexOf(s.strategy);
    return (s.nth === undefined ? 0 : STRATEGIES.length) + base;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Stored facts for finding the element again after the UI changes (FR-LO-11). */
export interface Fingerprint {
  role: string;
  name: string;
  tag: string;
  type?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
  text?: string;
  form?: string;
  /** e.g. `form "Login"`, from the snapshot. */
  context?: string;
}

export function fingerprint(node: SnapshotNode, facts: ElementFacts, context: string): Fingerprint {
  const f: Fingerprint = {
    role: node.role,
    name: node.name,
    tag: facts.tag,
    type: facts.type,
    label: facts.labels[0],
    placeholder: facts.placeholder,
    testId: facts.testId,
    id: facts.id,
    nameAttr: facts.nameAttr,
    text: facts.text,
    form: facts.form,
    context: context || undefined,
  };
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '')) as unknown as Fingerprint;
}

/** Which Page Object an element belongs to (FR-LO-10). */
export interface PageRef {
  /** Class name, e.g. `LoginPage`. */
  name: string;
  /** URL path, the grouping key: elements found on the same path share a Page Object. */
  path: string;
  title: string;
}

/**
 * `hint` is the page name the tester used ("Open Login page"), which is the best name.
 * Otherwise the last path segment (`/inventory.html` → InventoryPage), then the title.
 */
export function pageOf(url: string, title: string, hint?: string): PageRef {
  let path = '/';
  try {
    path = new URL(url).pathname || '/';
  } catch {}
  const segment = path
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.\w+$/, '');
  const base = pascal(hint ?? '') || pascal(segment ?? '') || pascal(title) || 'Home';
  return { name: base.endsWith('Page') ? base : `${base}Page`, path, title };
}

function pascal(text: string): string {
  return (
    text
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      // Keep inner capitals ("LoginPage"); only an all-caps word ("LOGIN") is lowered.
      .map((w) => w[0].toUpperCase() + (w === w.toUpperCase() ? w.slice(1).toLowerCase() : w.slice(1)))
      .join('')
      .replace(/^\d+/, '')
  );
}
