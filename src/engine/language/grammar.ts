import type { IrAction, IrCondition, IrTarget } from '../ir/schema.js';
import { keyOf, patterns } from '../patterns/index.js';
import { compactKey } from '../text/compound.js';
import type { Token } from '../text/index.js';
import { type Clause, splitClauses } from './clauses.js';
import { bindValue, type DataEntry } from './data-binding.js';
import { type NounPhrase, type NounPhraseOptions, parseNounPhrase } from './nounphrase.js';
import { actionsOf, allowsAction } from './ontology.js';
import { type CheckResult, MESSAGE_HEADS, PREDICATE_STARTS, parseCheck, type Subject } from './predicates.js';
import { matchPhrase } from './synonyms.js';
import type { Given, GrammarModel, Issue, LineConditional, LineResult, ParsedConditional, ParsedExpectation, ParsedStep, ValueSpec } from './types.js';
import { isSymbol, type Line, lw, originalOf, readLine, wordsOf } from './view.js';
import { isCommandForm, VERBS, type VerbDef, verbOf } from './vocabulary.js';

/**
 * Layer 7, the QA grammar (GR-01 to GR-11). A line is cut into clauses (CL-01) and each clause is read as an action or
 * as a check. The clauses are then put together by the ten models:
 *
 *   GR-01 Action + Target             GR-02 Action + Target + Value       GR-03 Action + Target + Value + Condition
 *   GR-04 Action + Target + Expected  GR-05 Verify + Condition            GR-06 Verify + Expected result
 *   GR-07 If + Condition + Then       GR-08 When + Condition + Result
 *   GR-09 After + Action + Expected   GR-10 Before + Action + Expected
 *
 * GR-11, positional translation, is how an action reads its parts: "Enter cypress in username field" is
 * ACTION=ENTER_VALUE, TARGET=username field, VALUE=cypress. A sentence that fits no model is never guessed: it is
 * reported as an issue and nothing is built on it.
 */

export type Mode = 'step' | 'expected';

export interface LineContext {
  data: readonly DataEntry[];
  /** What is known about the data so far: field → `INVALID`, `VALID`, `BLANK`. Read for conditions, added to by steps. */
  facts: Map<string, string>;
  mode: Mode;
}

type PartialIssue = Omit<Issue, 'where'>;

const FILLERS: ReadonlySet<string> = new Set(['then', 'also', 'next', 'please', 'now', 'finally', 'and', 'but', 'or', 'to']);
const ACTORS: ReadonlySet<string> = new Set(['user', 'tester', 'visitor', 'customer']);
const MODALS: ReadonlySet<string> = new Set(['should', 'must', 'will', 'shall', 'can', 'is', 'are']);
const MARKER_STARTS: ReadonlySet<string> = new Set([
  'verify',
  'validate',
  'confirm',
  'ensure',
  'expect',
  'assert',
  'verifying',
  'validating',
  'confirming',
  'ensuring',
]);
const PREPS: ReadonlySet<string> = new Set(['in', 'into', 'on', 'to', 'for', 'with', 'as', 'from', 'at', 'onto', 'inside', 'within']);

const DEFAULT_CLASS: Partial<Record<IrAction, string>> = {
  ENTER_VALUE: 'Field',
  CLEAR: 'Field',
  SELECT: 'Dropdown',
  CHECK: 'Checkbox',
  UNCHECK: 'Checkbox',
  NAVIGATE: 'Page',
  UPLOAD: 'Button',
  SAVE: 'Button',
  SUBMIT: 'Button',
  CANCEL: 'Button',
  CLOSE: 'Button',
  SEARCH: 'Field',
  DELETE: 'Record',
  REMOVE: 'Record',
  EDIT: 'Record',
};

const stepStart = (words: readonly string[]): number => {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w !== undefined && FILLERS.has(w) && !(w === 'to' && verbOf(words[i + 1] ?? '') === undefined && words[i + 1] !== 'be')) i++;
    else break;
  }
  return i;
};

/** Takes off "user", "the user", "tester" and a modal after it: the subject of an action sentence. */
function afterSubject(words: readonly string[], from: number): { index: number; modal: boolean } {
  let i = from;
  if (words[i] === 'the' && ACTORS.has(words[i + 1] ?? '')) i++;
  if (ACTORS.has(words[i] ?? '')) {
    i++;
    const modal = MODALS.has(words[i] ?? '');
    if (modal) i++;
    if (words[i] === 'able' && words[i + 1] === 'to') i += 2;
    return { index: i, modal };
  }
  return { index: from, modal: false };
}

/** The phrases of the Navigation category that are actions on their own: starting the application, going back or forward. */
const NAV_ACTIONS: ReadonlySet<string> = new Set(['open application', 'go back', 'go forward']);
const navAction = (words: readonly string[], i: number): { canonical: string; length: number } | undefined => {
  const hit = matchPhrase('Navigation', words, i, 6);
  return hit && NAV_ACTIONS.has(hit.canonical) ? hit : undefined;
};

/** Words that, right after a word, make it the subject of a sentence ("Login is rejected") and not a command ("Login"). */
const AFTER_SUBJECT: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'were',
  'should',
  'must',
  'shall',
  'will',
  'cannot',
  'does',
  'did',
  'has',
  'have',
  'remains',
  'stays',
  'appears',
  'fails',
  'succeeds',
]);

interface VerbHit {
  def: VerbDef;
  length: number;
  via?: string;
}

function readVerb(words: readonly string[], i: number): VerbHit | undefined {
  const direct = verbOf(words[i] ?? '');
  if (direct) return { def: direct, length: 1 };
  const syn = matchPhrase('Action', words, i, 3);
  const def = syn ? verbOf(syn.canonical) : undefined;
  return syn && def ? { def, length: syn.length, via: words.slice(i, i + syn.length).join(' ') } : undefined;
}

/** Whether a clause is an action, a check, or neither (unknown). */
function kindOf(line: Line, clause: Clause, ctx: LineContext): 'action' | 'check' | 'unknown' | 'unsupported' {
  const words = wordsOf(clause.tokens);
  let i = stepStart(words);
  const first = words[i];
  if (first === undefined) return 'unknown';
  if (MARKER_STARTS.has(first) || matchPhrase('Assertion', words, i, 3)) return 'check';
  const subject = afterSubject(words, i);
  if (subject.index !== i) {
    if (subject.modal) return 'check';
    i = subject.index;
  }
  const head = words[i] ?? '';

  if (head === 'check' || head === 'checking' || head === 'checked') {
    if (words[i + 1] === 'that') return 'check';
    const np = parseNounPhrase(line, clause.tokens.slice(i + 1), 'Checkbox');
    if (np.headClass === 'Checkbox' || np.headClass === 'RadioButton') return 'action';
    // "Check Send me news": a bare name in a step is a box to tick. Anything with a place, a state or a reference is a check.
    const bare = ctx.mode === 'step' && !hasPredicate(words.slice(i + 1)) && np.headClass === undefined && !np.within && !np.reference && np.words.length <= 4;
    return bare ? 'action' : 'check';
  }
  if (head === 'leave' || navAction(words, i)) return 'action';
  const imperative = VERBS.some((v) => v.forms[0] === head) || readVerb(words, i)?.via !== undefined;
  const subjectLed = AFTER_SUBJECT.has(words[i + 1] ?? '') || words[i + 1] === 'not';
  if (imperative && !hasModal(words.slice(i + 1, i + 4)) && !subjectLed) return 'action';
  if (subject.index !== stepStart(words) && verbOf(head)) return 'action';
  if (hasPredicate(words)) return 'check';
  // "Error message: Epic sadface…": a message class, a colon, and the text it shows.
  const colon = clause.tokens.findIndex((t) => isSymbol(t, ':'));
  if (colon > 0 && MESSAGE_HEADS.has(parseNounPhrase(line, clause.tokens.slice(0, colon), 'Message').headClass ?? '')) return 'check';
  if (imperative) return 'action';
  return ctx.mode === 'step' ? 'unsupported' : 'unknown';
}

const hasModal = (words: readonly string[]): boolean => words.some((w) => ['should', 'must', 'shall'].includes(w));

const hasPredicate = (words: readonly string[]): boolean => words.some((w) => PREDICATE_STARTS.has(w));

/** Prepositions that say where a value is entered. */
const PLACE_PREPS: ReadonlySet<string> = new Set(['in', 'into', 'on', 'onto', 'to', 'at', 'inside', 'for']);

const prepIndex = (tokens: readonly Token[], preps: ReadonlySet<string> = PREPS): number => {
  for (let i = 1; i < tokens.length; i++) if (tokens[i]?.kind === 'WORD' && preps.has(lw(tokens[i]))) return i;
  return -1;
};

interface ReadAction {
  steps: Array<Omit<ParsedStep, 'model'>>;
  issues: PartialIssue[];
  model: GrammarModel;
  unsupported?: string;
}

const ambiguous = (message: string, original: string, suggestion?: string): PartialIssue => ({
  code: 'AMBIGUOUS',
  severity: 'review',
  message,
  original,
  ...(suggestion ? { suggestion } : {}),
});

/** Reads one action clause: the verb, then its parts by position (GR-11). */
function readAction(line: Line, clause: Clause, ctx: LineContext): ReadAction {
  const words = wordsOf(clause.tokens);
  const issues: PartialIssue[] = [];
  const decisions: string[] = [];
  const original = clause.original;
  /** Reads a noun phrase and reports what it points at earlier, or what it says that is not understood. */
  const parseNp = (tokens: readonly Token[], fallback?: string, options?: NounPhraseOptions): NounPhrase => {
    const n = parseNounPhrase(line, tokens, fallback, options);
    if (n.reference) {
      issues.push({
        code: 'NEEDS_REFERENCE',
        severity: 'review',
        reference: n.reference,
        message: `"${n.original}" points at something earlier ("${n.reference}"); the engine does not guess what, it is resolved from what the test case did before`,
        original,
        suggestion: 'Name it: write the field, record or value itself instead of "same", "added", "entered", "it".',
      });
    }
    if (n.dropped) {
      issues.push({
        code: 'AMBIGUOUS',
        severity: 'review',
        message: `the words "${n.dropped}" are not understood and are not checked`,
        original,
        suggestion: 'Say it as a check of its own: Verify <what> is <state>.',
      });
    }
    return n;
  };
  let i = afterSubject(words, stepStart(words)).index;
  const step = (action: IrAction, target?: IrTarget, value?: ValueSpec): Omit<ParsedStep, 'model'> => ({
    action,
    ...(target ? { target } : {}),
    ...(value ? { value } : {}),
    original,
    decisions: [...decisions],
  });
  const done = (steps: Array<Omit<ParsedStep, 'model'>>, model: GrammarModel): ReadAction => {
    for (const s of steps) {
      const cls = s.target?.ontology;
      if (cls && cls !== 'Element' && !allowsAction(cls, s.action)) {
        issues.push({
          code: 'PARADOX',
          severity: 'blocking',
          message: `"${cls}" cannot be the target of ${s.action}; it allows ${actionsOf(cls).join(', ') || 'no action'}`,
          original,
          suggestion: `Use an action a ${cls.toLowerCase()} allows (${actionsOf(cls).slice(0, 4).join(', ').toLowerCase()}), or name a different element.`,
        });
      }
    }
    return { steps, issues, model };
  };

  // Phrases of the Navigation category: "open browser", "launch the application", "enter URL for X", "go back".
  const nav = navAction(words, i);
  if (nav?.canonical === 'open application') {
    decisions.push(`"${words.slice(i, i + nav.length).join(' ')}" starts the application`);
    const url = clause.tokens.find((t) => t.kind === 'URL');
    return done([step('NAVIGATE', { ontology: 'Page', name: 'Application' }, url ? { kind: 'literal', value: url.text } : undefined)], 'GR-01');
  }
  if (nav?.canonical === 'go back') return done([step('BACK')], 'GR-01');
  if (nav?.canonical === 'go forward') return done([step('FORWARD')], 'GR-01');

  // "Leave the Login Name text box blank": a field left empty on purpose.
  if (words[i] === 'leave') {
    const rest = clause.tokens.slice(i + 1);
    const end = rest.findIndex((t, k) => k > 0 && ['blank', 'empty'].includes(lw(t)));
    const np = parseNp(end >= 0 ? rest.slice(0, end) : rest, 'Field');
    if (end < 0)
      return {
        steps: [],
        issues: [ambiguous('"leave" needs to say what is left blank', original, 'Write: Leave the <field name> field blank')],
        model: 'GR-02',
        unsupported: undefined,
      };
    decisions.push('"leave … blank" is a value of class BLANK');
    return done(
      np.targets.map((t) => step('ENTER_VALUE', t, { kind: 'blank' })),
      'GR-02',
    );
  }

  const hit = readVerb(words, i);
  if (!hit) {
    const first = originalOf(line, clause.tokens.slice(i, i + 1));
    return {
      steps: [],
      issues: [
        {
          code: 'UNSUPPORTED',
          severity: 'blocking',
          message: `not understood: "${first}" is not one of the actions the engine knows (click, enter, select, open, …), and no synonym maps it to one`,
          original,
          suggestion: `Start the step with an action word, for example: Click the '<name>' button, Enter <value> in the <field> field.`,
        },
      ],
      model: 'GR-01',
      unsupported: first,
    };
  }
  if (hit.via) decisions.push(`"${hit.via}" is read as ${hit.def.verb} (synonym)`);
  i += hit.length;
  // "Enter/update the Job Title": a second verb joined by a slash names the same step.
  if (isSymbol(clause.tokens[i], '/') && lw(clause.tokens[i + 1]) !== undefined && !readVerb(words, i + 1)) {
    decisions.push(`"${lw(clause.tokens[i + 1])}" after the slash is the same step`);
    i += 2;
  }
  let rest = clause.tokens.slice(i);
  const action = hit.def.action;

  switch (action) {
    case 'NAVIGATE': {
      if (lw(rest[0]) === 'to') rest = rest.slice(1);
      const url = rest.find((t) => t.kind === 'URL');
      if (url) return done([step('NAVIGATE', { ontology: 'Page', name: 'Application' }, { kind: 'literal', value: url.text })], 'GR-02');
      if (!rest.length) return done([step('NAVIGATE', { ontology: 'Page', name: 'Application' })], 'GR-01');
      const np = parseNp(rest, 'Page');
      const target = np.targets[0] as IrTarget;
      return done([step('NAVIGATE', { ...target, ontology: 'Page' })], 'GR-01');
    }
    case 'PRESS': {
      const text = clause.tokens.map((t) => t.text).join(' ');
      const key = patterns()
        .scan(text, ['keyboardKey'])
        .matches.map((m) => keyOf(m))
        .find((k) => k);
      if (key) return done([step('PRESS', undefined, { kind: 'literal', value: key })], 'GR-02');
      const np = parseNp(rest, 'Element');
      decisions.push('"press" on a named element clicks it (SY-01: press and click are separate drivers, grammar decides)');
      return done(
        np.targets.map((t) => step('CLICK', t)),
        'GR-01',
      );
    }
    case 'ENTER_VALUE': {
      if (!rest.length)
        return {
          steps: [],
          issues: [ambiguous('it does not say what to enter or where', original, 'Write: Enter <value> in the <field name> field')],
          model: 'GR-02',
        };
      const cut = prepIndex(rest, new Set([...PLACE_PREPS, 'with']));
      if (hit.def.verb === 'fill' && cut > 0 && lw(rest[cut]) === 'with') {
        const np = parseNp(rest.slice(0, cut), 'Field', { field: true });
        const bound = bindValue(line, rest.slice(cut + 1), ctx.data, np.targets[0]?.name);
        decisions.push(...bound.decisions);
        return done(
          np.targets.map((t) => step('ENTER_VALUE', t, bound.spec)),
          'GR-02',
        );
      }
      const placeCut = prepIndex(rest, PLACE_PREPS);
      if (placeCut > 0) {
        const cut = placeCut;
        const valueTokens = rest.slice(0, cut);
        const place = parseNp(rest.slice(cut + 1), 'Field', { field: true });
        const generic = place.targets.every((t) => !t.name);
        if (generic) {
          // "Enter the Job Title, Status in respective fields": the first phrase names the fields, the second only says "fields".
          const names = parseNp(valueTokens, 'Field', { field: true });
          decisions.push('the first phrase names the fields; no value is given for them');
          return done(
            names.targets.map((t) =>
              step(
                'ENTER_VALUE',
                { ...t, ontology: t.ontology === 'Element' ? 'Field' : t.ontology },
                { kind: 'class', dataClass: 'VALID', field: t.name ?? '' },
              ),
            ),
            'GR-02',
          );
        }
        const target = place.targets[0] as IrTarget;
        const bound = bindValue(line, valueTokens, ctx.data, target.name);
        decisions.push(...bound.decisions);
        return done(
          place.targets.map((t) => step('ENTER_VALUE', t, bound.spec)),
          'GR-02',
        );
      }
      // "Enter username", "Enter Full name": the phrase names the field, and the value is looked up under that name.
      const np = parseNp(rest, 'Field', { field: true });
      const out: Array<Omit<ParsedStep, 'model'>> = [];
      np.targets.forEach((t, k) => {
        const bound = bindValue(line, np.itemTokens[k] ?? rest, ctx.data, t.name);
        decisions.push(...bound.decisions);
        out.push(step('ENTER_VALUE', t, bound.spec));
      });
      return done(out, 'GR-02');
    }
    case 'SELECT': {
      const cut = prepIndex(rest, new Set(['from', 'in', 'of', 'on']));
      if (cut > 0) {
        const place = parseNp(rest.slice(cut + 1), 'Dropdown');
        const target = place.targets[0] as IrTarget;
        const bound = bindValue(line, rest.slice(0, cut), ctx.data, target.name);
        decisions.push(...bound.decisions);
        const literal: ValueSpec = bound.spec.kind === 'class' && bound.spec.dataClass === 'VALID' && bound.spec.field ? bound.spec : bound.spec;
        return done([step('SELECT', target, literal)], 'GR-02');
      }
      const np = parseNp(rest, DEFAULT_CLASS.SELECT ?? 'Element');
      return done(
        np.targets.map((t) => step('SELECT', t)),
        'GR-01',
      );
    }
    case 'UPLOAD': {
      const by = rest.findIndex((t) => lw(t) === 'by');
      const nested = by >= 0 ? rest.slice(by + 1) : [];
      const what = parseNp(by >= 0 ? rest.slice(0, by) : rest, 'File');
      let target: IrTarget = { ontology: 'Button', label: 'upload button' };
      if (nested.length) {
        const inner = readAction(line, { ...clause, tokens: nested, original: originalOf(line, nested) }, ctx);
        const t = inner.steps[0]?.target;
        if (t) target = t;
        decisions.push('"by clicking …" names the element that opens the file chooser');
      } else if (what.headClass === 'Button') target = what.targets[0] as IrTarget;
      return done(
        [step('UPLOAD', target, { kind: 'class', dataClass: 'VALID', field: what.headClass === 'Button' ? 'file' : (what.targets[0]?.name ?? 'file') })],
        'GR-02',
      );
    }
    case 'LOGIN': {
      const cut = prepIndex(rest, new Set(['with', 'as', 'using']));
      if (cut >= 0) {
        const bound = bindValue(line, rest.slice(cut + 1), ctx.data, 'credentials');
        decisions.push(...bound.decisions);
        return done([step('LOGIN', { ontology: 'User' }, bound.spec)], 'GR-02');
      }
      return done([step('LOGIN', { ontology: 'User' })], 'GR-01');
    }
    case 'SEARCH': {
      // "Search for 'laptop' in the Search field", "Search 'laptop' in the Search field", "Search for 'laptop'".
      const body = lw(rest[0]) === 'for' ? rest.slice(1) : rest;
      const cut = prepIndex(body, new Set(['in', 'on', 'into']));
      if (cut > 0) {
        const target = parseNp(body.slice(cut + 1), 'Field').targets[0] as IrTarget;
        const bound = bindValue(line, body.slice(0, cut), ctx.data, target.name);
        decisions.push(...bound.decisions);
        return done([step('SEARCH', target, bound.spec)], 'GR-02');
      }
      const bound = bindValue(line, body, ctx.data, 'search');
      decisions.push(...bound.decisions);
      return done([step('SEARCH', { ontology: 'Field', name: 'Search' }, bound.spec)], 'GR-02');
    }
    default: {
      if (['on', 'at', 'over'].includes(lw(rest[0]))) rest = rest.slice(1);
      if (action === 'REFRESH' || action === 'BACK' || action === 'FORWARD') return done([step(action)], 'GR-01');
      if (!rest.length) {
        const needs = !['SAVE', 'SUBMIT', 'CANCEL', 'CLOSE', 'LOGOUT', 'SCROLL', 'DOWNLOAD'].includes(action);
        if (needs)
          return {
            steps: [],
            issues: [
              ambiguous(
                `it does not say what to ${hit.def.verb}`,
                original,
                `Write: ${hit.def.verb[0]?.toUpperCase()}${hit.def.verb.slice(1)} the '<name>' <button, link, field …>`,
              ),
            ],
            model: 'GR-01',
          };
        return done([step(action)], 'GR-01');
      }
      // One thing is clicked or hovered: "Click Terms and Conditions" is one name.
      const np = parseNp(rest, DEFAULT_CLASS[action] ?? 'Element', { single: ['CLICK', 'HOVER'].includes(action) });
      if (np.headClass === undefined && action !== 'CLICK') decisions.push(`no kind of element named: read as a ${np.targets[0]?.ontology}`);
      return done(
        np.targets.map((t) => step(action, t)),
        'GR-01',
      );
    }
  }
}

/** What is known about a condition before the run (CD-02): its truth from the facts, or UNKNOWN, never a guess. */
export function evaluate(condition: IrCondition, negated: boolean, facts: ReadonlyMap<string, string>): { given: Given; because: string } {
  const name = condition.target?.name;
  const key = name ? compactKey(name) : '';
  const fact = key ? facts.get(key) : undefined;
  if (condition.check === 'data-class' && fact !== undefined) {
    const truth = fact === condition.expect;
    return { given: truth !== negated ? 'TRUE' : 'FALSE', because: `the test case sets ${name} to a ${fact.toLowerCase()} value` };
  }
  if (condition.type === 'VALUE' && condition.expect === '' && fact !== undefined) {
    return { given: (fact === 'BLANK') !== negated ? 'TRUE' : 'FALSE', because: `the test case sets ${name} to ${fact === 'BLANK' ? 'blank' : 'a value'}` };
  }
  return { given: 'UNKNOWN', because: 'it depends on how the application behaves, which is not known before the run' };
}

const BRANCH_RELATIONS: ReadonlySet<string> = new Set(['IF', 'WHEN', 'UNLESS']);

/** Reads a line (a step, or a sentence of an expected result) into steps, expectations and conditionals. */
export function understandLine(raw: string, ctx: LineContext): LineResult {
  const line = readLine(raw);
  const clauses = splitClauses(line);
  const out: LineResult = { steps: [], expectations: [], conditionals: [], sequence: [], notes: [], issues: [], models: [] };
  let subject: Subject | undefined;
  /** Whether the last clause emitted an action (an expectation after it belongs to it: GR-04). */
  let lastWasAction = false;
  /** The clause being read, so a trailing condition can tell which expectations came from the clause just before it. */
  let currentClause = 0;

  const addStep = (s: Omit<ParsedStep, 'model'>, model: GrammarModel, guard?: number): number => {
    out.steps.push({ ...s, model, ...(guard !== undefined ? { guard } : {}) });
    out.sequence.push({ kind: 'step', index: out.steps.length - 1, clause: currentClause });
    out.models.push(model);
    // What a step says about its data is known from then on.
    if (s.value?.kind === 'class' && s.target?.name) ctx.facts.set(compactKey(s.target.name), s.value.dataClass);
    if (s.value?.kind === 'blank' && s.target?.name) ctx.facts.set(compactKey(s.target.name), 'BLANK');
    if (s.value?.kind === 'data' && s.target?.name) {
      const entry = ctx.data.find((d) => d.key === (s.value as { key: string }).key);
      if (entry?.blank) ctx.facts.set(compactKey(s.target.name), 'BLANK');
    }
    return out.steps.length - 1;
  };
  const addExpectation = (e: Omit<ParsedExpectation, 'model'>, model: GrammarModel, guard?: number): number => {
    out.expectations.push({ ...e, model, ...(guard !== undefined ? { guard } : {}) });
    out.sequence.push({ kind: 'expect', index: out.expectations.length - 1, clause: currentClause });
    out.models.push(model);
    return out.expectations.length - 1;
  };
  const modelOf = (r: CheckResult): GrammarModel =>
    r.predicate && ['ENABLED', 'DISABLED', 'EMPTY', 'CHECKED', 'UNCHECKED', 'HAS_VALUE', 'LAYOUT', 'MASKED', 'DATA_CLASS'].includes(r.predicate)
      ? 'GR-05'
      : 'GR-06';

  const check = (clause: Clause, guard?: number): number[] => {
    const r = parseCheck(line, clause.tokens, clause.original, subject);
    out.issues.push(...r.issues);
    if (r.subject) subject = r.subject;
    const model = lastWasAction && clause.relation !== 'FIRST' && clause.relation !== 'SENTENCE' ? 'GR-04' : modelOf(r);
    lastWasAction = false;
    return r.expectations.map((e) => addExpectation({ ...e }, model, guard));
  };
  const action = (clause: Clause, guard?: number): number[] => {
    const r = readAction(line, clause, ctx);
    out.issues.push(...r.issues);
    if (r.unsupported !== undefined) return [];
    lastWasAction = true;
    return r.steps.map((s) => addStep(s, guard !== undefined ? 'GR-03' : r.model, guard));
  };
  const either = (clause: Clause, guard?: number): { steps: number[]; expects: number[] } => {
    // A relative clause ("Which should be in PIM page") adds to the sentence before it; it is kept, not checked.
    if (lw(clause.tokens[0]) === 'which') {
      out.notes.push(clause.original);
      out.issues.push({
        code: 'NOT_CHECKED',
        severity: 'info',
        message: 'this clause adds to the sentence before it and is kept as written; nothing verifies it',
        original: clause.original,
        suggestion: 'If it should be checked, write it as a check of its own: Verify …',
      });
      return { steps: [], expects: [] };
    }
    const kind = kindOf(line, clause, ctx);
    // "… should be empty by clicking Reset": how it is done is an action, done first; the rest is the check.
    const byAt = clause.tokens.findIndex((t, k) => k > 0 && lw(t) === 'by' && isCommandForm(lw(clause.tokens[k + 1])));
    if (kind === 'check' && byAt > 0) {
      const how = clause.tokens.slice(byAt + 1);
      const what = clause.tokens.slice(0, byAt);
      const steps = action({ ...clause, tokens: how, original: originalOf(line, how) }, guard);
      lastWasAction = true;
      const expects = check({ ...clause, tokens: what, original: originalOf(line, what) }, guard);
      return { steps, expects };
    }
    if (kind === 'action') return { steps: action(clause, guard), expects: [] };
    if (kind === 'check') return { steps: [], expects: check(clause, guard) };
    const unsupported = kind === 'unsupported';
    out.issues.push(
      unsupported
        ? {
            code: 'UNSUPPORTED',
            severity: 'blocking',
            message: `not understood: "${originalOf(line, clause.tokens.slice(0, 1))}" is not one of the actions the engine knows, and the sentence is not a check`,
            original: clause.original,
            suggestion: 'Start the step with an action word (click, enter, select, open, …), or begin a check with Verify.',
          }
        : {
            code: 'NOT_UNDERSTOOD',
            severity: 'blocking',
            message: 'the sentence fits none of the grammar models: it is neither an action nor a check',
            original: clause.original,
            suggestion:
              ctx.mode === 'expected'
                ? 'Say what should be true on the screen, for example: An error message is displayed, or The user stays on the Login page.'
                : 'Write one action or one check per sentence, for example: Click the Save button, or Verify the Dashboard heading is displayed.',
          },
    );
    return { steps: [], expects: [] };
  };

  /** The condition of a conditional clause, with what is known about it. */
  const condition = (clause: Clause): LineConditional | undefined => {
    const r = parseCheck(line, clause.tokens, clause.original, subject);
    const first = r.expectations[0];
    if (!first) {
      out.issues.push(...r.issues, {
        code: 'NOT_UNDERSTOOD',
        severity: 'blocking',
        message: 'the condition could not be read',
        original: clause.original,
        suggestion: 'Say what is true, for example: If the password is invalid, …',
      });
      return undefined;
    }
    // "unless X" is "if not X".
    const negated = clause.keyword === 'unless' ? !first.negated : first.negated;
    const verdict = evaluate(first.condition, negated, ctx.facts);
    const target = first.condition.target?.name;
    const conditional: ParsedConditional = {
      keyword: clause.keyword ?? 'if',
      condition: first.condition,
      negated,
      original: clause.original,
      ...(target ? { fact: { subject: target, state: first.condition.expect ?? '' } } : {}),
    };
    return { conditional, ...verdict };
  };
  const addConditional = (c: LineConditional): number => {
    out.conditionals.push(c);
    if (c.given === 'UNKNOWN') {
      out.issues.push({
        code: 'UNKNOWN_BRANCH',
        severity: 'review',
        message: `"${c.conditional.original}": ${c.because}, so the expected result cannot be chosen`,
        original: c.conditional.original,
        suggestion: `Say which result is expected, for example: "If ${c.conditional.original}, <result A>; otherwise <result B>", or state the test data that decides it.`,
      });
    }
    return out.conditionals.length - 1;
  };

  let i = 0;
  while (i < clauses.length) {
    const clause = clauses[i] as Clause;
    currentClause = i;
    const initial = i === 0 || clause.relation === 'SENTENCE';
    const next = clauses[i + 1];

    if (clause.relation === 'NOTE') {
      out.notes.push(clause.original);
      out.issues.push({
        code: 'NOT_CHECKED',
        severity: 'info',
        message: 'this note is kept with the test case but is not a step or a check, so nothing verifies it',
        original: clause.original,
        suggestion: 'If it should be checked, write it as a check: Verify …',
      });
      i++;
      continue;
    }

    // GR-07, GR-08: "If / When <condition>, <result>" with an optional "otherwise".
    if (BRANCH_RELATIONS.has(clause.relation) && next && ['COMMA', 'THEN'].includes(next.relation)) {
      const model: GrammarModel = clause.keyword === 'when' || clause.keyword === 'whenever' ? 'GR-08' : 'GR-07';
      const cond = condition(clause);
      const guard = cond ? addConditional(cond) : undefined;
      let k = i + 1;
      for (; k < clauses.length; k++) {
        const c = clauses[k] as Clause;
        if (!['COMMA', 'THEN', 'AND'].includes(c.relation)) break;
        lastWasAction = false;
        const r = either(c, guard);
        for (const e of r.expects) if (out.expectations[e]) (out.expectations[e] as ParsedExpectation).model = model;
      }
      if (cond) out.models.push(model);
      i = k;
      continue;
    }

    // GR-09, GR-10: "After / Before <action>, <expected result>".
    if ((clause.relation === 'AFTER' || clause.relation === 'BEFORE') && next && ['COMMA', 'THEN'].includes(next.relation)) {
      const model: GrammarModel = clause.relation === 'AFTER' ? 'GR-09' : 'GR-10';
      const results: Clause[] = [];
      let k = i + 1;
      for (; k < clauses.length && ['COMMA', 'THEN', 'AND'].includes((clauses[k] as Clause).relation); k++) results.push(clauses[k] as Clause);
      const emitAction = (): void => {
        const r = readAction(line, clause, ctx);
        out.issues.push(...r.issues);
        for (const s of r.steps) addStep(s, model);
      };
      const emitResults = (): void => {
        for (const c of results) {
          const rr = parseCheck(line, c.tokens, c.original, subject);
          out.issues.push(...rr.issues);
          if (rr.subject) subject = rr.subject;
          for (const e of rr.expectations) addExpectation(e, model);
        }
      };
      // Before: the expected result is true before the action happens, so it is placed first.
      if (clause.relation === 'AFTER') {
        emitAction();
        emitResults();
      } else {
        emitResults();
        emitAction();
      }
      i = k;
      continue;
    }

    // GR-03, GR-07 (written backwards): a condition that follows what it governs.
    if (BRANCH_RELATIONS.has(clause.relation) && !initial) {
      const cond = condition(clause);
      const governed = lastEmitted(out);
      const paradox = cond && governed.step !== undefined ? paradoxOf(out.steps[governed.step] as ParsedStep, cond.conditional) : undefined;
      if (paradox) out.issues.push({ ...paradox, original: `${out.steps[governed.step as number]?.original} ${clause.original}` });
      else if (cond) {
        const guard = addConditional(cond);
        if (governed.step !== undefined) (out.steps[governed.step] as ParsedStep).guard = guard;
        for (const e of governed.expects) (out.expectations[e] as ParsedExpectation).guard = guard;
        out.models.push(governed.step !== undefined ? 'GR-03' : 'GR-07');
        if (governed.step !== undefined) (out.steps[governed.step] as ParsedStep).model = 'GR-03';
      }
      i++;
      continue;
    }

    if (clause.relation === 'WHILE' || clause.relation === 'UNTIL' || clause.relation === 'BECAUSE') {
      const governed = lastEmitted(out);
      const cond = condition(clause);
      const paradox = cond && governed.step !== undefined ? paradoxOf(out.steps[governed.step] as ParsedStep, cond.conditional) : undefined;
      if (paradox) out.issues.push({ ...paradox, original: `${out.steps[governed.step as number]?.original} ${clause.original}` });
      else
        out.issues.push({
          code: 'NOT_CHECKED',
          severity: 'info',
          message: `"${clause.keyword}" explains or times the step; it is kept as written and not verified`,
          original: clause.original,
        });
      i++;
      continue;
    }

    if (clause.relation === 'OTHERWISE') {
      const last = out.conditionals.length - 1;
      if (last < 0)
        out.issues.push({ code: 'NOT_UNDERSTOOD', severity: 'blocking', message: '"otherwise" has no condition before it', original: clause.original });
      else {
        const r = either(clause, undefined);
        out.issues.push({
          code: 'AMBIGUOUS',
          severity: 'review',
          message: 'an "otherwise" branch is read but has no run-time guard in this version',
          original: clause.original,
        });
        void r;
      }
      i++;
      continue;
    }

    either(clause);
    i++;
  }
  return out;
}

/** The step and expectations the last clause emitted: what a trailing condition governs. */
function lastEmitted(out: LineResult): { step?: number; expects: number[] } {
  const seq = out.sequence;
  const last = seq[seq.length - 1];
  if (!last) return { expects: [] };
  if (last.kind === 'step') return { step: last.index, expects: [] };
  // Only what the clause just before the condition said: "… and should display an error if spaces are not accepted".
  const expects: number[] = [];
  for (let k = seq.length - 1; k >= 0 && seq[k]?.kind === 'expect' && seq[k]?.clause === last.clause; k--) expects.unshift((seq[k] as { index: number }).index);
  return { expects };
}

/**
 * "Click Save while Save stays disabled": an action under a condition that makes it impossible (VD-04). The paradox is
 * reported before anything runs.
 */
function paradoxOf(step: ParsedStep, c: ParsedConditional): PartialIssue | undefined {
  const same = step.target?.name && c.condition.target?.name && compactKey(step.target.name) === compactKey(c.condition.target.name);
  const makesImpossible =
    (c.condition.type === 'ENABLED' && (c.condition.expect === 'DISABLED') !== c.negated) ||
    (c.condition.type === 'VISIBILITY' && (c.condition.expect === 'HIDDEN') !== c.negated);
  if (!same || !makesImpossible) return undefined;
  return {
    code: 'PARADOX',
    severity: 'blocking',
    message: `${step.action} on "${step.target?.name}" cannot happen while "${step.target?.name}" is ${c.condition.type === 'ENABLED' ? 'disabled' : 'hidden'}`,
    original: step.original,
    suggestion: `Say what should happen when the user tries it, as a check: Verify the '${step.target?.name}' button is disabled.`,
  };
}

export type { NounPhrase };
