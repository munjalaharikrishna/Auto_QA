import type { Screen } from '../engine/knowledge/screens.js';
import { readsAs } from '../learning/examples.js';
import type { TestVerdict } from '../results/verdict.js';

/**
 * E0.19 step 4, the one-click rewrite: for a card that asks what a sentence means, sentences the engine can run, built from what the
 * application was seen to show on the screens the case reached (or, when it kept none, the screens of the project about the same thing) (names of buttons, links, fields and headings). Each one is read by the
 * engine before it is offered, so a click saves an answer that runs. Nothing is made up: a name that was not on a screen is never
 * offered, and when no name fits, the engine's own template is given to fill in, never as one click.
 */

export interface Suggestion {
  /** The sentence, ready to save. */
  text: string;
  /** In words: where it comes from. */
  why: string;
}

export interface Suggestions {
  /** Ready sentences, best first, each read by the engine as a real step or check. At most three. */
  ready: Suggestion[];
  /** The engine's own pattern, with the part a person fills in still in angle brackets. */
  template?: string;
}

const MAX = 3;

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split('')
    .map((c) => ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ? c : ' '))
    .join('')
    .split(' ')
    .filter(Boolean);

/** Two words are the same when equal, or (both of five letters or more) one letter apart: "Broswer" is "browser", "Enployee" "employee". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  // One edit, or two letters swapped.
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  if (a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1)) return true;
  return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/** The sentence names the name: every word of the name is in the sentence, in order, allowing a typo per word. */
function mentions(sentence: readonly string[], name: string): boolean {
  const want = words(name);
  if (!want.length) return false;
  let at = 0;
  for (const w of want) {
    while (at < sentence.length && !sameWord(sentence[at] as string, w)) at += 1;
    if (at === sentence.length) return false;
    at += 1;
  }
  return true;
}

const ROLE_WORD: Record<string, string> = { button: 'button', link: 'link', textbox: 'field', combobox: 'dropdown', checkbox: 'checkbox', heading: 'heading' };

/** Names seen on screens with different titles are the application's menu and frame, not what a step is about. */
function everywhere(screens: readonly Screen[]): Set<string> {
  const titles = new Map<string, Set<string>>();
  for (const sc of screens)
    for (const e of sc.elements) {
      if (!titles.has(e.name)) titles.set(e.name, new Set());
      titles.get(e.name)?.add(sc.title ?? sc.key);
    }
  return new Set([...titles].filter(([, t]) => t.size >= 2).map(([n]) => n));
}

const PLAIN_NAME = (n: string): boolean => n.trim().length > 1 && n.length <= 60 && !n.includes('[') && !n.toLowerCase().startsWith('sort ');

const COMMON = new Set([
  'should',
  'user',
  'users',
  'click',
  'verify',
  'page',
  'section',
  'with',
  'that',
  'this',
  'into',
  'from',
  'there',
  'their',
  'able',
  'will',
]);

/** The screens of the project, the closest to the sentence first: those whose name shares a word with it. */
function related(said: readonly string[], all: readonly Screen[]): Screen[] {
  const content = said.filter((w) => w.length >= 4 && !COMMON.has(w));
  const score = (s: Screen) => words([s.title ?? '', ...s.headings, ...s.tables.flat()].join(' ')).filter((w) => content.some((c) => sameWord(c, w))).length;
  return all
    .map((s) => ({ s, n: score(s) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.s);
}

/** The sentences to try, each with why; the engine reads them afterwards. */
function candidates(
  sentence: string,
  kind: 'step' | 'check',
  why: string,
  own: readonly Screen[],
  byCase: ReadonlyMap<string, readonly Screen[]>,
): Suggestion[] {
  const out: Suggestion[] = [];
  const said = words(sentence);
  const all = uniqueScreens([...own, ...[...byCase.values()].flat()]);
  const menu = everywhere(all);
  const screens = own.length ? own : related(said, all);

  // A step that names a kind of thing but not which one ("Click on Employee Name"): the items listed on the screen it was on, or on the
  // screens of the project that are about the same thing. A person picks which one is meant.
  if (kind === 'step' && (why.includes('names no') || why.includes('which') || why.includes('equal'))) {
    const where = own.length ? [own[own.length - 1] as Screen] : screens;
    for (const s of where)
      for (const e of s.elements)
        if (e.role === 'link' && !menu.has(e.name) && PLAIN_NAME(e.name) && !mentions(said, e.name) && !s.headings.includes(e.name))
          out.push({ text: `Click "${e.name}"`, why: `"${e.name}" is listed on the screen "${s.title ?? s.key}"` });
  }

  // A sentence that names an element of a screen it reached: a check that the element is there, in the part the sentence names.
  for (const s of screens) {
    const heading = [...s.headings, ...(s.title ? [s.title] : [])].find((h) => PLAIN_NAME(h) && mentions(said, h));
    for (const e of s.elements) {
      const role = ROLE_WORD[e.role];
      if (!role || role === 'heading' || menu.has(e.name) || !PLAIN_NAME(e.name)) continue;
      if (!mentions(said, e.name) || !said.some((w) => sameWord(w, role) || (role === 'field' && sameWord(w, 'textbox')))) continue;
      const where = heading && heading !== e.name ? ` in the "${heading}" section` : '';
      out.push({ text: `The "${e.name}" ${role} is shown${where}`, why: `the ${role} "${e.name}" is on the screen "${s.title ?? s.key}"` });
    }
    if (heading) out.push({ text: `The "${heading}" heading is shown`, why: `"${heading}" is what the screen calls itself` });
  }

  // "Browser should be opened", "application is launched": what the first screen the case reached shows.
  const opens = said.some((w) => sameWord(w, 'opened') || sameWord(w, 'open') || sameWord(w, 'launched') || sameWord(w, 'launch'));
  const app = said.some((w) => sameWord(w, 'browser') || sameWord(w, 'application') || w === 'app' || w === 'site');
  const first = own[0] ?? firstScreen(byCase);
  if (opens && app && first) {
    const heading = first.headings.find(PLAIN_NAME);
    const button = first.elements.find((e) => e.role === 'button' && PLAIN_NAME(e.name));
    if (heading) out.push({ text: `The "${heading}" heading is shown`, why: 'what the first screen of the case shows once the browser is open' });
    else if (button) out.push({ text: `The "${button.name}" button is shown`, why: 'what the first screen of the case shows once the browser is open' });
  }
  return out;
}

function uniqueScreens(list: readonly Screen[]): Screen[] {
  const seen = new Map<string, Screen>();
  for (const s of list) if (!seen.has(s.key)) seen.set(s.key, s);
  return [...seen.values()];
}

/** The screen most cases of the project reached first: where the application opens. */
function firstScreen(byCase: ReadonlyMap<string, readonly Screen[]>): Screen | undefined {
  const count = new Map<string, { s: Screen; n: number }>();
  for (const list of byCase.values()) {
    const s = list[0];
    if (s) count.set(s.key, { s, n: (count.get(s.key)?.n ?? 0) + 1 });
  }
  return [...count.values()].sort((a, b) => b.n - a.n)[0]?.s;
}

/** The engine's own pattern from its advice ("Name the employee: Click on "<the name>" in the list, ..."), to fill in. */
export function templateOf(v: TestVerdict): string | undefined {
  for (const r of v.review ?? [])
    for (const todo of r.todo) {
      const lt = todo.indexOf('<');
      if (lt < 0) continue;
      const colon = todo.lastIndexOf(':', lt);
      let t = (colon >= 0 ? todo.slice(colon + 1) : todo).trim();
      const cut = [', or ', '; ', ' or give it'].map((s) => t.indexOf(s)).filter((i) => i > 0);
      if (cut.length) t = t.slice(0, Math.min(...cut));
      if (t.startsWith('for example')) t = t.slice('for example'.length).trim();
      if (t.endsWith('.')) t = t.slice(0, -1);
      const quotes = t.split('"').length - 1;
      if (t.includes('<') && t.length <= 160 && quotes % 2 === 0) return t;
    }
  return undefined;
}

/**
 * The suggestions for one question. Each candidate is read by the engine as the kind of sentence it replaces (or the other kind, as an
 * answer may be): only those it reads as a real step or check are offered.
 */
export async function suggestionsFor(
  question: { sentence: string; kind: 'step' | 'check'; why: string },
  verdict: TestVerdict,
  own: readonly Screen[],
  byCase: ReadonlyMap<string, readonly Screen[]> = new Map(),
): Promise<Suggestions> {
  const ready: Suggestion[] = [];
  const seen = new Set<string>();
  for (const c of candidates(question.sentence, question.kind, question.why, own, byCase)) {
    if (ready.length >= MAX) break;
    const key = c.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const asStep = c.text.startsWith('Click ');
    const reading = await readsAs(asStep ? 'step' : 'check', c.text);
    // A step must come out as an action on a named target; a check as at least one check with a target or a value.
    if (!reading) continue;
    const parts = reading.split('|');
    if (asStep ? !parts[0] || !parts[2] : !parts.some((p) => p && p !== 'not')) continue;
    ready.push(c);
  }
  const template = templateOf(verdict);
  return { ready, ...(template ? { template } : {}) };
}
