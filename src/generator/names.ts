/**
 * Naming rules for generated code (FR-GE-02, FR-GE-10). Fixed rules, so the same input always
 * gives the same names (FR-GE-06).
 */

const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** "Save changes" → saveChanges, "E-mail" → eMail, "2FA code" → n2faCode (identifiers cannot start with a digit). */
export function camel(text: string): string {
  const [first = '', ...rest] = words(text);
  const id = first.toLowerCase() + rest.map(pascalWord).join('');
  return /^\d/.test(id) ? `n${id}` : id;
}

/** "save changes" → SaveChanges. Inner capitals are kept ("LoginPage" stays LoginPage). */
export function pascal(text: string): string {
  const id = words(text).map(pascalWord).join('');
  return /^\d/.test(id) ? `N${id}` : id;
}

function pascalWord(w: string): string {
  return w[0].toUpperCase() + (w === w.toUpperCase() ? w.slice(1).toLowerCase() : w.slice(1));
}

/** LoginPage → loginPage: the variable for a Page Object in a spec. */
export function pageVariable(className: string): string {
  return className[0].toLowerCase() + className.slice(1);
}

/** LoginPage → login, SwagLabsPage → swag-labs: the file name for its locators. */
export function kebabPage(className: string): string {
  return (
    className
      .replace(/Page$/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase() || 'page'
  );
}

/** TC-DEMO-001 → tc-demo-001: the spec and data file names. */
export function kebabId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** TC-REG-014 → AUTO-REG-014 (FR-EN-06). */
export function automationId(testId: string): string {
  return `AUTO-${testId.replace(/^TC-/i, '')}`;
}

const ROLE_SUFFIX: Record<string, string> = {
  button: 'Button',
  link: 'Link',
  heading: 'Heading',
  checkbox: 'Checkbox',
  switch: 'Switch',
  radio: 'Radio',
  combobox: 'Select',
  listbox: 'Select',
  tab: 'Tab',
  menuitem: 'MenuItem',
  img: 'Image',
  alert: 'Alert',
  dialog: 'Dialog',
  generic: 'Text',
  text: 'Text',
  paragraph: 'Text',
};
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);
const RESERVED = new Set(['page', 'path', 'goto', 'constructor']);

/** Page Object property: textbox "Username" → username, button "Login" → loginButton. */
export function propertyName(role: string, name: string): string {
  const base = camel(name) || camel(role);
  const suffix = FIELD_ROLES.has(role) ? '' : (ROLE_SUFFIX[role] ?? pascal(role));
  // "checkbox 1" is already a checkbox: checkbox1, not checkbox1Checkbox.
  const id = base.toLowerCase().includes(suffix.toLowerCase()) ? base : `${base}${suffix}`;
  return RESERVED.has(id) ? `${id}Element` : id;
}

/** Name of a one-step action method (FR-GE-10 rule 3). */
export function singleMethodName(action: string, role: string, name: string): string {
  const p = pascal(name) || pascal(role);
  switch (action) {
    case 'click':
      if (role === 'link') return `open${p}`;
      if (role === 'button') return camel(name) || 'clickButton';
      return `click${p}`;
    case 'fill':
      return `fill${p}`;
    case 'clear':
      return `clear${p}`;
    case 'select':
      return `select${p}`;
    case 'check':
      return `check${p}`;
    case 'uncheck':
      return `uncheck${p}`;
    case 'hover':
      return `hover${p}`;
    case 'upload':
      return `upload${p}`;
    case 'press':
      return `press${p}`;
    default:
      return `${action}${p}`;
  }
}

/** Returns `name`, or `name2`, `name3`… if `taken` says it is used for something else. */
export function unique(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let n = 2; ; n++) if (!taken(`${name}${n}`)) return `${name}${n}`;
}

export function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
