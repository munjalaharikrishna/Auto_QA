import { type RawTestCase, stepsWithChecks } from '../../model/test-model.js';
import type { IrExpectation, IrStep, IrTarget, QaIr } from '../ir/schema.js';
import { parseTestData } from '../language/data-binding.js';
import { understandLine } from '../language/grammar.js';
import { nonBlankLines, splitStepLine } from '../patterns/shapes.js';

/**
 * Setup blocks (E0.16, audit U4). Testers start most cases of a sheet with the same lines: open the browser, open the application,
 * check the login page, check the tabs. Those lines are the suite's setup, not the test: they are found once per suite, and
 *
 *  - a question about a setup line is the suite's, asked once, not once per case (`Issue.block`);
 *  - a setup line that only restates the check of the line before it, and cannot be read, is set aside instead of asked about;
 *  - when the setup checks a screen that is shown only after a login (the tabs) right after the login page, and no line logs in,
 *    the case logs in there with the project's login, as the owner read these cases (gold, 4 Nov 2026).
 *
 * A setup block is only ever the leading lines that are setup by kind (opening, logging in with the project's login, checking), so a
 * data-entry line many cases share is never taken for setup. A line that takes a value from the Test Data is not setup either:
 * the same words with other data are another test (TC_LOGIN_003, a wrong password). Nothing here removes a line from a case: every
 * case still runs and checks all it says.
 */

export interface SetupBlock {
  /** The suite (sheet) it belongs to: the name a question about it is asked under. */
  suite: string;
  /** The setup lines, in the tester's words, as the steps column and the per-step checks give them (`stepsWithChecks`). */
  lines: string[];
  /** The cases that start with the block and go on with their own steps. */
  members: string[];
}

/** What a member's login is made of: the project's login case, or the usual login form when there is none. */
export interface SetupLogin {
  /** The login case it was taken from, or `undefined` for the usual form. */
  from?: string;
  username: IrTarget;
  password: IrTarget;
  submit: IrTarget;
}

/** The setup of one case, for `understandCase`. */
export interface CaseSetup {
  suite: string;
  /** How many leading lines of the case are setup lines. */
  lines: number;
  /** A member goes on past the block: its setup lines are the suite's. A case that ends inside the block tests those lines itself. */
  member: boolean;
  /** Log in where the setup checks a screen behind the login and no line logs in. */
  login?: SetupLogin;
}

/** A line as it is compared: lower case, one space between words, no full stop at the end. */
const keyOf = (line: string): string => {
  let spaced = line.toLowerCase();
  for (const blank of ['\t', '\r', '\n', ' ']) spaced = spaced.replaceAll(blank, ' ');
  let key = spaced.split(' ').filter(Boolean).join(' ');
  while (key.endsWith('.')) key = key.slice(0, -1).trimEnd();
  return key;
};

/** The lines of a case as the reader numbers them: the steps with the per-step checks after their step. */
export const caseLines = (raw: Pick<RawTestCase, 'steps' | 'stepExpected'>): string[] => nonBlankLines(stepsWithChecks(raw)).map((l) => splitStepLine(l).text);

const LOGIN_WORDS = ['login', 'log in', 'sign in', 'signin'];
const named = (t?: IrTarget): string => (t?.name ?? t?.label ?? '').toLowerCase();
const isLoginName = (t?: IrTarget): boolean => LOGIN_WORDS.some((w) => named(t).includes(w));

/**
 * Whether a line is setup by kind: the run's own setup ("Open Browser"), opening a page, a check and nothing else, or a step of the
 * project's login that takes no value from the Test Data.
 */
function isSetupLine(text: string, raw: RawTestCase): boolean {
  const result = understandLine(text, { data: parseTestData(raw.testData), facts: new Map(), mode: 'step' });
  if (result.issues.some((i) => i.setup)) return true;
  if (!result.steps.length) return true;
  return result.steps.every((s) => {
    if (s.action === 'NAVIGATE') return true;
    if (s.value?.kind === 'data' || s.value?.kind === 'literal') return false;
    if (s.action === 'ENTER_VALUE') return s.target?.ontology === 'Username' || s.target?.ontology === 'Password';
    return (s.action === 'CLICK' || s.action === 'SUBMIT' || s.action === 'LOGIN') && (s.action === 'LOGIN' || isLoginName(s.target));
  });
}

/**
 * The setup block of a suite: the longest run of leading setup lines that at least two cases share and go on past, and that at
 * least half of the cases sharing its first line share. None when the cases do not start alike.
 */
export function findSetupBlock(suite: string, cases: readonly RawTestCase[]): SetupBlock | undefined {
  const all = cases.map((raw) => ({ raw, id: raw.id ?? '', lines: caseLines(raw) }));
  const keys = all.map((c) => c.lines.map(keyOf));
  /** How many leading lines of each case are setup by kind (worked out only as far as needed). */
  const setupLength = all.map((c) => {
    let n = 0;
    while (n < c.lines.length && isSetupLine(c.lines[n] as string, c.raw)) n++;
    return n;
  });
  const sharing = (ref: number, k: number): number[] =>
    all.flatMap((_, i) => ((setupLength[i] as number) >= k && keys[i]?.slice(0, k).every((w, j) => w === keys[ref]?.[j]) ? [i] : []));

  let best: { ref: number; k: number; members: number[] } | undefined;
  for (const ref of all.keys()) {
    const base = sharing(ref, 1).length;
    for (let k = setupLength[ref] as number; k >= 1; k--) {
      const members = sharing(ref, k).filter((i) => (all[i]?.lines.length ?? 0) > k);
      if (members.length < 2 || members.length * 2 < base) continue;
      if (!best || k > best.k || (k === best.k && members.length > best.members.length)) best = { ref, k, members };
      break;
    }
  }
  if (!best) return undefined;
  return { suite, lines: all[best.ref]?.lines.slice(0, best.k) ?? [], members: best.members.map((i) => all[i]?.id ?? '') };
}

/** The setup of one case of the suite: how many of its leading lines are the block's, and whether it goes on past them. */
export function setupOf(block: SetupBlock | undefined, raw: RawTestCase, login?: SetupLogin): CaseSetup | undefined {
  if (!block) return undefined;
  const mine = caseLines(raw).map(keyOf);
  const want = block.lines.map(keyOf);
  let lines = 0;
  while (lines < want.length && lines < mine.length && mine[lines] === want[lines]) lines++;
  if (!lines) return undefined;
  const member = lines === want.length && mine.length > lines;
  return { suite: block.suite, lines, member, ...(login ? { login } : {}) };
}

/** The setup of every case of a suite, by case id: what to pass as `setup` when each is compiled. */
export function suiteSetups(suite: string, cases: readonly RawTestCase[], login: SetupLogin = DEFAULT_LOGIN): Map<string, CaseSetup> {
  const block = findSetupBlock(suite, cases);
  const out = new Map<string, CaseSetup>();
  for (const raw of cases) {
    const one = setupOf(block, raw, login);
    if (one && raw.id) out.set(raw.id, one);
  }
  return out;
}

/** The usual login form, when the project has no login case to take it from. */
export const DEFAULT_LOGIN: SetupLogin = {
  username: { ontology: 'Username', name: 'Username' },
  password: { ontology: 'Password', name: 'Password' },
  submit: { ontology: 'Button', name: 'Login' },
};

/** The login of a setup block, taken from the project's login case: the fields it fills and the button it clicks. */
export function loginOf(ir: QaIr | undefined): SetupLogin | undefined {
  if (!ir) return undefined;
  const username = ir.steps.find((s) => s.action === 'ENTER_VALUE' && s.target?.ontology === 'Username')?.target;
  const password = ir.steps.find((s) => s.action === 'ENTER_VALUE' && s.target?.ontology === 'Password')?.target;
  const submit = ir.steps.find((s) => (s.action === 'CLICK' || s.action === 'SUBMIT') && isLoginName(s.target))?.target;
  if (!username || !password || !submit) return undefined;
  return { from: ir.testCase.id, username: plain(username), password: plain(password), submit: plain(submit) };
}

/** A target as the tester named it: what the knowledge settled for the login case is settled again for each case. */
const plain = (t: IrTarget): IrTarget => ({ ontology: t.ontology, ...(t.name ? { name: t.name } : {}), ...(t.label ? { label: t.label } : {}) });

/** A check of the login page: its address, its form or its heading. */
const isLoginPageCheck = (e: IrExpectation): boolean => !e.negated && isLoginName(e.condition.target);

/** A check of something only a logged-in user sees: the application's tabs or menu, its default page, or another page's address. */
function isBehindLogin(e: IrExpectation): boolean {
  if (e.negated) return false;
  const c = e.condition;
  if (isLoginName(c.target)) return false;
  if (c.type === 'VISIBILITY' && (c.target?.ontology === 'Tab' || c.target?.ontology === 'Menu')) return true;
  if (c.type === 'STATE' && c.expect === 'DEFAULT_PAGE') return true;
  return c.type === 'URL' && c.expect !== 'UNCHANGED' && !!c.target?.name;
}

const logsIn = (s: IrStep): boolean =>
  s.action === 'LOGIN' ||
  (s.action === 'ENTER_VALUE' && s.target?.ontology === 'Password') ||
  ((s.action === 'CLICK' || s.action === 'SUBMIT') && isLoginName(s.target));

export interface LoginPoint {
  /** The step the login goes after. */
  after: IrStep;
  /** The first check that needs it: it and the checks after it at the same step move after the login. */
  first: IrExpectation;
}

/**
 * Where a case's setup lines need a login no line writes: the first check of a screen behind the login, after the login page was
 * checked or opened and before anything logged in. Only checks of setup lines count (`isSetup`).
 */
export function loginPoint(steps: readonly IrStep[], expectations: readonly IrExpectation[], isSetup: (e: IrExpectation) => boolean): LoginPoint | undefined {
  let loginPage = false;
  for (const s of steps) {
    if (logsIn(s)) return undefined;
    if (s.action === 'NAVIGATE' && isLoginName(s.target)) loginPage = true;
    for (const e of expectations) {
      if (e.afterStep !== s.id) continue;
      if (!isSetup(e)) return undefined;
      if (isLoginPageCheck(e)) loginPage = true;
      else if (loginPage && isBehindLogin(e)) return { after: s, first: e };
    }
  }
  return undefined;
}
