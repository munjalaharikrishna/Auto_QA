import type { IrExpectation, IrStep, IrTarget } from '../ir/schema.js';

/**
 * Layer 13, the context engine (CX-01 to CX-10). At every step the test case "knows" something: what it did last, which
 * page it is on, which form it filled, who is logged in. The context is built by walking the steps in order, and it is
 * what a phrase like "click it", "the same field" or "the entered value" is resolved against. It is built from QA-IR
 * alone, before the run, so it holds what the test case says will be true; the run compares it with what is.
 */

export interface EnteredValue {
  step: string;
  target: IrTarget;
  /** `$data.name`, or the literal. */
  value: string;
}

export interface TestContext {
  /** CX-08: the test, and the step this context is for. */
  testId: string;
  step: string;
  /** CX-01: the step before. */
  previousStep?: IrStep;
  /** CX-02: what the step before acted on. */
  previousTarget?: IrTarget;
  /** CX-03: the last value entered. */
  previousValue?: string;
  /** CX-04: the page the test case is on, by name. */
  page?: string;
  /** CX-05: the form being filled: where the last field entered says it is. */
  form?: string;
  /** CX-06: a dialog that is open. */
  modal?: string;
  /** CX-07: who is logged in, by the name of the test data that logged them in. */
  user?: string;
  /** CX-09: values saved during the test case: the data keys the steps have used. */
  variables: string[];
  /** CX-10: logged in or not, as far as the test case says. */
  authentication: { loggedIn: boolean };
  /** Everything entered so far, in order: what "the entered data" means. */
  entered: EnteredValue[];
}

const LOGIN_NAMES = ['login', 'log in', 'sign in', 'signin'];
const isLoginTarget = (t?: IrTarget): boolean => LOGIN_NAMES.some((n) => (t?.name ?? t?.label ?? '').toLowerCase().includes(n));
const ENTERS: ReadonlySet<string> = new Set(['ENTER_VALUE', 'SELECT', 'UPLOAD', 'CHECK', 'UNCHECK']);

/** The value a step holds, when it enters one. */
const heldValue = (s: IrStep): string | undefined => (ENTERS.has(s.action) ? s.value : undefined);

/**
 * The context before each step, by step id. The context of a step does not include the step itself: it is what the
 * step is written against. `before` carries what was true before the first step (a precondition such as "logged in").
 */
export function buildContexts(
  testId: string,
  steps: readonly IrStep[],
  expectations: readonly IrExpectation[],
  before: { loggedIn?: boolean; user?: string } = {},
): Map<string, TestContext> {
  const out = new Map<string, TestContext>();
  const entered: EnteredValue[] = [];
  const variables: string[] = [];
  let page: string | undefined;
  let form: string | undefined;
  let modal: string | undefined;
  let user = before.user;
  let loggedIn = before.loggedIn ?? false;
  let previous: IrStep | undefined;
  let previousTarget: IrTarget | undefined;
  let previousValue: string | undefined;

  for (const step of steps) {
    out.set(step.id, {
      testId,
      step: step.id,
      ...(previous ? { previousStep: previous } : {}),
      ...(previousTarget ? { previousTarget } : {}),
      ...(previousValue !== undefined ? { previousValue } : {}),
      ...(page ? { page } : {}),
      ...(form ? { form } : {}),
      ...(modal ? { modal } : {}),
      ...(user ? { user } : {}),
      variables: [...variables],
      authentication: { loggedIn },
      entered: [...entered],
    });

    // What this step leaves behind for the next.
    previous = step;
    if (step.target) previousTarget = step.target;
    if (step.action === 'NAVIGATE' && step.target?.name) {
      page = step.target.name;
      form = undefined;
    }
    const value = heldValue(step);
    if (value !== undefined && step.target) {
      previousValue = value;
      entered.push({ step: step.id, target: step.target, value });
      if (step.target.within) form = step.target.within;
      if (value.startsWith('$data.') && !variables.includes(value.slice(6))) variables.push(value.slice(6));
      if (step.target.ontology === 'Username' && value.startsWith('$data.')) user = value.slice(6);
    }
    if (step.target?.ontology === 'Modal')
      modal = step.action === 'CLOSE' || step.action === 'CANCEL' ? undefined : (step.target.name ?? step.target.label ?? 'dialog');
    if (step.action === 'LOGOUT') loggedIn = false;
    if (step.action === 'LOGIN' || (step.action === 'CLICK' && isLoginTarget(step.target))) loggedIn = false; // not known until the checks say so
    for (const e of expectations) {
      if (e.afterStep !== step.id) continue;
      if (e.condition.type === 'AUTHENTICATION' && e.condition.expect === 'LOGGED_IN') loggedIn = !e.negated;
      if (e.condition.type === 'URL' && e.condition.target?.name && !e.negated && e.condition.expect !== 'UNCHANGED') {
        page = e.condition.target.name;
        form = undefined;
      }
    }
  }
  return out;
}
