import type { IrAction } from '../ir/schema.js';

/**
 * Layer 5, the controlled QA vocabulary (VO-01, VO-02). The words a test step may start with, written out in full:
 * every word form is on a list the engine owns (PD-6), nothing is guessed from an ending. A verb that is on no list is
 * not an action: it is "not understood" unless a synonym (SY-02) maps it to one of these.
 */

export interface VerbDef {
  /** The canonical verb. */
  verb: string;
  /** What it does in QA-IR. */
  action: IrAction;
  /** Every written form: base, third person, past, -ing. */
  forms: readonly string[];
  /** One line for the vocabulary document and the review screen. */
  meaning: string;
}

const v = (verb: string, action: IrAction, forms: readonly string[], meaning: string): VerbDef => ({ verb, action, forms, meaning });

/** The 31 verbs of VO-01, exactly. */
export const VERBS: readonly VerbDef[] = [
  v('click', 'CLICK', ['click', 'clicks', 'clicked', 'clicking'], 'press a button, link or other clickable element'),
  v('enter', 'ENTER_VALUE', ['enter', 'enters', 'entered', 'entering'], 'put a value into a field'),
  v('type', 'ENTER_VALUE', ['type', 'types', 'typed', 'typing'], 'put a value into a field by typing'),
  v('fill', 'ENTER_VALUE', ['fill', 'fills', 'filled', 'filling'], 'put a value into a field or a form'),
  v('select', 'SELECT', ['select', 'selects', 'selected', 'selecting'], 'pick an option from a list'),
  v('choose', 'SELECT', ['choose', 'chooses', 'chose', 'chosen', 'choosing'], 'pick an option from a list'),
  v('upload', 'UPLOAD', ['upload', 'uploads', 'uploaded', 'uploading'], 'send a file to the application'),
  v('download', 'DOWNLOAD', ['download', 'downloads', 'downloaded', 'downloading'], 'save a file from the application'),
  v('submit', 'SUBMIT', ['submit', 'submits', 'submitted', 'submitting'], 'send a form'),
  v('login', 'LOGIN', ['login', 'logins', 'logged-in', 'logging-in'], 'sign in to the application'),
  v('logout', 'LOGOUT', ['logout', 'logouts', 'logged-out', 'logging-out'], 'sign out of the application'),
  v('search', 'SEARCH', ['search', 'searches', 'searched', 'searching'], 'look for something with the search function'),
  v('open', 'NAVIGATE', ['open', 'opens', 'opened', 'opening'], 'open a page, an address or the application'),
  v('navigate', 'NAVIGATE', ['navigate', 'navigates', 'navigated', 'navigating'], 'go to a page'),
  v('scroll', 'SCROLL', ['scroll', 'scrolls', 'scrolled', 'scrolling'], 'move the page or a list'),
  v('hover', 'HOVER', ['hover', 'hovers', 'hovered', 'hovering'], 'rest the pointer on an element'),
  v('drag', 'DRAG', ['drag', 'drags', 'dragged', 'dragging'], 'pick an element up with the pointer'),
  v('drop', 'DROP', ['drop', 'drops', 'dropped', 'dropping'], 'let a dragged element go'),
  v('press', 'PRESS', ['press', 'presses', 'pressed', 'pressing'], 'press a key'),
  v('check', 'CHECK', ['check', 'checks', 'checked', 'checking'], 'tick a box (or, with "that", verify something: decided by the grammar)'),
  v('uncheck', 'UNCHECK', ['uncheck', 'unchecks', 'unchecked', 'unchecking'], 'clear a tick'),
  v('clear', 'CLEAR', ['clear', 'clears', 'cleared', 'clearing'], 'empty a field'),
  v('remove', 'REMOVE', ['remove', 'removes', 'removed', 'removing'], 'take something out of a list or a form'),
  v('delete', 'DELETE', ['delete', 'deletes', 'deleted', 'deleting'], 'delete a record'),
  v('edit', 'EDIT', ['edit', 'edits', 'edited', 'editing'], 'change a record'),
  v('save', 'SAVE', ['save', 'saves', 'saved', 'saving'], 'store what was entered'),
  v('cancel', 'CANCEL', ['cancel', 'cancels', 'cancelled', 'canceled', 'cancelling', 'canceling'], 'leave without storing'),
  v('close', 'CLOSE', ['close', 'closes', 'closed', 'closing'], 'close a dialog, a tab or a window'),
  v('expand', 'EXPAND', ['expand', 'expands', 'expanded', 'expanding'], 'open a collapsed section'),
  v('collapse', 'COLLAPSE', ['collapse', 'collapses', 'collapsed', 'collapsing'], 'close an expanded section'),
  v('refresh', 'REFRESH', ['refresh', 'refreshes', 'refreshed', 'refreshing', 'reload', 'reloads', 'reloaded', 'reloading'], 'load the current page again'),
];

export interface AssertionWordDef {
  word: string;
  forms: readonly string[];
  /** `marker`: the sentence is a check because of this word. `predicate`: the word is what is being asserted. */
  role: 'marker' | 'predicate';
}

const a = (word: string, role: AssertionWordDef['role'], forms: readonly string[]): AssertionWordDef => ({ word, role, forms });

/** The 16 words of VO-02, exactly. Each one marks an expectation. */
export const ASSERTION_WORDS: readonly AssertionWordDef[] = [
  a('verify', 'marker', ['verify', 'verifies', 'verified', 'verifying']),
  a('validate', 'marker', ['validate', 'validates', 'validated', 'validating']),
  a('confirm', 'marker', ['confirm', 'confirms', 'confirmed', 'confirming']),
  a('ensure', 'marker', ['ensure', 'ensures', 'ensured', 'ensuring']),
  a('check', 'marker', ['check', 'checks', 'checked', 'checking']),
  a('expect', 'marker', ['expect', 'expects', 'expected', 'expecting']),
  a('should', 'marker', ['should']),
  a('must', 'marker', ['must']),
  a('displays', 'predicate', ['display', 'displays', 'displayed', 'displaying']),
  a('shows', 'predicate', ['show', 'shows', 'shown', 'showed', 'showing']),
  a('contains', 'predicate', ['contain', 'contains', 'contained', 'containing']),
  a('equals', 'predicate', ['equal', 'equals', 'equalled', 'equaled']),
  a('remains', 'predicate', ['remain', 'remains', 'remained', 'remaining']),
  a('redirects', 'predicate', ['redirect', 'redirects', 'redirected', 'redirecting']),
  a('rejects', 'predicate', ['reject', 'rejects', 'rejected', 'rejecting']),
  a('accepts', 'predicate', ['accept', 'accepts', 'accepted', 'accepting']),
];

const VERB_BY_FORM = new Map<string, VerbDef>();
for (const def of VERBS) for (const form of def.forms) VERB_BY_FORM.set(form, def);

const ASSERTION_BY_FORM = new Map<string, AssertionWordDef>();
for (const def of ASSERTION_WORDS) for (const form of def.forms) ASSERTION_BY_FORM.set(form, def);

/** The verb a written word is a form of, or undefined when it is not on the list (VO-01). */
export const verbOf = (word: string): VerbDef | undefined => VERB_BY_FORM.get(word.toLowerCase());

/**
 * Whether a word can begin an action clause: the base form ("click"), the third person ("clicks", after a subject) or
 * the -ing form ("clicking", after "after" or "by"). A past participle ("entered", "uploaded") begins a description
 * ("Entered text boxes should be empty"), never a command.
 */
export const isCommandForm = (word: string): boolean => {
  const def = VERB_BY_FORM.get(word.toLowerCase());
  return def !== undefined && (def.forms[0] === word || def.forms[1] === word || word.endsWith('ing'));
};

/** The assertion word a written word is a form of (VO-02). */
export const assertionWordOf = (word: string): AssertionWordDef | undefined => ASSERTION_BY_FORM.get(word.toLowerCase());

/** Words that mark a sentence as a check on their own. `check` is not among them: it is decided by the grammar. */
export const CHECK_MARKERS: ReadonlySet<string> = new Set(
  ASSERTION_WORDS.filter((x) => x.role === 'marker' && x.word !== 'check' && x.word !== 'should' && x.word !== 'must').flatMap((x) => x.forms),
);

export const VOCABULARY_VERSION = '1.0.0';
