import type { StepRecord } from '../engine/execute/executor.js';
import type { Chain } from '../engine/execute/planner.js';
import { type CompileOptions, compileCase } from '../engine/index.js';
import type { IrExpectation } from '../engine/ir/schema.js';
import { labelKey } from '../engine/knowledge/labels.js';
import { type Evaluation, evaluateExpectation } from '../engine/verdict/evaluate.js';
import type { RawTestCase } from '../model/test-model.js';
import { stepsWithChecks } from '../model/test-model.js';
import { parseTestCase } from '../parser/index.js';

/**
 * The guided walkthrough (E0.14b, PD-13): the rules a walkthrough job follows, kept apart from the job runner so they can be tested
 * without a browser. Which steps change data and are asked about first; how a check a person adds is written as a sentence of the
 * test case, placed, and accepted only when the engine reads that sentence back as exactly that check; and how a check is tried on the
 * screen the person is looking at.
 */

/** The checks a walkthrough offers on day one: the ones the verdict engine judges (PD-13). Text is always matched as "contains". */
export const CHECK_KINDS = ['visible', 'not-visible', 'text-contains', 'value', 'enabled', 'disabled', 'url-contains'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface WalkCheck {
  kind: CheckKind;
  /** The element, as the screen names it; none for a URL check. */
  target?: { role: string; name: string };
  /** The text, value or part of the address. */
  expected?: string;
  /** After this step of the run (`S3`); none for the end of the test case. */
  afterStep?: string;
}

/** The word a test case uses for an element of this role. */
const ROLE_WORD: Readonly<Record<string, string>> = {
  textbox: 'field',
  searchbox: 'field',
  spinbutton: 'field',
  combobox: 'dropdown',
  listbox: 'dropdown',
  button: 'button',
  link: 'link',
  heading: 'heading',
  checkbox: 'checkbox',
  radio: 'radio button',
  alert: 'message',
  status: 'message',
  img: 'image',
};

const roleWord = (role: string): string => ROLE_WORD[role] ?? 'element';

/** What a check is, as the problem with it, or nothing when it can be written. */
export function checkProblem(c: WalkCheck): string | undefined {
  if (!CHECK_KINDS.includes(c.kind)) return `"${c.kind}" is not a check the walkthrough offers.`;
  if (c.kind === 'url-contains') return c.expected?.trim() ? undefined : 'Say what the address should contain.';
  if (!c.target?.name.trim()) return 'Pick the element the check is about.';
  if ((c.kind === 'text-contains' || c.kind === 'value') && !c.expected?.trim()) return 'Say what it should show.';
  for (const s of [c.target.name, c.expected ?? '']) if (s.includes('"')) return 'A name or a value with a double quote cannot be written as a check yet.';
  if (c.target.name.length > 120 || (c.expected ?? '').length > 200) return 'The name or the value is too long for a check.';
  return undefined;
}

/** The check as the sentence a tester would write, in the words the engine reads (probed against the compiler, see the tests). */
export function checkSentence(c: WalkCheck): string {
  const name = c.target?.name.trim() ?? '';
  const word = roleWord(c.target?.role ?? '');
  const expected = c.expected?.trim() ?? '';
  switch (c.kind) {
    case 'visible':
      return `The ${name} ${word} is displayed`;
    case 'not-visible':
      return `The ${name} ${word} is not displayed`;
    case 'text-contains':
      return `The "${name}" ${word} contains "${expected}"`;
    case 'value':
      return `The "${name}" field has the value "${expected}"`;
    case 'enabled':
      return `The ${name} ${word} is enabled`;
    case 'disabled':
      return `The ${name} ${word} is disabled`;
    case 'url-contains':
      return `The page URL contains "${expected}"`;
  }
}

/** What the engine must read the sentence as: the condition, whether it is negated, what it expects, and of which element. */
function intended(c: WalkCheck): { type: string; negated: boolean; expect: string; name?: string } {
  const name = c.target?.name.trim();
  const expected = c.expected?.trim() ?? '';
  switch (c.kind) {
    case 'visible':
      return { type: 'VISIBILITY', negated: false, expect: 'VISIBLE', ...(name ? { name } : {}) };
    case 'not-visible':
      return { type: 'VISIBILITY', negated: true, expect: 'VISIBLE', ...(name ? { name } : {}) };
    case 'text-contains':
      return { type: 'TEXT', negated: false, expect: expected, ...(name ? { name } : {}) };
    case 'value':
      return { type: 'VALUE', negated: false, expect: expected, ...(name ? { name } : {}) };
    case 'enabled':
      return { type: 'ENABLED', negated: false, expect: 'ENABLED', ...(name ? { name } : {}) };
    case 'disabled':
      return { type: 'ENABLED', negated: false, expect: 'DISABLED', ...(name ? { name } : {}) };
    case 'url-contains':
      return { type: 'URL', negated: false, expect: expected };
  }
}

/** The expectation is the check that was meant. */
export function readsAs(e: IrExpectation, c: WalkCheck): boolean {
  const want = intended(c);
  if (e.condition.type !== want.type || e.negated !== want.negated) return false;
  if ((e.condition.expect ?? '') !== want.expect) return false;
  return want.name === undefined || labelKey(e.condition.target?.name ?? '') === labelKey(want.name);
}

/**
 * The test case with the check added: after the step it belongs to, as a "Verify …" step, or at the end of the expected result. The
 * steps are written as the parser reads them (each step's own expected result folded in as a "Verify …" step), so `S3` of the run is
 * line 3 of the steps.
 */
export function placeCheck(raw: RawTestCase, sentence: string, afterStep?: string): RawTestCase {
  if (!afterStep) {
    const expected = raw.expected?.trim() ? `${raw.expected.trim()}\n${sentence}` : sentence;
    return { ...raw, expected };
  }
  const n = Number(afterStep.slice(1));
  const lines = foldedLines(raw);
  if (!Number.isInteger(n) || n < 1 || n > lines.length) throw new Error(`There is no step ${afterStep} to put the check after.`);
  lines.splice(n, 0, `Verify ${sentence}`);
  const { stepExpected: _folded, ...rest } = raw;
  return { ...rest, steps: lines.map((l, i) => `${i + 1}. ${l}`).join('\n') };
}

export type Placed = { ok: true; raw: RawTestCase; sentence: string; expectation: IrExpectation } | { ok: false; sentence: string; why: string };

/**
 * Adds the check and reads the test case again: the check is kept only when the engine reads its sentence as exactly that check, after
 * the step it was meant for. A sentence it reads otherwise is refused, with what it was read as, so a check never means something
 * other than what the person chose.
 */
export async function addCheck(raw: RawTestCase, c: WalkCheck, options: CompileOptions = {}): Promise<Placed> {
  const problem = checkProblem(c);
  const sentence = problem ? '' : checkSentence(c);
  if (problem) return { ok: false, sentence, why: problem };
  let next: RawTestCase;
  try {
    next = placeCheck(raw, sentence, c.afterStep);
  } catch (e) {
    return { ok: false, sentence, why: (e as Error).message };
  }
  const compiled = await compileCase(next, options);
  const all = compiled.ir?.expectations ?? [];
  const mine = all.filter((e) => e.clause.includes(sentence));
  const exact = mine.find((e) => readsAs(e, c));
  if (!exact) {
    const read = mine[0];
    return {
      ok: false,
      sentence,
      why: read
        ? `The engine reads "${sentence}" as a ${read.negated ? 'negated ' : ''}${read.condition.type} check${read.condition.target?.name ? ` of "${read.condition.target.name}"` : ''}, not the check you chose. Write it in the step instead.`
        : `The engine does not read "${sentence}" as a check${compiled.issues[0] ? ` (${compiled.issues[0].message})` : ''}.`,
    };
  }
  // A "Verify" step is judged on the page the step before it left: that must be the step the person was on.
  if (c.afterStep && exact.afterStep !== c.afterStep)
    return { ok: false, sentence, why: `The check would be judged after ${exact.afterStep ?? 'the last step'}, not after ${c.afterStep}.` };
  return { ok: true, raw: next, sentence, expectation: exact };
}

/** The steps as numbered lines without their numbers, each step's own expected result folded in: line n is step `Sn` of the run. */
function foldedLines(raw: RawTestCase): string[] {
  return stepsWithChecks(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const dot = l.indexOf('. ');
      return dot > 0 && [...l.slice(0, dot)].every((ch) => ch >= '0' && ch <= '9') ? l.slice(dot + 2) : l;
    });
}

/** The test case with the words of one step changed: the same step, new words. */
export function editStep(raw: RawTestCase, step: string, text: string): RawTestCase {
  const words = text.replace(/\s+/g, ' ').trim();
  if (!words) throw new Error('The step needs words.');
  if (words.length > 300) throw new Error('The step is longer than 300 characters.');
  const lines = foldedLines(raw);
  const n = Number(step.slice(1));
  if (!Number.isInteger(n) || n < 1 || n > lines.length) throw new Error(`There is no step ${step}.`);
  lines[n - 1] = words;
  const { stepExpected: _folded, ...rest } = raw;
  return { ...rest, steps: lines.map((l, i) => `${i + 1}. ${l}`).join('\n') };
}

/**
 * What a person did in the browser during a walkthrough, as the recorder saw it (E0.14c): the kind of action, the element as the screen
 * names it, and what was typed or chosen.
 */
export interface Recorded {
  kind: 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'choose' | 'press' | 'navigate';
  element?: { role: string; name: string };
  /** The text typed, the option chosen, the key pressed or the address opened. */
  value?: string;
  /** Typed in a password field: the value is only compared with the project's password, never written. */
  secret?: boolean;
}

/** The word a recorded click uses for an element of this role: the ones both parsers read (probed, see the tests). */
const CLICK_WORD: Readonly<Record<string, string>> = { button: 'button', link: 'link', tab: 'tab' };

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The recorded action as the sentence a tester would write, in words both the old parser (which runs the case today) and the new engine
 * read. A value that is the project's login is written as "the valid username" or "the valid password", so it comes from the project
 * and is the same in every test case; a password is never written.
 */
export function recordedSentence(r: Recorded, login: { username?: string; password?: string }): { sentence: string; note?: string } | { why: string } {
  if (r.kind === 'navigate') return r.value?.trim() ? { sentence: `Navigate to ${r.value.trim()}` } : { why: 'The page has no address.' };
  if (r.kind === 'press')
    return r.value === 'Enter' || r.value === 'Escape' ? { sentence: `Press ${r.value}` } : { why: `The ${r.value} key is not recorded.` };
  const name = oneLine(r.element?.name ?? '');
  if (!name) return { why: 'The element has no name a test case could use: no label, text or placeholder.' };
  if (name.includes('"')) return { why: `"${name}" has a double quote, which a step cannot hold yet.` };
  if (name.length > 120) return { why: 'The name of the element is too long for a step.' };
  const value = r.value ?? '';
  switch (r.kind) {
    case 'click': {
      const word = CLICK_WORD[r.element?.role ?? ''];
      return word
        ? { sentence: `Click the "${name}" ${word}` }
        : { sentence: `Click the "${name}" button`, note: `a ${r.element?.role ?? 'element'} is written as a button` };
    }
    case 'fill':
      if (r.secret)
        return value === login.password
          ? { sentence: `Enter the valid password in the "${name}" field` }
          : {
              sentence: `Enter an invalid password in the "${name}" field`,
              note: "the password typed is not the project's, so the step uses a made-up wrong one",
            };
      if (login.username && value === login.username) return { sentence: `Enter the valid username in the "${name}" field` };
      if (!value) return { why: `Emptying the "${name}" field is not recorded yet.` };
      if (value.includes('"') || value.includes('\n')) return { why: 'A value with a double quote or a line break cannot be written in a step yet.' };
      if (value.length > 200) return { why: 'The value is too long for a step.' };
      return { sentence: `Enter "${value}" in the "${name}" field` };
    case 'select':
      if (!value.trim() || value.includes('"')) return { why: 'The option chosen has no text a step can hold.' };
      return { sentence: `Select "${oneLine(value)}" from the "${name}" dropdown` };
    case 'check':
      return { sentence: `Check the "${name}" checkbox` };
    case 'uncheck':
      return { sentence: `Uncheck the "${name}" checkbox` };
    case 'choose':
      return { sentence: `Select the "${name}" radio button` };
  }
}

/** What each recorded kind must be read as: by the new engine, and by the old parser that runs the case. */
const READ_AS: Readonly<Record<Recorded['kind'], { engine: string; parser: string }>> = {
  click: { engine: 'CLICK', parser: 'click' },
  fill: { engine: 'ENTER_VALUE', parser: 'fill' },
  select: { engine: 'SELECT', parser: 'select' },
  check: { engine: 'CHECK', parser: 'check' },
  uncheck: { engine: 'UNCHECK', parser: 'uncheck' },
  choose: { engine: 'SELECT', parser: 'check' },
  press: { engine: 'PRESS', parser: 'press' },
  navigate: { engine: 'NAVIGATE', parser: 'navigate' },
};

/**
 * Reads the sentence back as a step of its own, with the project's rules, by both readers: it is kept only when each reads it as the
 * action that was done on the element that was used. The problem, or nothing when it reads right.
 */
export async function readsBack(sentence: string, r: Recorded, options: CompileOptions = {}): Promise<string | undefined> {
  const raw: RawTestCase = { id: 'RECORDED', title: 'recorded', steps: `1. ${sentence}`, expected: 'The page URL contains "/"' };
  const want = READ_AS[r.kind];
  const name = r.element?.name ? labelKey(oneLine(r.element.name)) : undefined;
  const compiled = await compileCase(raw, options);
  const step = compiled.ir?.steps.find((s) => s.id === 'S1');
  if (!step) return `the engine does not read "${sentence}"${compiled.issues[0] ? ` (${compiled.issues[0].message})` : ''}`;
  if (step.action !== want.engine || (name && labelKey(step.target?.name ?? '') !== name))
    return `the engine reads "${sentence}" as ${step.action}${step.target?.name ? ` "${step.target.name}"` : ''}, not what was done`;
  const old = parseTestCase(raw, options.config).steps[0];
  if (!old || old.action !== want.parser || (name && labelKey(old.target ?? '') !== name))
    return `a test run would read "${sentence}" as ${old?.action ?? 'nothing'}${old?.target ? ` "${old.target}"` : ''}, not what was done`;
  return undefined;
}

/**
 * What a person asked for in a walkthrough, kept until it is saved: a check added, the words of a step changed, or a step recorded in the
 * browser, after a step of the run or in place of a step the person did by hand (E0.14c).
 */
export type Pending =
  | { kind: 'check'; check: WalkCheck; sentence: string }
  | { kind: 'edit'; step: string; text: string }
  | { kind: 'recorded'; sentence: string; afterStep?: string; replaces?: string /** The person said it is a step (E0.14c). */; confirmed?: boolean };

/**
 * The test case with everything the person asked for. Each step of the run keeps its line, or takes its new words, or the steps recorded
 * in its place; after it come, in the order they were made, the checks and the recorded steps of that pause. The checks for the end go
 * to the expected result. Line n of the steps is step `Sn` of the run, so every step number given refers to the case as it was.
 * The steps in `drop` are left out: steps the walkthrough never ran, which the person chose to have the recorded steps replace (E0.14c).
 */
export function applyPending(raw: RawTestCase, pending: readonly Pending[], drop: readonly string[] = []): RawTestCase {
  const lines = foldedLines(raw);
  const at = (p: Pending): string | undefined => (p.kind === 'edit' ? p.step : p.kind === 'recorded' ? (p.replaces ?? p.afterStep) : p.check.afterStep);
  for (const p of pending) {
    const step = at(p);
    const n = step ? Number(step.slice(1)) : 1;
    if (!Number.isInteger(n) || n < 1 || n > lines.length) throw new Error(`There is no step ${step}.`);
  }
  const end = pending.flatMap((p) => (p.kind === 'check' && !p.check.afterStep ? [p.sentence] : []));
  const withEnd = (r: RawTestCase): RawTestCase => (end.length ? { ...r, expected: [r.expected?.trim(), ...end].filter(Boolean).join('\n') } : r);
  if (!pending.some((p) => at(p)) && !drop.length) return withEnd(raw);
  const out: string[] = [];
  lines.forEach((line, i) => {
    const step = `S${i + 1}`;
    const instead = pending.flatMap((p) => (p.kind === 'recorded' && p.replaces === step ? [p.sentence] : []));
    const edit = pending.filter((p): p is Extract<Pending, { kind: 'edit' }> => p.kind === 'edit' && p.step === step).at(-1);
    if (instead.length) out.push(...instead);
    else if (!drop.includes(step)) out.push(edit ? oneLine(edit.text) : line);
    for (const p of pending) {
      if (p.kind === 'check' && p.check.afterStep === step) out.push(`Verify ${p.sentence}`);
      else if (p.kind === 'recorded' && p.afterStep === step) out.push(p.sentence);
    }
  });
  const { stepExpected: _folded, ...rest } = raw;
  return withEnd({ ...rest, steps: out.map((l, i) => `${i + 1}. ${l}`).join('\n') });
}

/**
 * The test case with everything the person asked for (`applyPending`). Read again as a whole, every check must still read as the check
 * that was chosen; otherwise nothing is saved and the reason is given.
 */
export async function finalCase(
  raw: RawTestCase,
  pending: readonly Pending[],
  options: CompileOptions = {},
  drop: readonly string[] = [],
): Promise<{ ok: true; raw: RawTestCase } | { ok: false; why: string }> {
  let next = raw;
  try {
    next = applyPending(raw, pending, drop);
    if (!foldedLines(next).length) return { ok: false, why: 'The test case would have no steps left.' };
    const checks = pending.filter((p): p is Extract<Pending, { kind: 'check' }> => p.kind === 'check');
    const compiled = await compileCase(next, options);
    for (const p of checks) {
      const read = (compiled.ir?.expectations ?? []).filter((e) => e.clause.includes(p.sentence));
      if (!read.some((e) => readsAs(e, p.check)))
        return { ok: false, why: `With the other changes, "${p.sentence}" is no longer read as the check that was chosen.` };
    }
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
  return { ok: true, raw: next };
}

/**
 * The check tried on the screen the person is looking at: the expectation judged on the page the step left. A walkthrough shows this
 * before the check is kept, so the person sees whether it holds now. It is a preview, never a verdict.
 */
export function tryOnScreen(expectation: IrExpectation, record: StepRecord): Evaluation | undefined {
  if (!record.after) return undefined;
  return evaluateExpectation(
    { ...expectation, afterStep: record.step },
    { steps: [record], stepOf: new Map([[expectation.id, record.step]]), seen: [record.after], clause: expectation.clause },
  );
}

/** Words on a control that say a click on it keeps, sends or removes something. */
const CHANGING_WORDS: ReadonlySet<string> = new Set([
  'save',
  'submit',
  'delete',
  'remove',
  'update',
  'create',
  'confirm',
  'apply',
  'approve',
  'reject',
  'send',
  'post',
  'publish',
  'register',
  'upload',
  'import',
  'pay',
  'purchase',
  'checkout',
  'transfer',
  'assign',
  'archive',
  'ok',
  'yes',
  'terminate',
  'reset',
]);

/** Actions that change data whatever they act on. */
const CHANGING_ACTIONS: ReadonlySet<string> = new Set(['SUBMIT', 'DELETE', 'REMOVE', 'SAVE', 'UPLOAD', 'DROP']);

/**
 * Will this step change data? A walkthrough asks before such a step (and refuses it on production unless the project allows it). When in
 * doubt it says yes: asking once too often is cheaper than saving a record nobody meant to save.
 */
export function changesData(chain: Pick<Chain, 'action' | 'target' | 'original' | 'value'>): boolean {
  if (CHANGING_ACTIONS.has(chain.action)) return true;
  if (chain.action === 'PRESS') return (chain.value ?? '').toLowerCase() === 'enter';
  if (chain.action !== 'CLICK') return false;
  return wordsOf(`${chain.target?.name ?? ''} ${chain.target?.label ?? ''} ${chain.original}`).some((w) => CHANGING_WORDS.has(w));
}

function wordsOf(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text.toLowerCase()) {
    if (ch.toLowerCase() !== ch.toUpperCase() || (ch >= '0' && ch <= '9')) current += ch;
    else if (current) {
      out.push(current);
      current = '';
    }
  }
  if (current) out.push(current);
  return out;
}
