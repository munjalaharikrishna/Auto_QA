/**
 * Step numbering (IN-18): `1.`, `1)`, `Step 1:`. Steps are put in the order of their numbers, and a number that is
 * skipped or used twice is reported, never silently guessed. A sheet that is already in order is returned unchanged.
 */

export interface Ordered<T> {
  parts: T[];
  reordered: boolean;
  /** One sentence per skipped or repeated number. */
  gaps: string[];
}

/** The number in "Step 3", " Step  1", "3.": the first run of digits. */
export const numberIn = (text?: string): number | undefined => {
  const m = /\d+/.exec(text ?? '');
  return m ? Number(m[0]) : undefined;
};

function gapsOf(numbers: number[]): string[] {
  const out: string[] = [];
  if (numbers.length && numbers[0] > 1) out.push(`the first step is numbered ${numbers[0]}, not 1.`);
  for (let i = 1; i < numbers.length; i++) {
    const [a, b] = [numbers[i - 1], numbers[i]];
    if (b === a) out.push(`step number ${b} is used twice.`);
    else if (b > a + 1) out.push(`the step numbers jump from ${a} to ${b}.`);
  }
  return out;
}

/** The rows of a test case in the order of their "Step N" cells. Without a number on every row there is nothing to order by. */
export function orderParts<T extends { stepNo?: string }>(parts: T[]): Ordered<T> {
  const numbers = parts.map((p) => numberIn(p.stepNo));
  if (!parts.length || numbers.some((n) => n === undefined)) return { parts, reordered: false, gaps: [] };
  const order = parts.map((p, i) => ({ p, n: numbers[i] as number, i })).sort((a, b) => a.n - b.n || a.i - b.i);
  return {
    parts: order.map((o) => o.p),
    reordered: order.some((o, k) => o.i !== k),
    gaps: gapsOf(order.map((o) => o.n)),
  };
}

const NUMBERED = /^\s*(?:step\s*)?(\d{1,3})\s*[.):-]\s*(\S.*)$/i;

/**
 * A cell whose every line is numbered ("2. b\n1. a"): the lines in the order of their numbers, renumbered 1, 2, 3, so a gap
 * (1, 2, 4) cannot make the parser join two steps. A cell with an unnumbered line, or numbers already in order and without a
 * gap, is returned as it is.
 */
export function orderNumbered(cell: string): { text: string; reordered: boolean; gaps: string[] } {
  const lines = cell
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const items = lines.map((l, i) => {
    const m = NUMBERED.exec(l);
    return m ? { n: Number(m[1]), text: m[2].trim(), i } : undefined;
  });
  if (lines.length < 2 || items.some((x) => !x)) return { text: cell, reordered: false, gaps: [] };
  const numbered = (items as Array<{ n: number; text: string; i: number }>).slice().sort((a, b) => a.n - b.n || a.i - b.i);
  const reordered = numbered.some((x, k) => x.i !== k);
  const gaps = gapsOf(numbered.map((x) => x.n));
  if (!reordered && !gaps.length) return { text: cell, reordered, gaps };
  return { text: numbered.map((x, k) => `${k + 1}. ${x.text}`).join('\n'), reordered, gaps };
}
