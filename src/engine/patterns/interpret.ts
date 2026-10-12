import type { PatternMatch } from './engine.js';

/** Reads the meaning out of a match, so no other layer has to look inside one. */

/** The text inside the quotes of a `quotedString` match, exactly as written (NM-18). */
export const quotedValue = (m: PatternMatch): string => m.groups.find((g) => g !== undefined) ?? '';

/** The value a `testDataQuoted` match carries, with the field it was entered in when the sentence names one. */
export function testDataOf(m: PatternMatch): { value: string; field?: string } {
  const value = m.named.v1 ?? m.named.v2 ?? m.named.v3 ?? m.named.v4 ?? '';
  return m.named.field ? { value, field: m.named.field.trim() } : { value };
}

export type BrowserCommand = 'back' | 'forward' | 'refresh' | 'newTab' | 'closeTab';

export function browserCommandOf(m: PatternMatch): BrowserCommand | undefined {
  for (const name of ['back', 'forward', 'refresh', 'newTab', 'closeTab'] as const) if (m.named[name] !== undefined) return name;
  return undefined;
}

const UNIT_MS: Array<[prefix: string, ms: number]> = [
  ['ms', 1],
  ['milli', 1],
  ['sec', 1000],
  ['s', 1000],
  ['min', 60000],
  ['m', 60000],
];

/** `wait 5 seconds` → 5000. It is a hint for the wait strategy, never a fixed sleep (UI-09). */
export function waitMs(m: PatternMatch): number | undefined {
  const n = Number(m.named.n);
  const unit = (m.named.u ?? '').toLowerCase();
  const entry = UNIT_MS.find(([prefix]) => unit === prefix || (prefix.length > 2 && unit.startsWith(prefix)));
  return Number.isFinite(n) && entry ? Math.round(n * entry[1]) : undefined;
}

const KEY_NAMES: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};

/** The key or combination of a `keyboardKey` match in Playwright's spelling: `Shift+Tab`, `Control+A`, `Enter`. */
export function keyOf(m: PatternMatch): string | undefined {
  const raw = m.named.key ?? m.named.combo;
  if (!raw) return undefined;
  return raw
    .split('+')
    .map((part) => {
      const squashed = part.split(' ').join('').trim().toLowerCase();
      return KEY_NAMES[squashed] ?? squashed.toUpperCase();
    })
    .join('+');
}

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const DATE_SPLIT = /[/.-]/;

/**
 * The calendar date of a numeric `date` match in the project's day/month order (RX-05). A date that reads two ways,
 * such as `03/04/2024`, is returned with `ambiguous: true` so the caller can ask instead of guessing.
 */
export function dateOf(text: string, order: DateOrder = 'dmy'): { year: number; month: number; day: number; ambiguous: boolean } | undefined {
  const parts = text.split(DATE_SPLIT);
  if (parts.length !== 3) return undefined;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n))) return undefined;
  const [a, b, c] = nums as [number, number, number];
  if (parts[0]?.length === 4) return { year: a, month: b, day: c, ambiguous: false };
  const [day, month] = order === 'mdy' ? [b, a] : [a, b];
  if (month > 12 || day > 31 || month < 1 || day < 1) return undefined;
  return { year: c < 100 ? 2000 + c : c, month, day, ambiguous: a <= 12 && b <= 12 && a !== b };
}
