import { compactKey } from '../text/compound.js';

/** Whether a table row holds the values a step names it by (UI-06, E0.17 item 4). Pure: the judge and the run use the same rules. */

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

/** The most cells next to each other one value may run across: "Anita | Kumari | Rao" for a name kept in three columns. */
const MAX_SPAN = 4;

/**
 * Whether a value runs across cells next to each other, its words in order and nothing between them (E0.17 item 4): "Anita Kumari Rao"
 * is in a row whose First, Middle and Last Name cells are Anita, Kumari and Rao. Empty cells between them are skipped; any other text
 * between them breaks it, so a first name in one row is not joined to a last name in another column by chance.
 */
export function cellsHold(cells: readonly string[], value: string): boolean {
  const want = wordsOf(value);
  if (want.length < 2) return false;
  for (let start = 0; start < cells.length; start++) {
    const words: string[] = [];
    let used = 0;
    for (let end = start; end < cells.length && used < MAX_SPAN; end++) {
      const cell = wordsOf(cells[end] ?? '');
      if (!cell.length) continue;
      words.push(...cell);
      used++;
      if (used < 2) continue;
      if (words.length === want.length && words.every((w, i) => w === want[i])) return true;
      if (words.length >= want.length) break;
    }
  }
  return false;
}

export const rowHolds = (row: { cells: readonly string[] }, values: readonly string[]): boolean =>
  values.every((v) => row.cells.some((c) => cellHolds(c, v)) || cellsHold(row.cells, v));
