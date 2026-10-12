import type { IrExpectation, IrStep } from '../ir/schema.js';
import type { Issue } from '../language/types.js';

/**
 * Layer 15, the test state machine (ST-01, ST-02). A test case moves the application through states: started, on the
 * login page, username entered, login submitted, logged in, on the dashboard. The states each step is expected to leave
 * the application in are recorded in QA-IR (ST-01); the moves between them are checked against a matrix of what can
 * follow what (ST-02), so a test case that expects a login to succeed that never submitted one is stopped before it runs.
 * At run time, the state found that is not the state expected is a FAIL that shows both (E0.8).
 */

/** The lifecycle states of ST-01. An application adds its own through its knowledge base (AK-01). */
export const LIFECYCLE_STATES = [
  'APPLICATION_STARTED',
  'LOGIN_PAGE',
  'USERNAME_ENTERED',
  'PASSWORD_ENTERED',
  'LOGIN_SUBMITTED',
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'DASHBOARD',
  'ERROR_DISPLAYED',
  'LOGGED_OUT',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** What may follow each state. A state may always repeat itself. */
export const TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  // Opening the application lands on its login page, so the login form can be filled straight away.
  APPLICATION_STARTED: ['LOGIN_PAGE', 'USERNAME_ENTERED', 'PASSWORD_ENTERED', 'LOGIN_SUBMITTED'],
  LOGIN_PAGE: ['USERNAME_ENTERED', 'PASSWORD_ENTERED', 'LOGIN_SUBMITTED'],
  USERNAME_ENTERED: ['PASSWORD_ENTERED', 'LOGIN_SUBMITTED', 'LOGIN_PAGE'],
  PASSWORD_ENTERED: ['USERNAME_ENTERED', 'LOGIN_SUBMITTED', 'LOGIN_PAGE'],
  LOGIN_SUBMITTED: ['LOGIN_SUCCESS', 'LOGIN_FAILED', 'ERROR_DISPLAYED', 'DASHBOARD'],
  LOGIN_SUCCESS: ['DASHBOARD', 'LOGGED_OUT'],
  LOGIN_FAILED: ['ERROR_DISPLAYED', 'LOGIN_PAGE', 'USERNAME_ENTERED', 'PASSWORD_ENTERED', 'LOGIN_SUBMITTED'],
  DASHBOARD: ['LOGGED_OUT'],
  ERROR_DISPLAYED: ['LOGIN_PAGE', 'USERNAME_ENTERED', 'PASSWORD_ENTERED', 'LOGIN_SUBMITTED'],
  LOGGED_OUT: ['LOGIN_PAGE', 'APPLICATION_STARTED'],
};

export const canMove = (from: string, to: string): boolean => from === to || (TRANSITIONS[from as LifecycleState]?.includes(to as LifecycleState) ?? false);

/** States in which a Username or Password field is the one of the login page. After the login it is some other form's. */
const LOGIN_FORM_STATES: ReadonlySet<string> = new Set([
  'APPLICATION_STARTED',
  'LOGIN_PAGE',
  'USERNAME_ENTERED',
  'PASSWORD_ENTERED',
  'LOGIN_FAILED',
  'ERROR_DISPLAYED',
  'LOGGED_OUT',
]);

const nameOf = (s: IrStep): string => (s.target?.name ?? s.target?.label ?? '').toLowerCase();
const isLoginButton = (s: IrStep): boolean =>
  s.action === 'LOGIN' ||
  (s.action === 'CLICK' && ['login', 'log in', 'sign in', 'signin'].some((n) => nameOf(s) === n)) ||
  (s.action === 'SUBMIT' && nameOf(s).includes('login'));

/** The state a step leaves the application in, when it is one the lifecycle knows. */
export function stateAfterStep(step: IrStep, from: string | undefined): LifecycleState | undefined {
  if (step.action === 'NAVIGATE') {
    if (step.target?.name === 'Application') return 'APPLICATION_STARTED';
    if (nameOf(step).includes('login') || nameOf(step).includes('sign in')) return 'LOGIN_PAGE';
    return undefined;
  }
  if (step.action === 'LOGOUT') return 'LOGGED_OUT';
  if (isLoginButton(step)) return from === undefined || LOGIN_FORM_STATES.has(from) ? 'LOGIN_SUBMITTED' : undefined;
  const inLoginForm = from === undefined || LOGIN_FORM_STATES.has(from);
  if (step.action === 'ENTER_VALUE' && inLoginForm) {
    if (step.target?.ontology === 'Username') return 'USERNAME_ENTERED';
    if (step.target?.ontology === 'Password') return 'PASSWORD_ENTERED';
  }
  return undefined;
}

/** The state a check says the application is in. */
export function stateOfExpectation(e: IrExpectation): LifecycleState | undefined {
  const c = e.condition;
  if (c.type === 'STATE' && c.expect === 'APPLICATION_STARTED') return 'APPLICATION_STARTED';
  if (c.type === 'AUTHENTICATION') {
    if (c.expect === 'LOGGED_IN') return e.negated ? 'LOGIN_FAILED' : 'LOGIN_SUCCESS';
    if (c.expect === 'LOGGED_OUT' && !e.negated) return 'LOGGED_OUT';
  }
  if (c.type === 'URL' && !e.negated && c.expect !== 'UNCHANGED' && ['dashboard', 'home'].some((w) => (c.target?.name ?? '').toLowerCase().includes(w)))
    return 'DASHBOARD';
  if (c.type === 'VISIBILITY' && !e.negated && ['Error', 'Validation'].includes(c.target?.ontology ?? '')) return 'ERROR_DISPLAYED';
  return undefined;
}

export interface StateResult {
  /** The steps with the state each is expected to leave the application in (ST-01). */
  steps: IrStep[];
  issues: Issue[];
  /** The states the test case goes through, in order, for the decision log. */
  path: Array<{ at: string; state: LifecycleState }>;
}

/**
 * Walks the test case, step by step and check by check, and records the state after each step. A move the matrix does
 * not allow is reported as an impossible objective (VD-04), with the two states and the words behind them.
 */
export function validateStates(steps: readonly IrStep[], expectations: readonly IrExpectation[], start?: LifecycleState): StateResult {
  const out: IrStep[] = [];
  const issues: Issue[] = [];
  const path: StateResult['path'] = [];
  let state: LifecycleState | undefined = start;
  let lastStep: IrStep | undefined;

  const move = (to: LifecycleState, at: string, original: string, where: string): void => {
    if (state !== undefined && !canMove(state, to)) {
      issues.push({
        code: 'PARADOX',
        severity: 'blocking',
        where,
        original,
        message: `${to} cannot follow ${state}: ${explain(state, to)}`,
        suggestion: `Add the step that leads there (for example: ${hint(to)}), or correct what is expected.`,
      });
    }
    state = to;
    path.push({ at, state: to });
  };

  const before = expectations.filter((e) => e.afterStep === undefined);
  for (const e of before) {
    const s = stateOfExpectation(e);
    if (s && !isOrdinaryMessage(s, state)) move(s, e.id, e.clause, 'expected result');
  }
  for (const step of steps) {
    const s = stateAfterStep(step, state);
    let marked = step;
    if (s) {
      move(s, step.id, step.original, `step ${step.id.slice(1)}`);
      marked = { ...step, expectedState: s };
    }
    lastStep = step;
    out.push(marked);
    for (const e of expectations.filter((x) => x.afterStep === step.id)) {
      const es = stateOfExpectation(e);
      if (es && !isOrdinaryMessage(es, state)) move(es, e.id, e.clause, `step ${step.id.slice(1)}`);
    }
  }
  void lastStep;
  return { steps: out, issues, path };
}

/** An error shown is a state of the login only right after a login was tried; anywhere else it is just a message (a form error, a rejected value). */
const isOrdinaryMessage = (to: string, from: string | undefined): boolean =>
  to === 'ERROR_DISPLAYED' && !['LOGIN_SUBMITTED', 'LOGIN_FAILED', 'ERROR_DISPLAYED'].includes(from ?? '');

function explain(from: string, to: string): string {
  if (to === 'LOGIN_SUCCESS' || to === 'LOGIN_FAILED') return 'the login was never submitted';
  if (to === 'DASHBOARD') return 'nothing logged in first';
  if (from === 'LOGIN_SUCCESS' || from === 'DASHBOARD') return 'the user is already logged in';
  return `${from} does not lead to ${to}`;
}

function hint(to: string): string {
  if (to === 'LOGIN_SUCCESS' || to === 'LOGIN_FAILED') return "Click the 'Login' button";
  if (to === 'DASHBOARD') return 'log in first';
  return 'the step that moves the application there';
}
