/**
 * Turns Playwright's YAML accessibility snapshot into a tree of nodes the
 * Locator Engine can score.
 *
 * Example input lines:
 *   - form "Login" [ref=e9]:
 *     - textbox "Username" [ref=e11]
 *     - button "Login" [ref=e15] [cursor=pointer]
 *     - heading "Password for all users:" [level=4] [ref=e21]
 *     - text: secret_sauce
 *   - link "Home" [ref=e5]:
 *     - /url: /home
 */

export interface SnapshotNode {
  role: string;
  /** Accessible name, e.g. the button text or field label. */
  name: string;
  /** Temporary MCP handle, valid only until the page changes. Not a locator. */
  ref?: string;
  /** Flags and values in brackets, e.g. { level: "4", checked: true, cursor: "pointer" }. */
  attributes: Record<string, string | true>;
  /** Inline text after the colon, e.g. `generic: Swag Labs` or `text: secret_sauce`. */
  text?: string;
  /** Properties such as `/url: /home`. */
  props: Record<string, string>;
  depth: number;
  parent?: SnapshotNode;
  children: SnapshotNode[];
}

const LINE = /^(\s*)- (.*)$/;
const NODE = /^([a-zA-Z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/;
const PROP = /^\/([\w-]+): ?(.*)$/;

export function parseSnapshot(yaml: string): SnapshotNode[] {
  const roots: SnapshotNode[] = [];
  const stack: SnapshotNode[] = [];

  for (const line of yaml.split(/\r?\n/)) {
    const lineMatch = LINE.exec(line);
    if (!lineMatch) continue;
    const depth = lineMatch[1].length / 2;
    const body = lineMatch[2];

    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];

    const prop = PROP.exec(body);
    if (prop) {
      if (parent) parent.props[prop[1]] = prop[2];
      continue;
    }

    const m = NODE.exec(body);
    if (!m) continue;

    const attributes = parseAttributes(m[3] ?? '');
    const ref = typeof attributes.ref === 'string' ? attributes.ref : undefined;
    delete attributes.ref;

    const node: SnapshotNode = {
      role: m[1],
      name: m[2] ? m[2].replace(/\\(.)/g, '$1') : '',
      ref,
      attributes,
      text: m[4]?.replace(/^"(.*)"$/, '$1'),
      props: {},
      depth,
      parent,
      children: [],
    };
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

function parseAttributes(text: string): Record<string, string | true> {
  const attributes: Record<string, string | true> = {};
  for (const [, key, value] of text.matchAll(/\[([\w-]+)(?:=([^\]]*))?\]/g)) {
    attributes[key] = value ?? true;
  }
  return attributes;
}

export function flatten(nodes: SnapshotNode[]): SnapshotNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Element kinds from section 5 of the requirements, keyed by ARIA role. */
export const ELEMENT_KINDS: Record<string, string> = {
  button: 'Button',
  link: 'Link',
  textbox: 'Text field',
  searchbox: 'Text field',
  spinbutton: 'Text field',
  combobox: 'Dropdown',
  listbox: 'Dropdown',
  checkbox: 'Checkbox',
  switch: 'Checkbox',
  radio: 'Radio button',
  tab: 'Tab',
  menuitem: 'Menu item',
  slider: 'Slider',
  heading: 'Heading',
  table: 'Table',
  dialog: 'Dialog',
  alertdialog: 'Dialog',
  alert: 'Alert',
  img: 'Image',
};

/** Nodes worth showing to a tester: the element kinds above that have a ref. */
export function listElements(nodes: SnapshotNode[]): SnapshotNode[] {
  return flatten(nodes).filter((n) => n.ref && ELEMENT_KINDS[n.role]);
}

/**
 * Fallback name for an element with no accessible name, taken from the plain text beside it.
 * Many apps put "checkbox 1" or "Name:" next to an input without linking them as a label.
 * Checkboxes and radios usually have the text after them; fields and dropdowns before them.
 */
export function nearbyText(node: SnapshotNode): string | undefined {
  if (node.name || !node.parent) return undefined;
  const siblings = node.parent.children;
  const i = siblings.indexOf(node);
  const textAt = (j: number) => {
    const s = siblings[j];
    return s && (s.role === 'text' || (s.role === 'generic' && !s.children.length)) ? s.text?.trim() || undefined : undefined;
  };
  const textAfterFirst = ['checkbox', 'radio', 'switch'].includes(node.role);
  return textAfterFirst ? textAt(i + 1) ?? textAt(i - 1) : textAt(i - 1) ?? textAt(i + 1);
}

/** Readable context for a node, e.g. `form "Login"`, so testers can tell duplicates apart. */
export function contextOf(node: SnapshotNode): string {
  for (let p = node.parent; p; p = p.parent) {
    if (p.name && ['form', 'dialog', 'navigation', 'region', 'table', 'list', 'group'].includes(p.role)) {
      return `${p.role} "${p.name}"`;
    }
  }
  return '';
}
