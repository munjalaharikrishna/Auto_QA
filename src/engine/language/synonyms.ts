/**
 * Layer 6, the synonym engine (SY-01, SY-02). Ten category directories, each its own versioned set. A mapping is
 * explicit, never "these mean the same": `tap` is `click`, but `press` stays `press`, because they drive the page
 * differently. A word can mean different things in different categories (`clear` is an action in Action and a state in
 * State), so a lookup always names its category.
 *
 * Every phrase is one or more words, lower case, written the way the normalizer leaves text (SY entries are matched
 * against normalized tokens, so a contraction or an abbreviation is already in its fixed form).
 */

export const CATEGORIES = ['Action', 'Assertion', 'Navigation', 'Authentication', 'Form', 'Error', 'Visibility', 'State', 'Data', 'Negation'] as const;
export type SynonymCategory = (typeof CATEGORIES)[number];

export interface SynonymEntry {
  canonical: string;
  phrases: readonly string[];
}

export interface SynonymSet {
  category: SynonymCategory;
  /** Bumped when an entry is added, changed or removed. Recorded with every run (GV-12). */
  version: string;
  entries: readonly SynonymEntry[];
}

const e = (canonical: string, ...phrases: string[]): SynonymEntry => ({ canonical, phrases });

/** Words that stand for a verb of the controlled vocabulary (VO-01) that is not written that way. */
const ACTION: SynonymSet = {
  category: 'Action',
  version: '1.0.0',
  entries: [
    e('click', 'tap', 'click on', 'tap on', 'hit', 'press on'),
    e('enter', 'key in', 'input', 'provide', 'write', 'supply', 'put'),
    e('select', 'pick', 'pick out'),
    e('check', 'tick', 'tick off', 'mark'),
    e('uncheck', 'untick', 'untick off', 'unmark'),
    e('open', 'launch', 'start', 'load'),
    e('navigate', 'go to', 'visit', 'browse to', 'land on', 'move to', 'switch to'),
    e('upload', 'attach', 'browse and upload'),
    e('clear', 'erase', 'wipe', 'empty'),
    e('delete', 'trash'),
    e('close', 'dismiss', 'shut'),
    e('refresh', 'reload', 'reload the page'),
    e('login', 'log in', 'sign in', 'logon', 'log on'),
    e('logout', 'log out', 'sign out', 'logoff', 'log off'),
    e('submit', 'send'),
    e('search', 'look up', 'look for', 'find'),
    e('save', 'store'),
  ],
};

/** Words that start or mark a check (VO-02). */
const ASSERTION: SynonymSet = {
  category: 'Assertion',
  version: '1.0.0',
  entries: [e('verify', 'validate', 'confirm', 'ensure', 'make sure', 'make sure that', 'assert', 'test that', 'look for', 'see that', 'observe')],
};

/** Ways of saying "go to a page" or "start the application". */
const NAVIGATION: SynonymSet = {
  category: 'Navigation',
  version: '1.0.0',
  entries: [
    e(
      'open application',
      'open browser',
      'launch browser',
      'launch application',
      'start application',
      'open the application',
      'open the browser',
      'enter url',
      'enter the url',
      'type url',
      'type the url',
      'enter the application url',
      'open the application url',
      'enter url for',
    ),
    e('go back', 'navigate back', 'move back', 'press back', 'browser back'),
    e('go forward', 'navigate forward', 'move forward', 'press forward', 'browser forward'),
    e(
      'redirected to',
      'redirects to',
      'navigates to',
      'navigate to',
      'taken to',
      'lands on',
      'moved to',
      'brought to',
      'directed to',
      'opens',
      'goes to',
      'go to',
    ),
    e('remains on', 'stays on', 'remain on', 'stay on', 'is still on', 'still on'),
  ],
};

/** Signing in and out, and what it leaves behind. */
const AUTHENTICATION: SynonymSet = {
  category: 'Authentication',
  version: '1.0.0',
  entries: [
    e(
      'logged in',
      'log in',
      'logs in',
      'login',
      'logged-in',
      'signed in',
      'sign in',
      'authenticated',
      'authenticate',
      'authenticates',
      'logged on',
      'login successful',
      'successfully logged in',
      'login is successful',
      'login is performed',
      'login performed',
    ),
    e('logged out', 'log out', 'logs out', 'signed out', 'sign out', 'logout', 'logged off'),
    e('rejected', 'denied', 'refused', 'not allowed', 'declined', 'blocked'),
  ],
};

/** The names a form control goes by. */
const FORM: SynonymSet = {
  category: 'Form',
  version: '1.0.0',
  entries: [
    e('field', 'text box', 'textbox', 'text field', 'input', 'input box', 'input field', 'edit box', 'box', 'entry'),
    e('dropdown', 'drop-down', 'drop down', 'dropdown list', 'select box', 'combo box', 'combobox', 'list box', 'picklist'),
    e('checkbox', 'check box', 'tick box'),
    e('radio button', 'radio', 'option button'),
    e('button', 'btn', 'submit button', 'action button'),
    e('link', 'hyperlink', 'anchor'),
    e('tab', 'tabs'),
    e('upload button', 'browse button', 'choose file button'),
  ],
};

/** Messages that say something went wrong. */
const ERROR: SynonymSet = {
  category: 'Error',
  version: '1.0.0',
  entries: [
    e('error message', 'error', 'error text', 'failure message', 'error notification', 'authentication error message', 'warning message'),
    e(
      'validation message',
      'validation error',
      'validation',
      'required message',
      'required-field message',
      'field error',
      'inline error',
      'validation messages',
      'validation errors',
    ),
    e('alert', 'popup alert', 'alert box', 'alert message'),
  ],
};

/** Ways of saying something can be seen, or cannot. */
const VISIBILITY: SynonymSet = {
  category: 'Visibility',
  version: '1.0.0',
  entries: [
    e(
      'visible',
      'displayed',
      'shown',
      'seen',
      'present',
      'appears',
      'appear',
      'appeared',
      'available',
      'listed',
      'on screen',
      'rendered',
      'show up',
      'shows up',
    ),
    e(
      'hidden',
      'invisible',
      'absent',
      'not visible',
      'not displayed',
      'not shown',
      'disappears',
      'disappeared',
      'gone',
      'removed from the page',
      'unavailable',
    ),
  ],
};

/** States an element or a field can be in. */
const STATE: SynonymSet = {
  category: 'State',
  version: '1.0.0',
  entries: [
    e('enabled', 'clickable', 'active', 'usable', 'editable'),
    e('disabled', 'greyed out', 'grayed out', 'inactive', 'unclickable', 'read-only', 'readonly', 'not clickable', 'not enabled'),
    e('selected', 'chosen', 'picked'),
    e('checked', 'ticked'),
    e('unchecked', 'unticked'),
    e('empty', 'blank', 'cleared', 'emptied', 'has no value', 'holds nothing', 'contains nothing'),
    e('masked', 'masked characters', 'hidden characters', 'dots', 'asterisks', 'obscured', 'covered'),
    e('centered', 'middle', 'in the middle', 'at the middle', 'at middle', 'center', 'centre', 'in the center', 'in the centre'),
  ],
};

/** Kinds of test data (TD-01) as the tester names them. */
const DATA: SynonymSet = {
  category: 'Data',
  version: '1.0.0',
  entries: [
    e('valid', 'correct', 'right', 'proper', 'good', 'legal', 'acceptable'),
    e('invalid', 'wrong', 'incorrect', 'bad', 'illegal', 'unacceptable', 'improper', 'unintended'),
    e('blank', 'empty', 'nothing', 'no value', 'left empty'),
    e('existing', 'already registered', 'already existing', 'registered', 'duplicate'),
    e('non-existing', 'unregistered', 'unknown', 'new', 'not registered', 'nonexistent'),
  ],
};

/** The words that turn a clause around (NG-01). */
const NEGATION: SynonymSet = {
  category: 'Negation',
  version: '1.0.0',
  entries: [
    e(
      'not',
      'not',
      'no',
      'never',
      'cannot',
      'unable to',
      'fails to',
      'fail to',
      'failed to',
      'does not',
      'do not',
      'did not',
      'is not',
      'are not',
      'was not',
      'were not',
      'should not',
      'must not',
      'will not',
      'would not',
      'could not',
      'has not',
      'have not',
      'without',
      'neither',
      'nor',
    ),
  ],
};

export const SYNONYM_SETS: Readonly<Record<SynonymCategory, SynonymSet>> = {
  Action: ACTION,
  Assertion: ASSERTION,
  Navigation: NAVIGATION,
  Authentication: AUTHENTICATION,
  Form: FORM,
  Error: ERROR,
  Visibility: VISIBILITY,
  State: STATE,
  Data: DATA,
  Negation: NEGATION,
};

const INDEX = new Map<SynonymCategory, Map<string, string>>();
for (const set of Object.values(SYNONYM_SETS)) {
  const map = new Map<string, string>();
  for (const entry of set.entries) {
    map.set(entry.canonical, entry.canonical);
    for (const phrase of entry.phrases) if (!map.has(phrase)) map.set(phrase, entry.canonical);
  }
  INDEX.set(set.category, map);
}

/** What a phrase stands for in one category, or undefined (SY-01: a word can differ between categories). */
export const canonical = (category: SynonymCategory, phrase: string): string | undefined =>
  INDEX.get(category)?.get(phrase.toLowerCase().split(' ').filter(Boolean).join(' '));

/**
 * The longest phrase of a category that the words start with, from `from`: `{ canonical, length }` in words.
 * `words` are lower-case words, one per token.
 */
export function matchPhrase(
  category: SynonymCategory,
  words: readonly string[],
  from: number,
  maxWords = 5,
): { canonical: string; length: number } | undefined {
  const map = INDEX.get(category);
  if (!map) return undefined;
  for (let len = Math.min(maxWords, words.length - from); len >= 1; len--) {
    const found = map.get(words.slice(from, from + len).join(' '));
    if (found !== undefined) return { canonical: found, length: len };
  }
  return undefined;
}

/** The versions of every category directory, for the run's version stamp (GV-12). */
export const synonymVersions = (): Record<SynonymCategory, string> =>
  Object.fromEntries(CATEGORIES.map((c) => [c, SYNONYM_SETS[c].version])) as Record<SynonymCategory, string>;

/**
 * Misspellings that appear in real test cases ("naviagte", "succesfully"). They are fixed only to compare words with the
 * vocabulary; the tester's own words (names, messages, quoted text) are never changed.
 */
const TYPOS: Readonly<Record<string, string>> = {
  naviagte: 'navigate',
  navigte: 'navigate',
  navigat: 'navigate',
  succesfully: 'successfully',
  successfuly: 'successfully',
  sucessfully: 'successfully',
  fileds: 'fields',
  filed: 'field',
  enployee: 'employee',
  employement: 'employment',
  benfits: 'benefits',
  oragne: 'orange',
  verfiy: 'verify',
  verfy: 'verify',
  vefify: 'verify',
  chek: 'check',
  clik: 'click',
  clck: 'click',
  buton: 'button',
  pasword: 'password',
  passwrod: 'password',
  usrname: 'username',
  dispalyed: 'displayed',
  displyed: 'displayed',
  visble: 'visible',
  sucessful: 'successful',
  succesful: 'successful',
};

export const fixTypo = (word: string): string => TYPOS[word] ?? word;
