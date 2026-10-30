import { z } from 'zod';
import { labelKey } from './labels.js';

/**
 * Screen models (E0.14, PD-13): what each screen of the application holds, learned from the screens the runs reach and from the
 * walkthrough. No page is visited for this alone: a screen is known because a test case went there. A screen is found again by its
 * key (the address that chooses it, and the open dialog); an element is found again by an identity that does not change when its
 * label does, so a new capture can say "renamed" and not "removed and added". A screen model never holds a value typed or shown.
 */

export const ScreenElementSchema = z.object({
  /** The identity that stays when the label changes: see `elementIdentity`. */
  id: z.string().min(1),
  role: z.string(),
  /** What a person would call it. */
  name: z.string(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  type: z.string().optional(),
  testId: z.string().optional(),
  htmlId: z.string().optional(),
  nameAttr: z.string().optional(),
  /** The iframes it is inside, outermost first; empty for the main page. */
  frame: z.array(z.string()).default([]),
  /** The named containers it is inside, nearest first. */
  inside: z.array(z.string()).default([]),
});
export type ScreenElement = z.infer<typeof ScreenElementSchema>;

export const ScreenSchema = z.object({
  /** `screenKeyOf`: the same screen has the same key in every run. */
  key: z.string().min(1),
  /** What the screen calls itself: its dialog, else its first heading, else the page title. */
  title: z.string().optional(),
  headings: z.array(z.string()).default([]),
  /** The column headers of each table on it. */
  tables: z.array(z.array(z.string())).default([]),
  elements: z.array(ScreenElementSchema).default([]),
  /** Where it was learned: a run reached it, or a person showed it in a walkthrough. */
  source: z.enum(['run', 'walkthrough']).default('run'),
  /** The test cases that reached it. */
  cases: z.array(z.string()).default([]),
  /** When it was last seen (ISO time). */
  seenAt: z.string().optional(),
  /**
   * Words a person gave for elements on this screen in a walkthrough (E0.14b): on this screen, `word` means the element named `means`.
   * A person's word wins over what a run found by itself; it holds on this screen only.
   */
  words: z.array(z.object({ word: z.string().min(1), means: z.string().min(1), element: z.string().optional() })).default([]),
});
export type Screen = z.infer<typeof ScreenSchema>;

/** An id the page makes up for each load (`:r3:`, `ember1234`, `ext-gen-5521`): it does not identify the element next time. */
function generated(id: string): boolean {
  if (id.startsWith(':')) return true;
  let run = 0;
  for (const ch of id) {
    run = ch >= '0' && ch <= '9' ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}

/** Roles whose `name` attribute is shared by a group (one name for every option of a radio group). */
const GROUPED: ReadonlySet<string> = new Set(['radio', 'checkbox', 'option']);

/**
 * What identifies an element across captures of its screen. Its test id first, then a stable `id`, then the `name` of a form field;
 * only an element with none of these is known by its role, label and container, and for that one a changed label is a new element.
 */
export function elementIdentity(e: {
  role: string;
  name: string;
  label?: string;
  testId?: string;
  htmlId?: string;
  nameAttr?: string;
  frame?: readonly string[];
  inside?: readonly string[];
}): string {
  const where = e.frame?.length ? `${e.frame.join('>')}|` : '';
  if (e.testId) return `${where}testid=${e.testId}`;
  if (e.htmlId && !generated(e.htmlId)) return `${where}id=${e.htmlId}`;
  if (e.nameAttr) return `${where}${e.role}|name=${e.nameAttr}${GROUPED.has(e.role) ? `|${labelKey(e.label || e.name)}` : ''}`;
  return `${where}${e.role}|${labelKey(e.label || e.name)}|${labelKey(e.inside?.[0] ?? '')}`;
}

/**
 * Two lists of screens as one: a screen seen again keeps every element seen before (a message shows only after a click) and takes the
 * newer name of each, its newer headings and tables, and the cases of both. Screens and elements stay in the order first seen.
 */
export function mergeScreens(older: readonly Screen[], newer: readonly Screen[]): Screen[] {
  const out = new Map<string, Screen>(older.map((s) => [s.key, copy(s)]));
  for (const s of newer) {
    const was = out.get(s.key);
    if (!was) {
      out.set(s.key, copy(s));
      continue;
    }
    const elements = new Map(was.elements.map((e) => [e.id, e]));
    for (const e of s.elements) elements.set(e.id, { ...e });
    out.set(s.key, {
      ...was,
      ...(s.title ? { title: s.title } : {}),
      headings: s.headings.length ? [...s.headings] : was.headings,
      tables: s.tables.length ? s.tables.map((t) => [...t]) : was.tables,
      elements: [...elements.values()],
      // A screen a person showed stays a person's, whatever a run saw since.
      source: was.source === 'walkthrough' || s.source === 'walkthrough' ? 'walkthrough' : 'run',
      cases: [...new Set([...was.cases, ...s.cases])],
      ...(s.seenAt ? { seenAt: s.seenAt } : {}),
      words: mergeWords(was.words, s.words),
    });
  }
  return [...out.values()];
}

const copy = (s: Screen): Screen => ({
  ...s,
  headings: [...s.headings],
  tables: s.tables.map((t) => [...t]),
  elements: s.elements.map((e) => ({ ...e, frame: [...e.frame], inside: [...e.inside] })),
  cases: [...s.cases],
  words: s.words.map((w) => ({ ...w })),
});

/** The words of two captures: a word given again takes its newer meaning. */
function mergeWords(older: Screen['words'], newer: Screen['words']): Screen['words'] {
  const out = new Map(older.map((w) => [labelKey(w.word), { ...w }]));
  for (const w of newer) out.set(labelKey(w.word), { ...w });
  return [...out.values()];
}

/** What a person said a word means on this screen (E0.14b): the name, and the element picked when there is one; or nothing. */
export function screenWord(screen: Screen | undefined, phrase: string): { means: string; element?: string } | undefined {
  const key = labelKey(phrase);
  const w = screen?.words.find((x) => labelKey(x.word) === key);
  return w ? { means: w.means, ...(w.element ? { element: w.element } : {}) } : undefined;
}

export interface ScreenChange {
  screen: string;
  change: 'screen added' | 'added' | 'removed' | 'renamed';
  /** `role "name"`, and for a rename `role "old" → "new"`. */
  what: string;
}

/**
 * What changed between two captures of the same screens: elements added, removed and renamed (same identity, another name). A screen
 * only in `after` is one line, not one line per element. Screens only in `before` are not reported: a run that did not go there says
 * nothing about them.
 */
export function diffScreens(before: readonly Screen[], after: readonly Screen[]): ScreenChange[] {
  const out: ScreenChange[] = [];
  const old = new Map(before.map((s) => [s.key, s]));
  const show = (e: ScreenElement): string => `${e.role} "${e.label || e.name}"`;
  for (const s of after) {
    const was = old.get(s.key);
    if (!was) {
      out.push({ screen: s.key, change: 'screen added', what: s.title ?? s.key });
      continue;
    }
    const then = new Map(was.elements.map((e) => [e.id, e]));
    const now = new Map(s.elements.map((e) => [e.id, e]));
    for (const [id, e] of now) {
      const t = then.get(id);
      if (!t) out.push({ screen: s.key, change: 'added', what: show(e) });
      else if ((t.label || t.name) !== (e.label || e.name)) out.push({ screen: s.key, change: 'renamed', what: `${show(t)} → "${e.label || e.name}"` });
    }
    for (const [id, e] of then) if (!now.has(id)) out.push({ screen: s.key, change: 'removed', what: show(e) });
  }
  return out;
}
