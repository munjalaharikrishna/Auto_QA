import type { Locator, Page } from 'playwright';

/**
 * Locators as data (FR-LO-06). A spec can be printed as Playwright code for the generated
 * Page Objects, or turned into a live `Locator` for the Locator Probe. MCP's own locator
 * code is read with a small parser, never `eval` (D13).
 */

/** The ladder order: the first strategy that validates wins. */
export const STRATEGIES = ['testid', 'role', 'label', 'placeholder', 'text', 'css', 'xpath'] as const;
export type Strategy = (typeof STRATEGIES)[number];

type Method = 'getByTestId' | 'getByRole' | 'getByLabel' | 'getByPlaceholder' | 'getByText' | 'locator';

export interface LocatorSpec {
  strategy: Strategy;
  method: Method;
  arg: string;
  options?: { name?: string; exact?: boolean };
  /** Position among the matches: 0 = `.first()`, -1 = `.last()`, n = `.nth(n)`. Ranked after all others. */
  nth?: number;
  /** `ladder`: built from the element's facts. `mcp`: the code Playwright MCP suggested (FR-LO-07). */
  source: 'ladder' | 'mcp';
}

const METHOD_STRATEGY: Record<Exclude<Method, 'locator'>, Strategy> = {
  getByTestId: 'testid',
  getByRole: 'role',
  getByLabel: 'label',
  getByPlaceholder: 'placeholder',
  getByText: 'text',
};

export function spec(method: Method, arg: string, options?: LocatorSpec['options'], source: LocatorSpec['source'] = 'ladder'): LocatorSpec {
  const strategy = method === 'locator' ? (isXPath(arg) ? 'xpath' : 'css') : METHOD_STRATEGY[method];
  const clean = options && Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  return { strategy, method, arg, ...(clean && Object.keys(clean).length ? { options: clean } : {}), source };
}

const isXPath = (s: string) => s.startsWith('//') || s.startsWith('xpath=') || s.startsWith('(//');

/** Playwright code for the spec, e.g. `getByRole('button', { name: 'Login', exact: true })`. */
export function toCode(s: LocatorSpec): string {
  const opts = s.options ? Object.entries(s.options).map(([k, v]) => `${k}: ${typeof v === 'string' ? quote(v) : v}`) : [];
  const position = s.nth === undefined ? '' : s.nth === 0 ? '.first()' : s.nth === -1 ? '.last()' : `.nth(${s.nth})`;
  return `${s.method}(${quote(s.arg)}${opts.length ? `, { ${opts.join(', ')} }` : ''})${position}`;
}

export function toLocator(page: Page, s: LocatorSpec): Locator {
  const base = baseLocator(page, s);
  return s.nth === undefined ? base : s.nth === -1 ? base.last() : base.nth(s.nth);
}

function baseLocator(page: Page, s: LocatorSpec): Locator {
  switch (s.method) {
    case 'getByTestId':
      return page.getByTestId(s.arg);
    case 'getByRole':
      return page.getByRole(s.arg as Parameters<Page['getByRole']>[0], s.options);
    case 'getByLabel':
      return page.getByLabel(s.arg, s.options);
    case 'getByPlaceholder':
      return page.getByPlaceholder(s.arg, s.options);
    case 'getByText':
      return page.getByText(s.arg, s.options);
    case 'locator':
      return page.locator(s.arg);
  }
}

/** Two specs that would produce the same code are the same candidate. */
export const sameSpec = (a: LocatorSpec, b: LocatorSpec) => toCode(a) === toCode(b);

export function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/**
 * Reads one locator call as Playwright MCP prints it, e.g. `getByTestId('username')` or
 * `page.getByRole('button', { name: 'Login' }).click();`. Returns undefined for anything it
 * cannot represent (chains, regexes, frames), so an odd suggestion is skipped, not misread.
 */
export function parseLocatorCode(code: string, source: LocatorSpec['source'] = 'mcp'): LocatorSpec | undefined {
  let text = code
    .trim()
    .replace(/^await\s+/, '')
    .replace(/;$/, '');
  text = text.replace(/^page\./, '');
  const call = readCall(text);
  if (!call) return undefined;
  let rest = text.slice(call.end);
  let nth: number | undefined;
  const position = /^\.(?:(first)\(\)|(last)\(\)|nth\((\d+)\))/.exec(rest);
  if (position) {
    nth = position[1] ? 0 : position[2] ? -1 : Number(position[3]);
    rest = rest.slice(position[0].length);
  }
  // A trailing action such as `.click()` or `.fill('x')` is allowed and ignored.
  if (rest && !/^\.(click|dblclick|fill|press|check|uncheck|hover|selectOption|setInputFiles|clear|type|pressSequentially|focus)\(/.test(rest)) {
    return undefined;
  }
  const { method, args } = call;
  if (!(method in METHOD_STRATEGY) && method !== 'locator') return undefined;
  if (typeof args[0] !== 'string' || args.length > 2) return undefined;
  const options = args[1];
  if (options !== undefined) {
    if (typeof options !== 'object') return undefined;
    for (const [k, v] of Object.entries(options)) {
      if (!((k === 'name' && typeof v === 'string') || (k === 'exact' && typeof v === 'boolean'))) return undefined;
    }
  }
  const result = spec(method as Method, args[0], options as LocatorSpec['options'], source);
  return nth === undefined ? result : { ...result, nth };
}

type Value = string | boolean | Record<string, string | boolean>;

/** A tiny reader for `name(arg, arg)` where args are strings, booleans or flat objects of those. */
function readCall(text: string): { method: string; args: Value[]; end: number } | undefined {
  const head = /^([A-Za-z]+)\(/.exec(text);
  if (!head) return undefined;
  let i = head[0].length;
  const args: Value[] = [];

  const skip = () => {
    while (text[i] === ' ') i++;
  };
  const readString = (): string | undefined => {
    const q = text[i];
    if (q !== "'" && q !== '"' && q !== '`') return undefined;
    let out = '';
    for (i++; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        const n = text[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else if (c === q) {
        i++;
        return out;
      } else if (q === '`' && c === '$' && text[i + 1] === '{') return undefined;
      else out += c;
    }
    return undefined;
  };
  const readScalar = (): string | boolean | undefined => {
    for (const [word, value] of [
      ['true', true],
      ['false', false],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return value;
      }
    }
    return readString();
  };
  const readObject = (): Record<string, string | boolean> | undefined => {
    const obj: Record<string, string | boolean> = {};
    i++;
    for (;;) {
      skip();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      const key = /^[A-Za-z]+/.exec(text.slice(i))?.[0];
      if (!key) return undefined;
      i += key.length;
      skip();
      if (text[i++] !== ':') return undefined;
      skip();
      const v = readScalar();
      if (v === undefined) return undefined;
      obj[key] = v;
      skip();
      if (text[i] === ',') i++;
    }
  };

  for (;;) {
    skip();
    if (text[i] === ')') return { method: head[1], args, end: i + 1 };
    const v = text[i] === '{' ? readObject() : readScalar();
    if (v === undefined) return undefined;
    args.push(v);
    skip();
    if (text[i] === ',') i++;
    else if (text[i] !== ')') return undefined;
  }
}
