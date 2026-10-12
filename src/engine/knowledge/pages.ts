import { compactKey } from '../text/compound.js';
import { consolidate, keysOf, labelKey } from './labels.js';
import type { Application, Page } from './schema.js';

/**
 * Layer 21, the page knowledge base in use (PK-01): a name in a step ("the Add Employee page/popup") is brought to the
 * page the application's knowledge stores, and a page that was reached is checked to be the right one by its route and
 * by the elements that identify it.
 */

/** Words that say what kind of place a name is, not which one. */
const PLACE_WORDS: ReadonlySet<string> = new Set(['page', 'popup', 'pop-up', 'screen', 'section', 'window', 'dialog', 'form', 'tab', 'the']);

/** The names a phrase can stand for: "Add Employee page/popup" is "Add Employee page" or "Add Employee popup". */
export function pageNames(phrase: string): string[] {
  const alternatives = phrase.split('/').map((s) => s.trim());
  // "Add Employee page/popup": the first alternative holds the name, the others only repeat the kind of place.
  const head = alternatives[0] ?? phrase;
  const out = new Set<string>();
  for (const text of [phrase, head, ...alternatives]) {
    const words: string[] = [];
    let current = '';
    for (const ch of text.toLowerCase()) {
      if (ch.toLowerCase() !== ch.toUpperCase() || (ch >= '0' && ch <= '9') || ch === '-') current += ch;
      else if (current) {
        words.push(current);
        current = '';
      }
    }
    if (current) words.push(current);
    const kept = words.filter((w) => !PLACE_WORDS.has(w));
    if (kept.length) out.add(compactKey(kept.join(' ')));
  }
  return [...out];
}

export interface PageResolution {
  status: 'one' | 'many' | 'none';
  pages: Page[];
}

/** The page of the knowledge a phrase names: exactly one, or several (never a choice between them), or none. */
export function resolvePage(kb: Application | undefined, phrase: string): PageResolution {
  const wanted = pageNames(phrase);
  const found = (kb?.pages ?? []).filter((p) => [p.name, ...p.aliases].some((n) => pageNames(n).some((k) => wanted.includes(k))));
  return { status: found.length === 0 ? 'none' : found.length === 1 ? 'one' : 'many', pages: found };
}

/** What the page tells the engine to look at: the key components, for identity (PK-01). */
export const keyComponents = (page: Page): Page['components'] => page.components.filter((c) => c.key);

/** One element of the page as seen, as far as identity is concerned: its names. */
export interface SeenElement {
  name?: string;
  text?: string;
  labels?: string[];
  testId?: string;
}

export interface Identity {
  ok: boolean;
  /** `ok`: the route is the page's. `mismatch`: another route. `unknown`: the page has no route stored. */
  route: 'ok' | 'mismatch' | 'unknown';
  found: string[];
  missing: string[];
  because: string;
}

/**
 * Whether the page reached is the stored page: its route is the stored route, and the key elements are on it. A page
 * without key elements and without a route cannot be told from any other, and is never reported as identified.
 */
export function identifyPage(page: Page, seen: { path: string; elements: readonly SeenElement[] }): Identity {
  const route: Identity['route'] = page.route === undefined ? 'unknown' : stripQuery(seen.path) === stripQuery(page.route) ? 'ok' : 'mismatch';
  const have = new Set<string>();
  for (const e of seen.elements) for (const t of [e.name, e.text, e.testId, ...(e.labels ?? [])]) if (t) have.add(labelKey(t));
  const found: string[] = [];
  const missing: string[] = [];
  for (const c of keyComponents(page)) (keysOf(c).some((k) => have.has(k)) ? found : missing).push(c.name);
  const hasEvidence = page.route !== undefined || keyComponents(page).length > 0;
  const ok = hasEvidence && route !== 'mismatch' && missing.length === 0;
  const because = !hasEvidence
    ? `"${page.name}" has no route and no key element stored: it cannot be told from another page`
    : route === 'mismatch'
      ? `the address is ${seen.path}, not ${page.route}`
      : missing.length
        ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the page`
        : `${page.route ? 'the address' : 'the key elements'} fit${found.length ? ` and ${found.join(', ')} ${found.length === 1 ? 'is' : 'are'} on the page` : ''}`;
  return { ok, route, found, missing, because };
}

const stripQuery = (path: string): string => {
  const marks = [path.indexOf('?'), path.indexOf('#')].filter((i) => i >= 0);
  const cut = marks.length ? Math.min(...marks) : -1;
  return (cut < 0 ? path : path.slice(0, cut)).split('/').filter(Boolean).join('/').toLowerCase();
};

/** The component of a page by any of its names (LU-01 on one page). */
export const componentOnPage = (page: Page, name: string) =>
  consolidate(
    { version: 1, name: '-', pages: [page], roles: [], modules: [], rules: [], navigation: [], authentication: { mfa: 'none' }, vocabulary: [] },
    name,
  );
