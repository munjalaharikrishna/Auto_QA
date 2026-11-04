import { containerRef } from '../ir/container.js';
import type { IrCondition, IrTarget } from '../ir/schema.js';
import type { Token } from '../text/index.js';
import { DATA_CLASS_CHECK_WORDS, STATE_WORDS } from './lexicon.js';
import { type NounPhrase, parseNounPhrase } from './nounphrase.js';
import type { Issue } from './types.js';
import { isSymbol, type Line, lw, originalOf } from './view.js';

/**
 * What a check says (VO-02, GR-05, GR-06) and the negation inside it (NG-01, NG-02). A clause is read on its own:
 *  - the negation words of the clause (not, no, never, cannot, without, fails to) turn that clause's expectation around
 *    and no other clause's. "Login is **not** performed and the system displays a message" gives two expectations, and
 *    only the first is negated;
 *  - state words (hidden, disabled, rejected) set the expected state of their own clause;
 *  - the subject of a clause with none ("…and redirected to the home page") is the subject of the clause before it.
 */

export type Subject = { kind: 'actor' } | { kind: 'system' } | { kind: 'login' } | { kind: 'np'; np: NounPhrase };

export interface CheckResult {
  /** The kind of predicate found, for choosing between GR-05 (a condition) and GR-06 (an expected result). */
  predicate?: Kind;
  expectations: Array<{ clause: string; negated: boolean; condition: IrCondition; decisions: string[] }>;
  issues: Array<Omit<Issue, 'where'>>;
  subject?: Subject;
}

type Kind =
  | 'MASKED'
  | 'LAYOUT'
  | 'URL_TO'
  | 'STAY'
  | 'LOGGED_IN'
  | 'LOGGED_OUT'
  | 'REJECTED'
  | 'PERFORMED'
  | 'ACCEPTED'
  | 'CONTAINS'
  | 'EQUALS'
  | 'ENABLED'
  | 'DISABLED'
  | 'EMPTY'
  | 'HAS_VALUE'
  | 'CHECKED'
  | 'UNCHECKED'
  | 'DATA_CLASS'
  | 'DELETED'
  | 'CHANGED'
  | 'HIDDEN'
  | 'VISIBLE'
  | 'SHOWS'
  | 'APP_STARTED'
  | 'BROWSER_OPENED'
  | 'DEFAULT_PAGE';

interface PredicateDef {
  kind: Kind;
  priority: number;
  phrases: readonly (readonly string[])[];
  /** Counts only at the end of the clause: "the password is invalid", not "an invalid username error is shown". */
  endOnly?: boolean;
}

const p = (kind: Kind, priority: number, ...phrases: string[]): PredicateDef => ({ kind, priority, phrases: phrases.map((x) => x.split(' ')) });
const last = (def: PredicateDef): PredicateDef => ({ ...def, endOnly: true });

const PREDICATES: readonly PredicateDef[] = [
  // "User should open browser", "Browser should be opened": the run's own browser, an environment fact the application does
  // not show. Nothing is checked, and nobody is told the application started (owner, 3-4 Nov 2026).
  p(
    'BROWSER_OPENED',
    96,
    'open browser',
    'open the browser',
    'launch browser',
    'browser opens',
    'browser launches',
    'browser starts',
    'browser opened',
    'browser is opened',
    'browser be opened',
  ),
  p('APP_STARTED', 95, 'open application', 'open the application', 'launch application', 'application opens', 'application launches', 'application starts'),
  p('MASKED', 90, ...STATE_WORDS.masked),
  p(
    'LAYOUT',
    85,
    'middle of',
    'centre of',
    'center of',
    'in the middle',
    'at middle',
    'at the middle',
    'in the center',
    'in the centre',
    'centered',
    'centred',
    'at the top',
    'at the bottom',
    'at the left',
    'at the right',
    'at top',
    'at bottom',
  ),
  p(
    'URL_TO',
    80,
    'redirected to',
    'redirects to',
    'redirect to',
    'navigates to',
    'navigate to',
    'navigated to',
    'taken to',
    'lands on',
    'moved to',
    'directed to',
    'brought to',
    'opens',
    'open',
    'goes to',
  ),
  p('STAY', 80, 'remains on', 'stays on', 'stay on', 'remain on', 'is still on', 'still on'),
  p('LOGGED_IN', 75, 'logged in', 'log in', 'logs in', 'signed in', 'sign in', 'signs in', 'authenticated', 'authenticate', 'authenticates'),
  p('LOGGED_OUT', 75, 'logged out', 'log out', 'logs out', 'signed out', 'sign out'),
  p('PERFORMED', 76, 'performed', 'successful', 'completed', 'succeeds', 'succeed', 'done'),
  p('REJECTED', 74, 'rejected', 'rejects', 'reject', 'denied', 'denies', 'refused', 'declined', 'blocked', 'fails', 'failed'),
  p('ACCEPTED', 55, 'accept', 'accepts', 'accepted', 'allowed', 'entered'),
  p('CONTAINS', 70, 'contains', 'contain', 'containing', 'includes', 'include', 'says', 'reads', 'with text', 'text is'),
  p('EQUALS', 70, 'equals', 'equal to', 'equal', 'exactly'),
  p('HAS_VALUE', 66, 'has value', 'have value', 'has the value', 'shows value'),
  p('DISABLED', 65, ...STATE_WORDS.disabled),
  p('ENABLED', 64, ...STATE_WORDS.enabled),
  p('EMPTY', 60, ...STATE_WORDS.empty),
  p('CHECKED', 58, ...STATE_WORDS.checked),
  p('UNCHECKED', 58, ...STATE_WORDS.unchecked),
  last(p('DATA_CLASS', 62, ...DATA_CLASS_CHECK_WORDS)),
  p('DELETED', 57, 'deleted', 'removed', 'erased'),
  p('CHANGED', 56, 'updated', 'saved', 'saves', 'added', 'created', 'modified', 'changed', 'stored', 'uploaded'),
  p('DEFAULT_PAGE', 68, 'default page', 'default screen', 'landing page', 'home page by default'),
  p('HIDDEN', 50, 'hidden', 'invisible', 'absent', 'unavailable', 'disappears', 'disappear', 'gone', 'not displayed'),
  p('SHOWS', 41, 'displays', 'display', 'shows', 'show', 'see', 'sees', 'shown to'),
  p('VISIBLE', 40, 'displayed', 'shown', 'visible', 'appears', 'appear', 'present', 'seen', 'listed', 'available', 'rendered', 'found', 'exist', 'exists'),
];

/**
 * Every word a predicate starts with, plus the little verbs that carry one. A clause with one of these says something
 * about something, so it is a check (the grammar asks this before it gives up on a sentence).
 */
export const PREDICATE_STARTS: ReadonlySet<string> = new Set([
  ...PREDICATES.flatMap((def) => def.phrases.map((ph) => ph[0] as string)),
  'is',
  'are',
  'was',
  'were',
  'should',
  'must',
  'will',
  'shall',
  'does',
  'has',
  'have',
  'stays',
  'remains',
]);

export const MESSAGE_HEADS: ReadonlySet<string> = new Set(['Error', 'Validation', 'Message']);

/** Nouns that name data without saying which: "the added data", "updated records". */
const GENERIC_DATA: ReadonlySet<string> = new Set([
  'data',
  'record',
  'records',
  'value',
  'values',
  'detail',
  'details',
  'information',
  'item',
  'items',
  'entry',
  'entries',
]);

const NEGATIONS: ReadonlySet<string> = new Set(['not', 'no', 'never', 'cannot', 'without', 'neither', 'nor', 'unable', 'fails to', 'fail to']);
/** Verbs that only link a subject to its state: "Save stays disabled", "the field becomes empty". */
const LINKING: ReadonlySet<string> = new Set(['stays', 'stay', 'remains', 'remain', 'becomes', 'become', 'gets', 'get', 'turns', 'turn']);
const AUX: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'should',
  'must',
  'shall',
  'will',
  'can',
  'could',
  'would',
  'may',
  'might',
  'does',
  'do',
  'did',
  'had',
]);
const ADVERBS: ReadonlySet<string> = new Set([
  'successfully',
  'correctly',
  'properly',
  'immediately',
  'automatically',
  'also',
  'then',
  'finally',
  'actually',
  'only',
  'again',
]);
const MARKERS: ReadonlySet<string> = new Set([
  'verify',
  'validate',
  'confirm',
  'ensure',
  'expect',
  'expected',
  'check',
  'checking',
  'verifying',
  'validating',
  'confirming',
  'ensuring',
  'assert',
  'that',
]);
const MESSAGE_CLASSES: ReadonlySet<string> = new Set(['Error', 'Validation', 'Message']);
const TEXT_LEADS: ReadonlySet<string> = new Set(['indicating', 'indicates', 'stating', 'states', 'saying', 'says', 'showing', 'reading']);
const FIELD_WORDS = ['username', 'user name', 'password', 'email', 'name', 'code', 'id', 'phone', 'address'];
const LOGIN_WORDS: ReadonlySet<string> = new Set(['login', 'log in', 'sign in', 'authentication', 'logon']);
const ACTOR_WORDS: ReadonlySet<string> = new Set(['user', 'tester', 'visitor', 'customer', 'admin', 'applicant', 'expert']);
const SYSTEM_WORDS: ReadonlySet<string> = new Set(['system', 'application', 'app', 'it', 'they', 'site', 'website', 'page']);

interface Hit {
  def: PredicateDef;
  start: number;
  end: number;
}

/** The earliest start of any predicate word: where the subject ends. */
function earliestPredicate(words: readonly string[], skip?: ReadonlySet<Kind>): number {
  let first = words.length;
  for (const def of PREDICATES) {
    if (skip?.has(def.kind)) continue;
    for (const phrase of def.phrases) {
      for (let i = 0; i + phrase.length <= words.length && i < first; i++) {
        if (phrase.every((w, k) => words[i + k] === w) && !(def.endOnly && i + phrase.length !== words.length)) first = i;
      }
    }
  }
  return first;
}

function findPredicate(words: readonly string[], skip?: ReadonlySet<Kind>): Hit | undefined {
  let best: Hit | undefined;
  for (const def of PREDICATES) {
    if (skip?.has(def.kind)) continue;
    for (const phrase of def.phrases) {
      for (let i = 0; i + phrase.length <= words.length; i++) {
        if (!phrase.every((w, k) => words[i + k] === w)) continue;
        if (def.endOnly && i + phrase.length !== words.length) continue;
        const better =
          !best ||
          def.priority > best.def.priority ||
          (def.priority === best.def.priority && (i < best.start || (i === best.start && phrase.length > best.end - best.start)));
        if (better) best = { def, start: i, end: i + phrase.length };
      }
    }
  }
  return best;
}

const REGIONS: ReadonlyArray<readonly [words: readonly string[], region: string]> = [
  [['top', 'left'], 'top-left'],
  [['top', 'right'], 'top-right'],
  [['bottom', 'left'], 'bottom-left'],
  [['bottom', 'right'], 'bottom-right'],
  [['top'], 'top'],
  [['bottom'], 'bottom'],
  [['left'], 'left'],
  [['right'], 'right'],
  [['middle'], 'center'],
  [['center'], 'center'],
  [['centre'], 'center'],
  [['centered'], 'center'],
  [['centred'], 'center'],
];

function regionOf(words: readonly string[]): string {
  for (const [ws, region] of REGIONS) if (ws.every((w) => words.includes(w))) return region;
  return 'center';
}

/** The subject of a clause from the words before its predicate. */
function subjectOf(line: Line, tokens: readonly Token[]): Subject | undefined {
  const words = tokens.map((t) => lw(t)).filter((w) => !['the', 'a', 'an'].includes(w));
  if (!words.length) return undefined;
  const text = words.join(' ');
  if (words.length === 1 && ACTOR_WORDS.has(text)) return { kind: 'actor' };
  if (words.length === 1 && SYSTEM_WORDS.has(text)) return { kind: 'system' };
  if (LOGIN_WORDS.has(text)) return { kind: 'login' };
  return { kind: 'np', np: parseNounPhrase(line, tokens, 'Element') };
}

/** The words of a noun phrase with the head noun taken off, as the tester wrote them. */
const messageTarget = (np: NounPhrase): { target: IrTarget; text?: string } => {
  const cls = np.headClass as string;
  const named = np.targets.find((t) => t.name)?.name;
  return {
    target: { ontology: cls, label: cls === 'Validation' ? 'validation message' : cls === 'Error' ? 'error message' : 'message' },
    ...(named ? { text: named } : {}),
  };
};

const nearOf = (text: string | undefined): string | undefined => {
  const lower = (text ?? '').toLowerCase();
  return FIELD_WORDS.find((w) => lower.includes(w));
};

const FALLBACK_FOR: Partial<Record<Kind, string>> = {
  MASKED: 'Field',
  EMPTY: 'Field',
  HAS_VALUE: 'Field',
  CHECKED: 'Checkbox',
  UNCHECKED: 'Checkbox',
  ENABLED: 'Button',
  DISABLED: 'Button',
};

/** Reads one clause as a check. `inherited` is the subject of the clause before, used when this one has none. */
export function parseCheck(line: Line, clauseTokens: readonly Token[], clauseText: string, inherited?: Subject): CheckResult {
  const decisions: string[] = [];
  const issues: CheckResult['issues'] = [];

  // Words of the clause, without the check marker, the adverbs and the little verbs that carry tense.
  let negated = false;
  const kept: Token[] = [];
  let dropTo = false;
  for (const t of clauseTokens) {
    const w = lw(t);
    if (t.kind !== 'WORD') {
      kept.push(t);
      continue;
    }
    if (MARKERS.has(w) && kept.length === 0) continue;
    if (dropTo && w === 'to') {
      dropTo = false;
      continue;
    }
    dropTo = false;
    // "are visible or not": asks whether it is visible; it does not say it is not.
    if (w === 'not' && lw(kept[kept.length - 1]) === 'or') {
      kept.pop();
      continue;
    }
    if (NEGATIONS.has(w)) {
      negated = !negated;
      dropTo = w === 'unable';
      decisions.push(`"${w}" turns this clause around`);
      continue;
    }
    if ((w === 'fails' || w === 'fail' || w === 'failed') && lw(clauseTokens[clauseTokens.indexOf(t) + 1]) === 'to') {
      negated = !negated;
      dropTo = true;
      decisions.push(`"${w} to" turns this clause around`);
      continue;
    }
    if (AUX.has(w) || ADVERBS.has(w)) continue;
    // "stays on the Login page" is a predicate of its own; "stays disabled" is only a link to the state.
    if (LINKING.has(w) && lw(clauseTokens[clauseTokens.indexOf(t) + 1]) !== 'on') continue;
    // "Expect the heading to be displayed": the "to" belongs to "be".
    if (w === 'to' && lw(clauseTokens[clauseTokens.indexOf(t) + 1]) === 'be') continue;
    kept.push(t);
  }

  // "Under Employee Information Section there should be add button": a place, then "there", then the thing that should exist.
  const thereAt = kept.findIndex((t) => lw(t) === 'there');
  let thereNp: NounPhrase | undefined;
  if (thereAt >= 0) {
    const place = kept.slice(0, thereAt);
    const thing = kept.slice(thereAt + 1);
    if (thing.length) {
      thereNp = parseNounPhrase(line, thing, 'Element');
      const placeAt = place.length && ['under', 'in', 'on', 'at', 'within', 'inside'].includes(lw(place[0])) ? place.slice(1) : place;
      if (placeAt.length) thereNp = { ...thereNp, within: originalOf(line, placeAt) };
      decisions.push('"there should be X" says X must be visible');
    }
  }

  const words = kept.map((t) => lw(t));
  let hit = thereNp ? undefined : findPredicate(words);
  // "see tabs and PIM as a default page": "as a default page" describes PIM, it is not a check of its own (the noun phrase reports it).
  if (hit?.def.kind === 'DEFAULT_PAGE' && words[hit.start - 2] === 'as') hit = findPredicate(words, new Set<Kind>(['DEFAULT_PAGE']));
  // "The added data is displayed": "added" describes the data; the predicate is the one that comes after it.
  let adjectives: ReadonlySet<Kind> | undefined;
  // "The selected image is uploaded": "selected" describes the image, it is not the state being checked.
  const describing = (hit?.def.kind === 'CHECKED' && words[hit.start] === 'selected') || (hit?.def.kind === 'ACCEPTED' && words[hit.start] === 'entered');
  if (hit && (hit.def.kind === 'CHANGED' || hit.def.kind === 'DELETED' || describing)) {
    const skip = new Set<Kind>(describing ? [hit?.def.kind as Kind] : ['CHANGED', 'DELETED']);
    const later = findPredicate(words, skip);
    if (later && later.start >= hit.end) {
      hit = later;
      adjectives = skip;
    }
  }
  // "The entered details are cleared": "entered" sits after "the", so it describes the details; the check is the later predicate, and the
  // subject is not cut at "entered". Any predicate word right after a determiner and before the one being checked is such a describing word.
  // (Not for "removed"/"changed": what they say about the entered data is not what the reference check compares.)
  if (hit && hit.def.kind !== 'DELETED' && hit.def.kind !== 'CHANGED') {
    const describing = new Set<Kind>(adjectives ?? []);
    // "Entered text boxes and uploaded photo should empty": the first word, and the first word of an item of a list, describe too (E0.15).
    for (let k = 0; k < hit.start; k++) {
      if (k > 0 && !['the', 'these', 'those', 'all', 'each', 'any', 'a', 'an', 'and', 'or', ','].includes(words[k - 1] ?? '')) continue;
      const inner = findPredicate([words[k] as string]);
      if (inner && inner.def.kind !== hit.def.kind) describing.add(inner.def.kind);
    }
    if (describing.size) adjectives = describing;
  }
  if (thereNp) {
    const out: CheckResult['expectations'] = [];
    for (const target of thereNp.targets)
      out.push({
        clause: clauseText,
        negated,
        condition: { type: 'VISIBILITY', target: { ...target, ...(thereNp.within ? { within: thereNp.within } : {}) }, expect: 'VISIBLE', check: 'visible' },
        decisions,
      });
    return { predicate: 'VISIBLE', expectations: out, issues, subject: inherited };
  }

  // "Error message: Epic sadface…": a message class, a colon and the text it shows.
  const colon = kept.findIndex((t) => isSymbol(t, ':'));
  if (!hit && colon > 0) {
    const np = parseNounPhrase(line, kept.slice(0, colon), 'Message');
    if (np.headClass && MESSAGE_CLASSES.has(np.headClass)) {
      const text = originalOf(line, kept.slice(colon + 1));
      return {
        expectations: [
          {
            clause: clauseText,
            negated,
            condition: { type: 'TEXT', target: messageTarget(np).target, expect: text, fresh: true, check: 'contains-text' },
            decisions,
          },
        ],
        issues,
        subject: inherited,
      };
    }
  }

  if (!hit) {
    return {
      expectations: [],
      issues: [
        {
          code: 'NOT_UNDERSTOOD',
          // An expected result is not a step: the case can still run without it, and a person decides this one check (E0.15).
          // The verdict never gives PASS while it is unread.
          severity: 'review',
          message: 'no check could be read: no word says what should be true',
          original: clauseText,
          suggestion: 'Say what should be true on the screen, for example: Verify the <name> <button, field, message> is displayed.',
        },
      ],
      subject: inherited,
    };
  }

  const beforeAll = kept.slice(0, Math.min(hit.start, earliestPredicate(words, adjectives)));
  // "The selected image": the word describes the image; it is not part of its name.
  const unselected = describing ? beforeAll.filter((t) => lw(t) !== 'selected') : beforeAll;
  // "PIM is the default page": the article before the predicate belongs to the predicate, not to the subject.
  const before = hit.def.kind === 'DEFAULT_PAGE' && ['the', 'a', 'an'].includes(lw(unselected[unselected.length - 1])) ? unselected.slice(0, -1) : unselected;
  const afterAll = kept.slice(hit.end);
  // "a validation message indicating that …": what comes after the lead is what the message says, not part of its name.
  const leadAt = afterAll.findIndex((t) => TEXT_LEADS.has(lw(t)));
  const after = leadAt >= 0 && kind0(hit) === 'SHOWS' ? afterAll.slice(0, leadAt) : afterAll;
  const tailAfterLead = leadAt >= 0 ? afterAll.slice(leadAt + 1) : [];
  const subject = subjectOf(line, before) ?? inherited;
  if (!before.length && inherited) decisions.push('no subject written: the subject of the clause before is used');
  const kind = hit.def.kind;
  const subjectNp = subject?.kind === 'np' ? subject.np : undefined;
  const flagNp = (np: NounPhrase | undefined): void => {
    if (np?.reference) issues.push(refIssue(np.reference, np.original, clauseText));
    if (np?.dropped && !isDefaultPage(np.dropped)) issues.push(droppedIssue(np.dropped, clauseText));
  };
  flagNp(subjectNp);
  const make = (condition: IrCondition, flip = false): CheckResult['expectations'][number] => ({
    clause: clauseText,
    negated: flip ? !negated : negated,
    condition,
    decisions,
  });
  const out: CheckResult['expectations'] = [];

  /** One expectation for each target of a noun phrase. */
  const forTargets = (np: NounPhrase | undefined, build: (target: IrTarget | undefined) => IrCondition): void => {
    if (!np && subject?.kind === 'login') {
      // "Login is disabled": the button called Login.
      out.push(make(build({ ontology: 'Button', name: 'Login' })));
      return;
    }
    if (!np) {
      issues.push({
        code: 'AMBIGUOUS',
        severity: 'review',
        message: 'the check does not say which element it is about',
        original: clauseText,
        suggestion: 'Name the element: Verify the <name> <field, button, message …> is <state>.',
      });
      return;
    }
    const fallback = FALLBACK_FOR[kind];
    for (const target of np.targets) {
      const refined = fallback && !np.headClass ? { ...target, ontology: fallback === 'Field' ? refineName(target.name, fallback) : fallback } : target;
      out.push(make(build({ ...refined, ...(np.within ? { within: np.within } : {}) })));
    }
  };

  const objectNp = (fallback = 'Element'): NounPhrase | undefined => {
    const np = after.length ? parseNounPhrase(line, after, fallback) : undefined;
    flagNp(np);
    return np;
  };

  switch (kind) {
    case 'APP_STARTED':
      out.push(make({ type: 'STATE', expect: 'APPLICATION_STARTED' }));
      break;
    case 'BROWSER_OPENED':
      issues.push({
        code: 'NOT_CHECKED',
        severity: 'info',
        setup: 'check',
        message: 'the run opens its own browser: that is the test setup, not something the application shows, so nothing is checked',
        original: clauseText,
      });
      break;
    case 'DEFAULT_PAGE': {
      // "PIM is the default page": the page the application opens on. The name is the subject, as the tester wrote it.
      const name = subjectNp ? subjectNp.original : undefined;
      if (!name) {
        issues.push({ code: 'AMBIGUOUS', severity: 'review', message: 'it does not say which page is the default', original: clauseText });
        break;
      }
      out.push(make({ type: 'STATE', target: { ontology: 'Page', name }, expect: 'DEFAULT_PAGE' }));
      break;
    }
    case 'MASKED':
      forTargets(subjectNp ?? objectNp('Field'), (target) => ({ type: 'MASKED', ...(target ? { target } : {}), expect: 'MASKED', check: 'masked' }));
      break;
    case 'LAYOUT': {
      const region = regionOf(words.slice(hit.start, hit.end + 2));
      forTargets(subjectNp, (target) => ({ type: 'LAYOUT', ...(target ? { target } : {}), region, check: 'region' }));
      break;
    }
    case 'URL_TO': {
      const page = pageOf(line, after);
      if (!page) {
        issues.push({ code: 'AMBIGUOUS', severity: 'review', message: 'it does not say which page the user ends on', original: clauseText });
        out.push(make({ type: 'URL', check: 'url' }));
      } else out.push(make({ type: 'URL', target: { ontology: 'Page', name: page }, expect: page, check: 'url' }));
      break;
    }
    case 'STAY': {
      const page = pageOf(line, after);
      out.push(make({ type: 'URL', ...(page ? { target: { ontology: 'Page', name: page } } : {}), expect: 'UNCHANGED', check: 'url-unchanged' }));
      break;
    }
    case 'LOGGED_IN':
      out.push(make({ type: 'AUTHENTICATION', expect: 'LOGGED_IN', check: 'logged-in' }));
      break;
    case 'LOGGED_OUT':
      out.push(make({ type: 'AUTHENTICATION', expect: 'LOGGED_OUT', check: 'logged-out' }));
      break;
    case 'REJECTED': {
      // "Login is rejected" says the login did not happen: it sets the expected state of its own clause.
      if (subject?.kind === 'login' || subject?.kind === 'actor' || subjectNp?.words.includes('credentials')) {
        decisions.push('"rejected" sets this clause to "not logged in"');
        out.push(make({ type: 'AUTHENTICATION', expect: 'LOGGED_IN', check: 'logged-in' }, true));
      } else {
        const np = after.length ? objectNp() : subjectNp;
        forTargets(np, (target) => ({ type: 'STATE', ...(target ? { target } : {}), expect: 'REJECTED' }));
      }
      break;
    }
    case 'PERFORMED': {
      if (subject?.kind === 'login') out.push(make({ type: 'AUTHENTICATION', expect: 'LOGGED_IN', check: 'logged-in' }));
      else forTargets(subjectNp, (target) => ({ type: 'STATE', ...(target ? { target } : {}), expect: 'DONE' }));
      break;
    }
    case 'ACCEPTED': {
      // "The Email field accepts 'a@b.com'": after entering it, the field holds it. Without a value, it is the one entered earlier.
      const quoted = after.find((t) => t.kind === 'LITERAL');
      if (quoted) {
        forTargets(subjectNp, (target) => ({ type: 'VALUE', ...(target ? { target } : {}), expect: quoted.value ?? '', check: 'value' }));
        break;
      }
      const np = subjectNp ?? objectNp();
      decisions.push('"accept" means what is entered is kept: it is compared with the value entered earlier');
      forTargets(np, (target) => ({ type: 'VALUE', ...(target ? { target } : {}), expect: '$ref.entered' }));
      issues.push({
        code: 'NEEDS_REFERENCE',
        severity: 'review',
        reference: '$entered',
        message: 'the check compares with the value entered in an earlier step, which is resolved from what the test case did before',
        original: clauseText,
        suggestion: 'Say what the field should hold: Verify the <field> field contains "<value>".',
      });
      break;
    }
    case 'CONTAINS':
    case 'EQUALS': {
      const text = originalText(line, after);
      const cls = subjectNp?.headClass;
      const type = cls === 'URL' ? 'URL' : 'TEXT';
      // "The Backpack card contains '$29.99'": the text is looked for inside that card, and the card is not itself an element to find (UI-07).
      if (subjectNp && type === 'TEXT' && containerRef(subjectNp.original)) {
        decisions.push(`the text is looked for in "${subjectNp.original}", and nowhere else on the page (UI-07)`);
        out.push(
          make({
            type: 'TEXT',
            target: { ontology: 'Element', label: 'text', within: subjectNp.original },
            expect: text,
            check: kind === 'CONTAINS' ? 'contains-text' : 'exact-text',
          }),
        );
        break;
      }
      forTargets(subjectNp, (target) => ({ type, ...(target ? { target } : {}), expect: text, check: kind === 'CONTAINS' ? 'contains-text' : 'exact-text' }));
      break;
    }
    case 'HAS_VALUE':
      forTargets(subjectNp, (target) => ({ type: 'VALUE', ...(target ? { target } : {}), expect: originalText(line, after), check: 'value' }));
      break;
    case 'ENABLED':
    case 'DISABLED':
      forTargets(subjectNp ?? objectNp(), (target) => ({
        type: 'ENABLED',
        ...(target ? { target } : {}),
        expect: kind === 'ENABLED' ? 'ENABLED' : 'DISABLED',
        check: kind === 'ENABLED' ? 'enabled' : 'disabled',
      }));
      break;
    case 'EMPTY':
      forTargets(subjectNp ?? objectNp('Field'), (target) => ({ type: 'VALUE', ...(target ? { target } : {}), expect: '', check: 'value' }));
      break;
    case 'DELETED':
    case 'CHANGED': {
      // "the record is deleted", "User should succesfully deleted employee data": the thing is the object when there is one.
      const np = after.length ? objectNp() : subjectNp;
      decisions.push(`"${words[hit.start]}" says the data changed; the check is on the state of what changed`);
      // "the added data", "the updated records": which data? Whatever the test case entered; the references say what (RF-01).
      const changedWord = words[hit.start] ?? '';
      const generic = !!np && np.words.length > 0 && np.words.every((w) => GENERIC_DATA.has(w));
      // "User should updated the data": it says the data changed but not what shows it. A person says what to check (owner, 4 Nov 2026).
      if (kind === 'CHANGED' && generic && !words.some((w) => OBSERVING.has(w))) {
        issues.push({
          code: 'AMBIGUOUS',
          severity: 'review',
          message: `it says the data was ${changedWord} but not what shows it (a message? the values on the page?)`,
          original: clauseText,
          suggestion: 'Say what is seen: Verify the message "<text>" is shown, or Verify <field> shows "<value>".',
        });
      } else if (kind === 'CHANGED' && generic) {
        issues.push(refIssue(['added', 'created', 'saved', 'stored'].includes(changedWord) ? 'added' : 'updated', np?.original ?? '', clauseText));
      }
      // "Employee Data is deleted": which record was deleted is not said, and the engine does not assume it (owner, 4 Nov 2026).
      if (kind === 'DELETED' && np?.words.some((w) => RECORD_WORDS.has(w))) {
        issues.push({
          code: 'AMBIGUOUS',
          severity: 'review',
          message: `it says "${np.original}" was deleted but not which one`,
          original: clauseText,
          suggestion: 'Name it: Verify "<name>" is not in the list.',
        });
      }
      forTargets(np, (target) => ({
        type: 'STATE',
        ...(target ? { target } : {}),
        expect: kind === 'DELETED' ? 'DELETED' : stateOf(words[hit.start]),
      }));
      break;
    }
    case 'DATA_CLASS': {
      const cls = ['invalid', 'incorrect', 'wrong'].includes(words[hit.start] ?? '') ? 'INVALID' : 'VALID';
      forTargets(subjectNp ?? objectNp(), (target) => ({ type: 'VALUE', ...(target ? { target } : {}), expect: cls, check: 'data-class' }));
      break;
    }
    case 'CHECKED':
    case 'UNCHECKED':
      forTargets(subjectNp ?? objectNp(), (target) => ({
        type: 'STATE',
        ...(target ? { target } : {}),
        expect: kind === 'CHECKED' ? 'CHECKED' : 'UNCHECKED',
        check: kind === 'CHECKED' ? 'checked' : 'unchecked',
      }));
      break;
    case 'HIDDEN':
    case 'VISIBLE':
    case 'SHOWS': {
      const hidden = kind === 'HIDDEN';
      // "The actual password text is not visible": what is typed in a password field is hidden because the field masks it. That is
      // the masked check; "not visible" could never fail on a masked field (owner, 4 Nov 2026).
      const typed = subjectNp?.words ?? [];
      if (
        (hidden || (kind === 'VISIBLE' && negated)) &&
        typed.includes('password') &&
        typed.some((w) => ['text', 'value', 'characters', 'entered', 'typed'].includes(w))
      ) {
        out.push(make({ type: 'MASKED', target: { ontology: 'Password', name: 'Password' }, expect: 'MASKED', check: 'masked' }, kind === 'VISIBLE'));
        break;
      }
      // "The Job Title field shows "Engineer"": a field that shows a value holds it. It is a check of the field, not a message (E0.15).
      const shownValue =
        kind === 'SHOWS' && subjectNp?.headClass && VALUE_HOLDERS.has(subjectNp.headClass) && after.length === 1 && after[0]?.kind === 'LITERAL'
          ? after[0]
          : undefined;
      if (shownValue) {
        forTargets(subjectNp, (target) => ({ type: 'VALUE', ...(target ? { target } : {}), expect: shownValue.value ?? '', check: 'value' }));
        break;
      }
      // "the system displays X", "the user should see X": the thing is the object. "X is displayed": the thing is the subject.
      // "The Backpack card shows the Remove from cart button": the thing is shown in that card, and a word like "from" is part of its name (UI-07).
      const holder = kind === 'SHOWS' && subjectNp && containerRef(subjectNp.original) ? subjectNp.original : undefined;
      const asWritten = kind === 'SHOWS' ? objectNp() : subjectNp;
      const ownPlace = !!asWritten?.within && !!containerRef(asWritten.within);
      const np = holder && !ownPlace && after.length ? { ...parseNounPhrase(line, after, 'Element', { whole: true }), within: holder } : asWritten;
      if (holder && !ownPlace) decisions.push(`what is shown is checked in "${holder}", and nowhere else on the page (UI-07)`);
      // "The Personal Details form or page is shown", "The Success message or the Employee List page is shown": either will do.
      const either = !hidden && !negated ? alternativesIn(line, kind === 'SHOWS' ? after : before) : undefined;
      if (either) {
        decisions.push(
          either.same ? 'the alternatives name one thing in two ways: it is one check' : 'any of the alternatives being shown satisfies the check',
        );
        out.push(
          make({
            type: 'VISIBILITY',
            target: either.targets[0] as IrTarget,
            ...(either.targets.length > 1 ? { alternatives: either.targets.slice(1) } : {}),
            expect: 'VISIBLE',
            check: 'visible',
          }),
        );
        break;
      }
      if (!np) {
        issues.push({ code: 'AMBIGUOUS', severity: 'review', message: 'it does not say what should be visible', original: clauseText });
        break;
      }
      pushVisibility(line, np, hidden, after, tailAfterLead, kind === 'SHOWS', clauseText, make, out, issues);
      // "The password is shown (masked)": the clause splitter takes asides in brackets out, but one written right after a check says
      // something more about the same thing. It is read, or said to be unread: never dropped silently (U6, E0.15).
      const aside = !hidden && kind === 'VISIBLE' ? asideAfter(line, clauseTokens) : undefined;
      if (aside) {
        const inside = aside.map((t) => lw(t));
        if (inside.length === 1 && ['masked', 'encrypted'].includes(inside[0] as string))
          forTargets(np, (target) => ({ type: 'MASKED', ...(target ? { target } : {}), expect: 'MASKED', check: 'masked' }));
        else
          issues.push({
            code: 'AMBIGUOUS',
            severity: 'review',
            message: `the words in brackets "(${originalOf(line, aside)})" are not understood and are not checked`,
            original: clauseText,
            suggestion: 'Say it as a check of its own: Verify <what> is <state>.',
          });
      }
      break;
    }
  }

  if (!out.length && !issues.length) {
    issues.push({
      code: 'NOT_UNDERSTOOD',
      // As for a check with no predicate: one unreadable check goes to a person, the case still runs, never as a PASS (E0.15).
      severity: 'review',
      message: 'the check names no target',
      original: clauseText,
      suggestion: 'Name what is checked: Verify the <name> <button, field, message> is displayed.',
    });
  }
  // "Preferred stream should be selected": which one is preferred is the tester's choice, and the check does not say it (owner, 4 Nov 2026).
  if (out.length && clauseTokens.some((t) => lw(t) === 'preferred') && !clauseTokens.some((t) => t.kind === 'LITERAL')) {
    issues.push({
      code: 'AMBIGUOUS',
      severity: 'review',
      message: 'it says "preferred" but not which one, so there is nothing to compare with',
      original: clauseText,
      suggestion: 'Write the value: Verify "<value>" is selected in <name>.',
    });
  }
  return { predicate: kind, expectations: out, issues, subject };
}

/** The state a changing verb names: "saves" and "saved" are both SAVED. */
const stateOf = (word: string | undefined): string => (word === 'saves' ? 'SAVED' : (word ?? 'CHANGED').toUpperCase());

const kind0 = (h: Hit): Kind => h.def.kind;

/** Words that say the check is on what is seen: "should see the added data". Without one, "should updated the data" says nothing to check. */
const OBSERVING: ReadonlySet<string> = new Set([
  'see',
  'sees',
  'seen',
  'view',
  'shown',
  'show',
  'shows',
  'displayed',
  'display',
  'displays',
  'appear',
  'appears',
  'visible',
  'listed',
  'find',
  'check',
  'checking',
  'verify',
]);
/** Words for a stored record, as opposed to an element of the page. */
const RECORD_WORDS: ReadonlySet<string> = new Set(['data', 'record', 'records', 'row', 'rows', 'entry', 'entries', 'details']);

const refIssue = (word: string, phrase: string, original: string): Omit<Issue, 'where'> => ({
  code: 'NEEDS_REFERENCE',
  severity: 'review',
  reference: word,
  message: `"${phrase}" points at something earlier ("${word}"); the engine does not guess what, it is resolved from what the test case did before`,
  original,
  suggestion: 'Name it: write the field, record or value itself instead of "same", "added", "entered", "it".',
});

// "… tabs and PIM as a default page": a tail that says how the thing is shown, not what is shown. What is shown is checked; the tail is
// kept as written and listed, but it does not stop the case (it stopped 17 cases of one workbook).
const DESCRIBES = ['as a ', 'as an ', 'as the ', 'as default'];

/** The words in brackets written right after the clause in its line ("… is shown (masked)"), if there are any. */
function asideAfter(line: Line, clauseTokens: readonly Token[]): Token[] | undefined {
  const last = clauseTokens[clauseTokens.length - 1];
  const at = last ? line.tokens.indexOf(last) : -1;
  if (at < 0 || !isSymbol(line.tokens[at + 1], '(')) return undefined;
  const close = line.tokens.findIndex((t, k) => k > at + 1 && isSymbol(t, ')'));
  return close > at + 2 ? line.tokens.slice(at + 2, close) : undefined;
}

/** The kinds of element whose content is a value: what they "show" is what they hold (E0.15). */
const VALUE_HOLDERS: ReadonlySet<string> = new Set(['Field', 'Dropdown']);

/** "as a default page", "as the landing page": the words say the thing before them is the page shown first (E0.15). */
const DEFAULT_PAGE_WORDS: ReadonlySet<string> = new Set([
  'as a default page',
  'as the default page',
  'as default page',
  'as a default screen',
  'as the default screen',
  'as the landing page',
  'as a landing page',
]);
const isDefaultPage = (dropped: string): boolean => DEFAULT_PAGE_WORDS.has(dropped.toLowerCase().split(' ').filter(Boolean).join(' '));
const droppedIssue = (text: string, original: string): Omit<Issue, 'where'> => {
  const describes = DESCRIBES.some((d) => `${text.toLowerCase()} `.startsWith(d));
  return {
    code: 'AMBIGUOUS',
    severity: describes ? 'info' : 'review',
    message: describes
      ? `the words "${text}" describe what is shown; they are kept as written and nothing verifies them`
      : `the words "${text}" are not understood and are not checked`,
    original,
    suggestion: 'Say it as a check of its own: Verify <what> is <state>.',
  };
};

const refineName = (name: string | undefined, cls: string): string => {
  const lower = (name ?? '').toLowerCase();
  if (cls !== 'Field') return cls;
  if (lower.includes('password')) return 'Password';
  return ['username', 'user name', 'login name', 'user id'].some((n) => lower === n || lower.endsWith(` ${n}`)) ? 'Username' : 'Field';
};

const originalText = (line: Line, tokens: readonly Token[]): string => {
  const lit = tokens.find((t) => t.kind === 'LITERAL');
  return lit ? (lit.value ?? '') : originalOf(line, tokens);
};

/** Words that say what kind of screen it is, not which one: "the Add Employee page/popup" is the Add Employee screen (E0.15). */
const SCREEN_WORDS: ReadonlySet<string> = new Set(['page', 'screen', 'popup', 'pop-up', 'dialog', 'modal', 'section', 'window']);

/**
 * The page named after "to" or "on": the words minus the articles and the screen words after the name, alone or joined ("page/popup",
 * "page or popup"). After a screen word, "of …" names the application, not the page: "login section of Orange HRM" is "login".
 */
function pageOf(line: Line, tokens: readonly Token[]): string | undefined {
  let body = tokens.filter((t, i) => !(i === 0 && ['the', 'a', 'an'].includes(lw(t))));
  const of = body.findIndex((t, i) => i > 0 && SCREEN_WORDS.has(lw(t)) && lw(body[i + 1]) === 'of');
  if (of > 0) body = body.slice(0, of);
  // Trailing screen words, and the "/" or "or" between two of them; never the whole name.
  for (;;) {
    const last = lw(body[body.length - 1]);
    const joiner = (last === '/' || last === 'or') && SCREEN_WORDS.has(lw(body[body.length - 2]));
    if (body.length > 1 && (SCREEN_WORDS.has(last) || joiner)) body = body.slice(0, -1);
    else break;
  }
  const text = originalOf(line, body);
  return text || undefined;
}

/** Visible or hidden: one expectation per thing, a message by its class, quoted text by its exact words. */
function pushVisibility(
  line: Line,
  np: NounPhrase,
  hidden: boolean,
  after: readonly Token[],
  tailAfterLead: readonly Token[],
  objectIsNp: boolean,
  clauseText: string,
  make: (c: IrCondition, flip?: boolean) => CheckResult['expectations'][number],
  out: CheckResult['expectations'],
  issues: CheckResult['issues'],
): void {
  const expect = hidden ? 'HIDDEN' : 'VISIBLE';
  // "User should see tabs and PIM as a default page": two checks in one sentence. The last thing named is the page shown first (the
  // same check as "PIM is the default page"); the things before it are shown (E0.15).
  if (!hidden && np.dropped && isDefaultPage(np.dropped) && np.targets.length) {
    const last = np.targets[np.targets.length - 1] as IrTarget;
    for (const target of np.targets.slice(0, -1)) out.push(make({ type: 'VISIBILITY', target, expect, check: 'visible' }));
    out.push(make({ type: 'STATE', target: { ontology: 'Page', name: last.name ?? last.label ?? '' }, expect: 'DEFAULT_PAGE' }));
    return;
  }
  // "The Add Employee form or page is displayed": two alternatives. Which one is checked is the tester's to say; none is picked.
  if (np.words.includes('or')) {
    issues.push({
      code: 'AMBIGUOUS',
      severity: 'review',
      message: `the check names alternatives ("${np.original}"): the engine does not pick one`,
      original: clauseText,
      suggestion: 'Name the one that should be shown: Verify the <name> form is displayed.',
    });
    return;
  }
  if (np.headClass && MESSAGE_CLASSES.has(np.headClass)) {
    const { target, text } = messageTarget(np);
    // What follows the message: "indicating that the username is required", "for the missing credentials".
    const tail = tailAfterLead.length ? tailAfterLead : [];
    const said = tail.length
      ? originalOf(
          line,
          tail.filter((t, i) => !(i === 0 && lw(t) === 'that')),
        )
      : undefined;
    const meaning = said ?? text;
    // "… are displayed for the missing credentials": a place word after the verb says what the message is about.
    const placeAt =
      !objectIsNp && after.length && ['for', 'near', 'under', 'below', 'beside', 'next'].includes(lw(after[0]))
        ? after.slice(1).filter((t, i) => !(i === 0 && lw(t) === 'the'))
        : [];
    const near = np.within ?? (placeAt.length ? originalOf(line, placeAt) : nearOf(said));
    out.push(
      make({
        type: 'VISIBILITY',
        target: { ...target, ...(near ? { near } : {}) },
        expect,
        ...(meaning ? { text: meaning } : {}),
        fresh: !hidden,
        check: 'visible',
      }),
    );
    return;
  }
  const quoted = literalIn(line, np);
  if (quoted !== undefined) {
    // "'$29.99' is displayed on the Backpack card": the text is looked for in that card (UI-07).
    const sayPlace =
      !objectIsNp && after.length && ['in', 'on', 'at', 'within', 'inside'].includes(lw(after[0]))
        ? after
            .slice(1)
            .filter((t, i) => !(i === 0 && lw(t) === 'the'))
            .map((t) => t.text)
            .join(' ')
        : '';
    const inside = [np.within, sayPlace].find((w) => w && containerRef(w));
    out.push(
      make({
        type: 'TEXT',
        target: { ontology: np.headClass ?? 'Message', label: np.headClass ? undefined : 'message', ...(inside ? { within: inside } : {}) },
        expect: quoted,
        fresh: !hidden,
        // Said to be in a card, the text is somewhere in what the card shows ("Price: $29.99" holds "$29.99"); a message is the exact words.
        check: inside ? 'contains-text' : 'exact-text',
      }),
    );
    return;
  }
  // "The added data is displayed on the Personal Information page / in the table": where it is shown is part of the check.
  const place =
    !objectIsNp && after.length && ['in', 'on', 'at', 'under', 'within'].includes(lw(after[0]))
      ? after.slice(1).filter((t, i) => !(i === 0 && lw(t) === 'the'))
      : [];
  const where = np.within ?? (place.length ? place.map((t) => t.text).join(' ') : undefined);
  for (const target of np.targets) {
    out.push(make({ type: 'VISIBILITY', target: { ...target, ...(where ? { within: where } : {}) }, expect, check: 'visible' }));
  }
  if (!np.targets.length) issues.push({ code: 'AMBIGUOUS', severity: 'review', message: 'it does not say what should be visible', original: clauseText });
}

const literalIn = (line: Line, np: NounPhrase): string | undefined => {
  const t = line.tokens.find((x) => x.kind === 'LITERAL' && np.original.includes(x.text));
  return t?.value;
};

const ALTERNATIVE_MESSAGES: ReadonlySet<string> = new Set(['Message', 'Error', 'Validation', 'Success', 'Warning', 'Toast', 'Alert']);

/**
 * "X or Y" in a check of what is shown. When the second part only says another kind of thing ("form or page"), both are
 * one name written twice and the check is on that name. When both parts have names, the check holds if either is shown.
 * Messages are left out: what they say is judged by their meaning, which a list of names cannot carry.
 */
function alternativesIn(line: Line, tokens: readonly Token[]): { targets: IrTarget[]; same: boolean } | undefined {
  const at = tokens.findIndex((t) => lw(t) === 'or');
  if (at <= 0 || at === tokens.length - 1) return undefined;
  const parts: Token[][] = [[]];
  for (const t of tokens) {
    if (lw(t) === 'or') parts.push([]);
    else (parts[parts.length - 1] as Token[]).push(t);
  }
  const nps = parts.map((p) => parseNounPhrase(line, p, 'Element'));
  if (nps.some((n) => n.headClass && ALTERNATIVE_MESSAGES.has(n.headClass))) return undefined;
  const first = nps[0]?.targets[0];
  if (!first?.name) return undefined;
  const named = nps.map((n) => n.targets[0]).filter((t): t is IrTarget => !!t?.name);
  // The later parts have no name of their own: "form or page" are two words for the thing the first part names.
  if (named.length === 1) return { targets: [first], same: true };
  if (named.length !== nps.length) return undefined;
  return { targets: named, same: false };
}
