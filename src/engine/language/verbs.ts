import type { IrAction } from '../ir/schema.js';
import { matchSlots } from './slots.js';
import { SYNONYM_SETS } from './synonyms.js';
import { VERBS, type VerbDef } from './vocabulary.js';

/**
 * The one verb table (E0.15, audit U7). Every word or phrase that starts an action, in one place, for every reader: the clause
 * parser (is this the start of a clause?), the grammar (which action?) and the lint. Before it, the clause parser knew the 31
 * verbs and the grammar also knew their synonyms, so "Return to the list and verify …" was one clause to one and two to the
 * other.
 *
 * It is built from the lists that own the words (PD-6): the 31 verbs of VO-01 with every written form, the Action synonyms
 * (SY-02), and the Navigation phrases that are actions on their own. Nothing is guessed from an ending.
 */

export interface VerbHit {
  /** The canonical verb: `enter`, `click`, `open application`, `go back`, `leave`, `wait`. */
  verb: string;
  action: IrAction;
  /** How many words the verb takes. */
  length: number;
  /** The tester's words, when they are a synonym of the verb ("tap on" for click). */
  via?: string;
  /** Whether the words can begin a command: the base form, the third person or the -ing form; never a past participle. */
  command: boolean;
  /** The VO-01 verb, when it is one of the 31. */
  def?: VerbDef;
}

interface Entry {
  words: readonly string[];
  verb: string;
  action: IrAction;
  command: boolean;
  synonym: boolean;
  def?: VerbDef;
  /** A shape the clause must have for the word to be a verb at all ("leave" is one only in "leave X blank"). */
  needs?: string;
}

const ENTRIES: Entry[] = [];
const add = (e: Entry): void => {
  ENTRIES.push(e);
};

// The Navigation phrases that are actions on their own: starting the application, going back or forward.
const NAV_ACTIONS: Readonly<Record<string, IrAction>> = { 'open application': 'NAVIGATE', 'go back': 'BACK', 'go forward': 'FORWARD' };
for (const entry of SYNONYM_SETS.Navigation.entries) {
  const action = NAV_ACTIONS[entry.canonical];
  if (!action) continue;
  for (const phrase of [entry.canonical, ...entry.phrases])
    add({ words: phrase.split(' '), verb: entry.canonical, action, command: true, synonym: phrase !== entry.canonical });
}

// The 31 verbs, every written form. A past participle ("entered") begins a description, not a command.
for (const def of VERBS)
  for (const [k, form] of def.forms.entries())
    add({ words: [form], verb: def.verb, action: def.action, def, synonym: false, command: k < 2 || form.endsWith('ing') });

// The Action synonyms: phrases that stand for one of the verbs ("tap on" is click, "return to" is navigate).
for (const entry of SYNONYM_SETS.Action.entries) {
  const def = VERBS.find((v) => v.verb === entry.canonical);
  if (!def) continue;
  for (const phrase of entry.phrases) add({ words: phrase.split(' '), verb: def.verb, action: def.action, def, synonym: true, command: true });
}

// "Leave the Code field blank": a field left empty on purpose. Only in that shape: "Admin, Leave, Time are visible" names a tab.
add({ words: ['leave'], verb: 'leave', action: 'ENTER_VALUE', command: true, synonym: false, needs: 'leave {target} (blank|empty) {rest?}' });

// "Wait 5 seconds": not one of the 31 verbs, read by its own pattern (RX-17): until the page is idle, never a fixed sleep (UI-09).
for (const w of ['wait', 'pause', 'sleep', 'delay']) add({ words: [w], verb: 'wait', action: 'WAIT', command: true, synonym: w !== 'wait' });

const navFirst = ENTRIES.filter((e) => e.action !== 'ENTER_VALUE' && e.verb in NAV_ACTIONS).sort((a, b) => b.words.length - a.words.length);
const single = ENTRIES.filter((e) => !e.synonym && !(e.verb in NAV_ACTIONS) && e.words.length === 1);
const phrases = ENTRIES.filter((e) => e.synonym && !(e.verb in NAV_ACTIONS)).sort((a, b) => b.words.length - a.words.length);

const hitOf = (e: Entry): VerbHit => ({
  verb: e.verb,
  action: e.action,
  length: e.words.length,
  command: e.command,
  ...(e.synonym ? { via: e.words.join(' ') } : {}),
  ...(e.def ? { def: e.def } : {}),
});

const fits = (e: Entry, words: readonly string[], i: number): boolean =>
  e.words.every((w, k) => words[i + k] === w) && (!e.needs || matchSlots(e.needs, words, i) !== undefined);

/**
 * The verb that starts at word `i`, or undefined. In this order: a navigation phrase ("open the application", "go back"), then
 * one of the 31 verbs as written, then a synonym phrase, the longest first.
 */
export function verbAt(words: readonly string[], i: number): VerbHit | undefined {
  for (const group of [navFirst, single, phrases]) {
    const e = group.find((x) => fits(x, words, i));
    if (e) return hitOf(e);
  }
  return undefined;
}

/** Whether the words at `i` begin a command: a verb of the table in a form that gives orders ("click", "clicks", "clicking"). */
export const commandAt = (words: readonly string[], i: number): boolean => verbAt(words, i)?.command === true;

/** Every entry, for the vocabulary document and the tests. */
export const verbTable = (): ReadonlyArray<{ words: string; verb: string; action: IrAction; command: boolean }> =>
  ENTRIES.map((e) => ({ words: e.words.join(' '), verb: e.verb, action: e.action, command: e.command }));
