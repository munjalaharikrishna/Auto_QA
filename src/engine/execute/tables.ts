import type { Page } from 'playwright';
import { compactKey } from '../text/compound.js';
import { prepareFrame, visibleFrames } from '../locate/frames.js';
import { waitSettled } from './waits.js';

/**
 * Layer 31, table relational processing (UI-06). "Click Edit for John" is a table, a row of it, and an action inside the
 * row. This reads the tables of a page (their headers, rows, the actions in each row and the controls that turn pages),
 * finds the row that holds the values a step names, whichever page of the table it is on, and says which element in the
 * row is meant. A value that fits two rows is ambiguous: no row is picked (LA-01). Pages are turned with the page's own
 * controls, and only through the `go` function the caller gives, so that every click is made the same way as any other.
 */

export interface RowAction {
  name: string;
  xpath: string;
  disabled: boolean;
}

export interface TableRow {
  /** The place of the row in this page of the table. */
  index: number;
  xpath: string;
  cells: string[];
  actions: RowAction[];
}

export interface PageControl {
  label: string;
  xpath: string;
  current: boolean;
  disabled: boolean;
}

export interface TableModel {
  xpath: string;
  /** The iframes the table is in, outermost first; empty for the page itself. Every XPath of the table is read in that frame. */
  frame: string[];
  /** The name of the table: its label or caption. */
  name: string;
  headers: string[];
  rows: TableRow[];
  /** The controls that turn pages, when the table has them. */
  next?: PageControl;
  previous?: PageControl;
  pages: PageControl[];
}

/** Reads every table of the page. Runs in the page: self-contained, no regular expressions. */
export function readTables(): TableModel[] {
  const squash = (s: string | null | undefined): string => {
    let out = '';
    let space = false;
    for (const ch of s ?? '') {
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ' ') space = true;
      else {
        if (space && out) out += ' ';
        space = false;
        out += ch;
      }
    }
    return out;
  };
  const xpathOf = (el: Element): string => {
    const steps: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1) {
      const id = node.getAttribute('id');
      if (id && document.querySelectorAll(`[id="${id}"]`).length === 1) {
        steps.unshift(`//*[@id='${id}']`);
        break;
      }
      let n = 1;
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === node.tagName) n++;
      steps.unshift(`${node.tagName.toLowerCase()}[${n}]`);
      node = node.parentElement;
      if (node === document.documentElement) {
        steps.unshift('html[1]');
        break;
      }
    }
    return steps[0]?.startsWith('//') ? steps.join('/') : `/${steps.join('/')}`;
  };
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const nameOf = (el: Element): string =>
    squash(el.getAttribute('aria-label')) || squash((el as HTMLElement).innerText) || squash(el.getAttribute('value')) || squash(el.getAttribute('title'));
  const control = (el: Element): { label: string; xpath: string; current: boolean; disabled: boolean } => ({
    label: nameOf(el),
    xpath: xpathOf(el),
    current:
      el.getAttribute('aria-current') === 'page' ||
      el.getAttribute('aria-current') === 'true' ||
      el.classList.contains('active') ||
      el.classList.contains('current'),
    disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
  });

  const NEXT = ['next', '›', '»', '>', 'next page', '>>'];
  const PREVIOUS = ['previous', 'prev', '‹', '«', '<', 'previous page', '<<'];
  const tables = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]')).filter(shown);
  const out: TableModel[] = [];
  for (const table of tables) {
    const headers: string[] = [];
    for (const th of Array.from(table.querySelectorAll('th, [role="columnheader"]')))
      headers.push(squash((th as HTMLElement).innerText) || squash(th.getAttribute('aria-label')));
    const rows: TableRow[] = [];
    let index = 0;
    for (const tr of Array.from(table.querySelectorAll('tr, [role="row"]'))) {
      const cells = Array.from(tr.querySelectorAll('td, [role="cell"], [role="gridcell"]'));
      if (!cells.length || !shown(tr)) continue;
      const actions: RowAction[] = [];
      for (const a of Array.from(tr.querySelectorAll('button, a[href], input[type="button"], input[type="submit"], [role="button"], [role="link"]'))) {
        if (!shown(a)) continue;
        actions.push({
          name: nameOf(a),
          xpath: xpathOf(a),
          disabled: (a as HTMLButtonElement).disabled === true || a.getAttribute('aria-disabled') === 'true',
        });
      }
      rows.push({
        index: index++,
        xpath: xpathOf(tr),
        cells: cells.map((c) => squash((c as HTMLElement).innerText)),
        actions,
      });
    }
    // The controls that turn pages: the first group of them after the table that has a next control.
    let next: TableModel['next'];
    let previous: TableModel['previous'];
    let pages: TableModel['pages'] = [];
    const groups = Array.from(document.querySelectorAll('nav, [role="navigation"], [class*="pagination"], [aria-label*="agination" i]')).filter(shown);
    for (const group of groups) {
      if (table.contains(group)) continue;
      const buttons = Array.from(group.querySelectorAll('button, a, [role="button"]')).filter(shown);
      const found = buttons.find((b) => NEXT.includes(nameOf(b).toLowerCase()));
      if (!found) continue;
      next = control(found);
      const prev = buttons.find((b) => PREVIOUS.includes(nameOf(b).toLowerCase()));
      if (prev) previous = control(prev);
      // A page control is called by its number, whatever its accessible name says ("Page 2").
      pages = buttons
        .filter(
          (b) => b !== found && b !== prev && squash((b as HTMLElement).innerText) !== '' && Number.isInteger(Number(squash((b as HTMLElement).innerText))),
        )
        .map((b) => ({ ...control(b), label: squash((b as HTMLElement).innerText) }));
      break;
    }
    out.push({
      xpath: xpathOf(table),
      frame: [],
      name: squash(table.getAttribute('aria-label')) || squash(table.querySelector('caption')?.textContent),
      headers,
      rows,
      ...(next ? { next } : {}),
      ...(previous ? { previous } : {}),
      pages,
    });
  }
  return out;
}

export const tablesOf = async (page: Page): Promise<TableModel[]> => {
  const out: TableModel[] = [];
  for (const { frame, path } of await visibleFrames(page)) {
    await prepareFrame(frame);
    const tables = await frame.evaluate(readTables).catch((e) => {
      if (path.length === 0) throw e;
      return [] as TableModel[];
    });
    out.push(...tables.map((t) => ({ ...t, frame: path })));
  }
  return out;
};

const wordsOf = (text: string): string[] => {
  const words: string[] = [];
  let current = '';
  for (const ch of text.toLowerCase()) {
    if (ch.toLowerCase() !== ch.toUpperCase() || (ch >= '0' && ch <= '9')) current += ch;
    else if (current) {
      words.push(current);
      current = '';
    }
  }
  if (current) words.push(current);
  return words;
};

/**
 * Whether a cell holds a value: the same words, or the value's words are all among the cell's ("John" is in "John
 * Smith"). A value that is a part of a word is not in it ("5" is not in "15").
 */
export function cellHolds(cell: string, value: string): boolean {
  if (compactKey(cell) === compactKey(value)) return true;
  const want = wordsOf(value);
  const have = wordsOf(cell);
  return want.length > 0 && want.every((w) => have.includes(w));
}

export const rowHolds = (row: Pick<TableRow, 'cells'>, values: readonly string[]): boolean => values.every((v) => row.cells.some((c) => cellHolds(c, v)));

export type RowSearch =
  | { status: 'found'; row: TableRow; table: TableModel; pageLabel: string; pagesVisited: number }
  | { status: 'ambiguous'; rows: TableRow[]; table: TableModel; pageLabel: string; pagesVisited: number }
  | { status: 'not-found'; reason: string; pagesVisited: number };

export interface FindRowOptions {
  /** The most pages of a table that are looked at. */
  maxPages?: number;
  /** Clicks a control of the page, by its XPath. It is the caller's, so every click is made the same way. */
  go: (xpath: string, frame: readonly string[]) => Promise<void>;
}

/**
 * Finds the row that holds all the values, on any page of the table (UI-06). The search starts from the first page, so
 * where earlier steps left the table does not matter. One row is found, several are ambiguous, none is not found.
 */
export async function findRow(page: Page, values: readonly string[], options: FindRowOptions): Promise<RowSearch> {
  const limit = options.maxPages ?? 50;
  const settle = (): Promise<unknown> => waitSettled(page);
  const read = async (): Promise<TableModel | undefined> => {
    const all = await tablesOf(page);
    // The table with a row that holds the values, or else the biggest one: the data table of the page.
    return all.find((t) => t.rows.some((r) => rowHolds(r, values))) ?? [...all].sort((a, b) => b.rows.length - a.rows.length)[0];
  };

  let table = await read();
  if (!table) return { status: 'not-found', reason: 'there is no table on the page', pagesVisited: 0 };

  // To the first page: its number when the table shows numbers, else Previous until it is off.
  const first = table.pages.find((p) => p.label === '1' && !p.current);
  if (first) {
    await options.go(first.xpath, table.frame);
    await settle();
    table = (await read()) ?? table;
  }
  for (let back = 0; back < limit && table.previous && !table.previous.disabled; back++) {
    await options.go(table.previous.xpath, table.frame);
    await settle();
    table = (await read()) ?? table;
  }

  const seen = new Set<string>();
  for (let visited = 1; visited <= limit; visited++) {
    const label = table.pages.find((p) => p.current)?.label ?? String(visited);
    const matches = table.rows.filter((r) => rowHolds(r, values));
    if (matches.length === 1) return { status: 'found', row: matches[0] as TableRow, table, pageLabel: label, pagesVisited: visited };
    if (matches.length > 1) return { status: 'ambiguous', rows: matches, table, pageLabel: label, pagesVisited: visited };
    // Another page: the next control, or the next number not yet seen. A page that looks the same as one seen ends the search.
    const signature = table.rows.map((r) => r.cells.join('|')).join('\n');
    if (seen.has(signature)) break;
    seen.add(signature);
    const nextNumber = table.pages.find((p) => !p.current && !p.disabled && Number(p.label) > Number(label));
    const control = table.next && !table.next.disabled ? table.next : nextNumber;
    if (!control) {
      return {
        status: 'not-found',
        reason: `no row holds ${values.map((v) => `"${v}"`).join(' and ')} on any of the ${visited} page(s)`,
        pagesVisited: visited,
      };
    }
    await options.go(control.xpath, table.frame);
    await settle();
    const again = await read();
    if (!again) break;
    table = again;
  }
  return { status: 'not-found', reason: `no row holds ${values.map((v) => `"${v}"`).join(' and ')} in ${seen.size} page(s)`, pagesVisited: seen.size };
}
