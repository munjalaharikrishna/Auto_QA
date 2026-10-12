import type { IrCondition, IrTarget } from '../ir/schema.js';
import type { Token } from '../text/index.js';
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
  | 'APP_STARTED';

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
  p('APP_STARTED', 95, 'open browser', 'open the browser', 'open application', 'open the application', 'launch browser', 'launch application'),
  p('MASKED', 90, 'masked characters', 'masked', 'asterisks', 'dots', 'obscured'),
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
  p('ACCEPTED', 55, 'accept', 'accepts', 'accepted', 'allowed'),
  p('CONTAINS', 70, 'contains', 'contain', 'containing', 'includes', 'include', 'says', 'reads', 'with text', 'text is'),
  p('EQUALS', 70, 'equals', 'equal to', 'equal', 'exactly'),
  p('HAS_VALUE', 66, 'has value', 'have value', 'has the value', 'shows value'),
  p('DISABLED', 65, 'disabled', 'greyed out', 'grayed out', 'inactive', 'unclickable', 'read-only', 'readonly'),
  p('ENABLED', 64, 'enabled', 'clickable', 'active', 'editable'),
  p('EMPTY', 60, 'empty', 'blank', 'cleared', 'emptied'),
  p('CHECKED', 58, 'checked', 'ticked', 'selected'),
  p('UNCHECKED', 58, 'unchecked', 'unticked', 'deselected'),
  last(p('DATA_CLASS', 62, 'invalid', 'valid', 'incorrect', 'correct', 'wrong')),
  p('DELETED', 57, 'deleted', 'removed', 'erased'),
  p('CHANGED', 56, 'updated', 'saved', 'added', 'created', 'modified', 'changed', 'stored'),
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
function earliestPredicate(words: readonly string[]): number {
  let first = words.length;
  for (const def of PREDICATES) {
    for (const phrase of def.phrases) {
      for (let i = 0; i + phrase.length <= words.length && i < first; i++) {
        if (phrase.every((w, k) => words[i + k] === w) && !(def.endOnly && i + phrase.length !== words.length)) first = i;
      }
    }
  }
  return first;
}

function findPredicate(words: readonly string[]): Hit | undefined {
  let best: Hit | undefined;
  for (const def of PREDICATES) {
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
  const hit = thereNp ? undefined : findPredicate(words);
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
          severity: 'blocking',
          message: 'no check could be read: no word says what should be true',
          original: clauseText,
          suggestion: 'Say what should be true on the screen, for example: Verify the <name> <button, field, message> is displayed.',
        },
      ],
      subject: inherited,
    };
  }

  const before = kept.slice(0, Math.min(hit.start, earliestPredicate(words)));
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
    if (np?.dropped) issues.push(droppedIssue(np.dropped, clauseText));
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
        message: 'the check compares with the value entered in an earlier step, which is resolved when references are built',
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
      forTargets(np, (target) => ({
        type: 'STATE',
        ...(target ? { target } : {}),
        expect: kind === 'DELETED' ? 'DELETED' : (words[hit.start] ?? 'CHANGED').toUpperCase(),
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
      // "the system displays X", "the user should see X": the thing is the object. "X is displayed": the thing is the subject.
      const np = kind === 'SHOWS' ? objectNp() : subjectNp;
      if (!np) {
        issues.push({ code: 'AMBIGUOUS', severity: 'review', message: 'it does not say what should be visible', original: clauseText });
        break;
      }
      pushVisibility(line, np, hidden, after, tailAfterLead, kind === 'SHOWS', clauseText, make, out, issues);
      break;
    }
  }

  if (!out.length && !issues.length) {
    issues.push({
      code: 'NOT_UNDERSTOOD',
      severity: 'blocking',
      message: 'the check names no target',
      original: clauseText,
      suggestion: 'Name what is checked: Verify the <name> <button, field, message> is displayed.',
    });
  }
  return { predicate: kind, expectations: out, issues, subject };
}

const kind0 = (h: Hit): Kind => h.def.kind;

const refIssue = (word: string, phrase: string, original: string): Omit<Issue, 'where'> => ({
  code: 'NEEDS_REFERENCE',
  severity: 'review',
  message: `"${phrase}" points at something earlier ("${word}"); the engine does not guess what: it is resolved when references are built`,
  original,
  suggestion: 'Name it: write the field, record or value itself instead of "same", "added", "entered", "it".',
});

const droppedIssue = (text: string, original: string): Omit<Issue, 'where'> => ({
  code: 'AMBIGUOUS',
  severity: 'review',
  message: `the words "${text}" are not understood and are not checked`,
  original,
  suggestion: 'Say it as a check of its own: Verify <what> is <state>.',
});

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

/** The page named after "to" or "on": the words minus the articles and a trailing "page". */
function pageOf(line: Line, tokens: readonly Token[]): string | undefined {
  const body = tokens.filter((t, i) => !(i === 0 && ['the', 'a', 'an'].includes(lw(t))));
  const last = body[body.length - 1];
  const trimmed = last && ['page', 'screen'].includes(lw(last)) && body.length > 1 ? body.slice(0, -1) : body;
  const text = originalOf(line, trimmed);
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
    out.push(
      make({
        type: 'TEXT',
        target: { ontology: np.headClass ?? 'Message', label: np.headClass ? undefined : 'message' },
        expect: quoted,
        fresh: !hidden,
        check: 'exact-text',
      }),
    );
    return;
  }
  for (const target of np.targets) {
    out.push(make({ type: 'VISIBILITY', target: { ...target, ...(np.within ? { within: np.within } : {}) }, expect, check: 'visible' }));
  }
  if (!np.targets.length) issues.push({ code: 'AMBIGUOUS', severity: 'review', message: 'it does not say what should be visible', original: clauseText });
}

const literalIn = (line: Line, np: NounPhrase): string | undefined => {
  const t = line.tokens.find((x) => x.kind === 'LITERAL' && np.original.includes(x.text));
  return t?.value;
};
