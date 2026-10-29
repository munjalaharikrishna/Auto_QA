import type { StepRecord } from '../execute/executor.js';
import type { Observation, ObservedContainer, ObservedElement } from '../execute/observe.js';
import { containerRef, matchContainers } from '../ir/container.js';
import type { IrCondition, IrExpectation, IrTarget } from '../ir/schema.js';
import { pageIdentityOf } from '../locate/page-identity.js';
import { compactKey } from '../text/compound.js';
import { tokenize } from '../text/index.js';

/**
 * Layers 41 to 44: the assertion engine (EX-06), evidence freshness (EX-07) and the vacuous assertion guard (EX-08).
 * An expectation of the QA-IR is a condition. It is judged on the page a step leaves, against what the page showed
 * before that step. The result is one of three: `proven` (fresh evidence says it holds), `disproven` (fresh evidence says
 * it does not) or `unproven` (the evidence does not decide it). Nothing here turns a doubt into a PASS or a FAIL.
 */

export type Result = 'proven' | 'disproven' | 'unproven';

/** Why an expectation is unproven, so that a verdict and a review card can say it. */
export type Doubt = 'STALE' | 'VACUOUS' | 'NOT_OBSERVABLE' | 'NOT_FOUND' | 'NO_PAGE' | 'UNRESOLVED' | 'AMBIGUOUS';

export interface Evaluation {
  expectation: string;
  /** The tester's words. */
  clause: string;
  result: Result;
  doubt?: Doubt;
  /** What was expected, in words. */
  expected: string;
  /** What the page showed, in words. */
  actual: string;
  /** In plain words, why the result is what it is. */
  why: string;
  /** The step whose page the expectation was judged on. */
  step?: string;
  /** The evidence was produced by that step and not already on the page before it (EX-07). */
  fresh: boolean;
}

export interface JudgeContext {
  /** The records of the steps that ran, in order. */
  steps: readonly StepRecord[];
  /** The step each expectation is judged on, from the plan. */
  stepOf: ReadonlyMap<string, string | undefined>;
  /** Every page the run saw: what could have been on a page, so that "not shown" can be told from "never could be". */
  seen: readonly Observation[];
  /** What the tester said the run is about (the clause of a failure case: "login fails"). */
  clause: string;
  /** The address of each page the case names, by name: "the Login page" is where the run opened it. */
  pages?: Readonly<Record<string, string | null | undefined>>;
  /** The values of the run by data key: what a check that names a value ("$data.First_Name") compares with. A secret is not a string here. */
  values?: Readonly<Record<string, { value: unknown }>>;
}

const ROLES: Record<string, readonly string[]> = {
  Button: ['button'],
  Link: ['link'],
  Heading: ['heading'],
  Field: ['textbox', 'searchbox', 'spinbutton', 'combobox'],
  Username: ['textbox', 'searchbox'],
  Password: ['textbox'],
  Dropdown: ['combobox', 'listbox'],
  Checkbox: ['checkbox'],
  'Radio button': ['radio'],
  Message: ['alert', 'status', 'alertdialog', 'log'],
  Error: ['alert', 'status'],
  Modal: ['dialog', 'alertdialog'],
  Row: ['row'],
  Table: ['table', 'grid'],
};

const wordsOf = (text: string): string[] =>
  tokenize(text)
    .filter((t) => t.kind === 'WORD' || t.kind === 'NUMBER')
    .map((t) => t.text.toLowerCase());
const squash = (text: string): string => wordsOf(text).join(' ');

/** The wanted words are in the text as whole words, in order: "9.99" is not in "29.99", and "cart" is not in "cartoon". */
const holdsWords = (text: string, wanted: string): boolean => {
  const w = squash(wanted);
  return w !== '' && ` ${squash(text)} `.includes(` ${w} `);
};

/** Words that carry no meaning of their own when two sentences are compared. */
const FILLER = new Set(['a', 'an', 'the', 'is', 'are', 'be', 'to', 'of', 'should', 'shown', 'show', 'displayed', 'message', 'error', 'please']);
const meaningOf = (text: string): string[] => wordsOf(text).filter((w) => !FILLER.has(w));

/** The shown text says what the wanted text says: every word of meaning in the wanted text is in it. */
export const saysTheSame = (shown: string, wanted: string): boolean => {
  const have = new Set(meaningOf(shown));
  const need = meaningOf(wanted);
  return need.length > 0 && need.every((w) => have.has(w));
};

const nameMatches = (element: ObservedElement, name: string): boolean => {
  const a = squash(element.name);
  const b = squash(name);
  return b.length > 0 && (a === b || a.includes(b));
};

/** The elements of the page that the target of a condition names. */
export function elementsFor(page: Observation, target: IrTarget | undefined): ObservedElement[] {
  if (!target) return [];
  const roles = ROLES[target.ontology ?? ''];
  const name = target.name ?? target.label ?? '';
  return page.elements.filter((e) => (roles ? roles.includes(e.role) : true) && (name ? nameMatches(e, name) : true));
}

/** The message was on the page before the step: it is not evidence that the step produced it (EX-07). */
const wasThere = (before: Observation | undefined, message: string): boolean =>
  !!before && (before.messages.includes(message) || before.fieldErrors.some((f) => f.message === message));
const describeTarget = (t?: IrTarget): string => `${t?.ontology && t.ontology !== 'Element' ? `${t.ontology} ` : ''}"${t?.name ?? t?.label ?? 'the element'}"`;

interface Pages {
  before?: Observation;
  after?: Observation;
  step?: string;
  /** What each native pop-up (alert, confirm, prompt) of the step said, as the session wrote it. */
  dialogs?: string[];
}

function pagesFor(exp: IrExpectation, ctx: JudgeContext): Pages {
  const stepId = ctx.stepOf.get(exp.id);
  const at = stepId ? ctx.steps.find((s) => s.step === stepId) : ctx.steps[0];
  if (!stepId) return { ...(ctx.steps[0]?.before ? { before: ctx.steps[0].before, after: ctx.steps[0].before } : {}) };
  return {
    ...(at?.before ? { before: at.before } : {}),
    ...(at?.after ? { after: at.after } : {}),
    ...(at?.dialogs?.length ? { dialogs: at.dialogs } : {}),
    step: stepId,
  };
}

const unproven = (exp: IrExpectation, doubt: Doubt, expected: string, actual: string, why: string, step?: string): Evaluation => ({
  expectation: exp.id,
  clause: exp.clause,
  result: 'unproven',
  doubt,
  expected,
  actual,
  why,
  ...(step ? { step } : {}),
  fresh: false,
});

const settled = (exp: IrExpectation, holds: boolean, expected: string, actual: string, why: string, fresh: boolean, step?: string): Evaluation => ({
  expectation: exp.id,
  clause: exp.clause,
  result: holds ? 'proven' : 'disproven',
  expected,
  actual,
  why,
  ...(step ? { step } : {}),
  fresh,
});

/** Messages are only evidence when this step produced them (EX-07). */
/** What a native pop-up said: the session writes `alert "User Name not given!"`. */
export function dialogTextOf(dialog: string): string | undefined {
  const open = dialog.indexOf('"');
  const close = dialog.lastIndexOf('"');
  return open >= 0 && close > open ? dialog.slice(open + 1, close) : undefined;
}

const saidBy = (dialogs: readonly string[] | undefined): string[] => (dialogs ?? []).map(dialogTextOf).filter((t): t is string => !!t);

/**
 * The messages the user was shown: those on the page, and what a pop-up said. A pop-up came during the step, so it cannot be a
 * message that was already there (EX-07): it is always fresh. An application that answers a blank field with an alert has shown a message.
 */
function messageEvidence(
  after: Observation,
  before: Observation | undefined,
  wanted: string | undefined,
  dialogs?: readonly string[],
): { shown: string[]; fresh: string[]; stale: string[]; said: string[] } {
  const said = saidBy(dialogs);
  const all = [...after.messages, ...after.fieldErrors.map((f) => f.message), ...said];
  const shown = wanted ? all.filter((m) => saysTheSame(m, wanted)) : all;
  const popup = (m: string): boolean => said.includes(m);
  return { shown, fresh: shown.filter((m) => popup(m) || !wasThere(before, m)), stale: shown.filter((m) => !popup(m) && wasThere(before, m)), said };
}

const quote = (xs: readonly string[]): string => (xs.length ? xs.map((x) => `"${x}"`).join(', ') : 'nothing');

const pathOf = (url: string): string => {
  try {
    const p = new URL(url, 'http://x').pathname;
    return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  } catch {
    return url;
  }
};

/** The path of the page a name stands for, when the case or the run knows where that page is. */
function routeOf(name: string, pages: JudgeContext['pages']): string | undefined {
  const want = compactKey(name);
  for (const [page, where] of Object.entries(pages ?? {})) if (where && compactKey(page) === want) return pathOf(where);
  return undefined;
}

/**
 * A check that names a card, a list item or a section ("on the Backpack card") is judged on that container and nothing else on the page
 * (UI-07). When no container has that name, the check cannot be judged: it is not a reason to look at the whole page, where a "not
 * shown" would hold and a "shown" might be true of another card. When two containers have it, the engine does not pick one.
 * An area word (section, panel) with no container of that name keeps the page-wide reading, as before: many pages show a section that
 * no markup names.
 */
function scoped(
  exp: IrExpectation,
  c: IrCondition,
  p: Pages & { after: Observation },
  expected: string,
): { pages: Pages & { after: Observation } } | { unproven: Evaluation } {
  const ref = containerRef(c.target?.within);
  if (!ref) return { pages: p };
  const view = (o: Observation, inside: ObservedContainer): Observation => ({
    ...o,
    lines: inside.lines,
    elements: o.elements.filter((e) => e.inside?.includes(inside.name)),
    messages: o.messages.filter((m) => inside.lines.some((l) => squash(l).includes(squash(m)))),
    fieldErrors: o.fieldErrors.filter((f) => inside.lines.some((l) => squash(l).includes(squash(f.message)))),
  });
  const hits = matchContainers(ref, p.after.containers ?? []);
  if (hits.length === 0) {
    if (!ref.repeated) return { pages: p };
    return {
      unproven: unproven(
        exp,
        'NOT_FOUND',
        expected,
        `there is no ${ref.noun} named "${ref.text}" on the page`,
        `the check is about the ${ref.noun} "${ref.text}", and it is not on the page, so nothing in it can be judged`,
        p.step,
      ),
    };
  }
  if (hits.length > 1)
    return {
      unproven: unproven(
        exp,
        'AMBIGUOUS',
        expected,
        `${hits.length} containers are named "${ref.text}": ${hits.map((h) => `"${h.name}"`).join(' and ')}`,
        `more than one ${ref.noun} has that name, so the engine does not pick one to judge the check on`,
        p.step,
      ),
    };
  const inside = hits[0] as ObservedContainer;
  const was = p.before ? matchContainers(ref, p.before.containers ?? []) : [];
  // What was in that container before the step: nothing, when it was not there or there were several.
  const empty: Observation | undefined = p.before ? { ...p.before, lines: [], elements: [], messages: [], fieldErrors: [] } : undefined;
  return {
    pages: {
      ...p,
      after: view(p.after, inside),
      ...(p.before ? { before: was.length === 1 ? view(p.before, was[0] as ObservedContainer) : (empty as Observation) } : {}),
    },
  };
}

function judgeVisibility(exp: IrExpectation, c: IrCondition, p: Pages & { after: Observation }): Evaluation {
  const wantVisible = (c.expect ?? 'VISIBLE') !== 'HIDDEN';
  const want = wantVisible !== exp.negated;
  const isMessage = c.target?.ontology === 'Message' || c.target?.ontology === 'Error' || c.text !== undefined;
  if (isMessage) {
    const ev = messageEvidence(p.after, p.before, c.text, p.dialogs);
    const expected = `${want ? 'shown' : 'not shown'}: ${c.text ? `"${c.text}"` : 'a message'}`;
    if (want) {
      if (ev.fresh.length)
        return settled(exp, true, expected, `shown after the step: ${quote(ev.fresh)}`, 'a message that this step produced says it', true, p.step);
      if (ev.stale.length)
        return unproven(
          exp,
          'STALE',
          expected,
          `${quote(ev.stale)} was on the page before the step`,
          'the message was already there before the step, so the step did not produce it',
          p.step,
        );
      return settled(
        exp,
        false,
        expected,
        `messages on the page: ${quote([...p.after.messages, ...p.after.fieldErrors.map((f) => f.message), ...ev.said])}`,
        'no message of that meaning appeared',
        true,
        p.step,
      );
    }
    const shown = ev.shown;
    return settled(
      exp,
      shown.length === 0,
      expected,
      shown.length ? `shown: ${quote(shown)}` : 'no such message',
      shown.length ? 'the message is on the page' : 'no such message is on the page',
      true,
      p.step,
    );
  }
  // "A or B is shown": the check holds when any of them is; with one target this is the plain check.
  const targets = [c.target, ...(c.alternatives ?? [])];
  const shown = (t: IrTarget | undefined): boolean => {
    const found = elementsFor(p.after, t);
    const heading = t?.ontology === 'Heading' || found.length > 0 ? found : [];
    return heading.length > 0 || (t?.name ? p.after.lines.some((l) => holdsWords(l, t.name ?? '')) : false);
  };
  const which = targets.filter(shown);
  const visible = which.length > 0;
  const named = targets.map((t) => describeTarget(t)).join(' or ');
  return settled(
    exp,
    visible === want,
    `${named} ${want ? 'is shown' : 'is not shown'}`,
    visible ? `${which.map((t) => describeTarget(t)).join(' and ')} is on the page` : `${named} is not on the page`,
    visible ? 'it is on the page' : 'it is not on the page',
    true,
    p.step,
  );
}

function judgeText(exp: IrExpectation, c: IrCondition, p: Pages & { after: Observation }, inContainer = false): Evaluation {
  const wanted = c.expect ?? c.text ?? '';
  if (!wanted || wanted.startsWith('$ref.'))
    return unproven(exp, 'UNRESOLVED', `text "${wanted}"`, 'the text is not known', 'the wanted text was not resolved', p.step);
  // Said to be in a container, the text is looked for in all of what the container shows, whatever kind of thing it is.
  const isMessage = !inContainer && (c.target?.ontology === 'Message' || c.target?.ontology === 'Error');
  const pool = isMessage ? [...p.after.messages, ...p.after.fieldErrors.map((f) => f.message), ...saidBy(p.dialogs)] : p.after.lines;
  const exact = c.check === 'exact-text';
  const hit = pool.filter((l) => (exact ? squash(l) === squash(wanted) || saysTheSame(l, wanted) : holdsWords(l, wanted) || saysTheSame(l, wanted)));
  const expected = `${exp.negated ? 'no ' : ''}text "${wanted}"`;
  const popups = saidBy(p.dialogs);
  // A pop-up came during the step: it is never a message that was already there.
  if (isMessage && !exp.negated && hit.length > 0 && hit.every((h) => !popups.includes(h) && wasThere(p.before, h))) {
    return unproven(
      exp,
      'STALE',
      expected,
      `${quote(hit)} was on the page before the step`,
      'the text was already there before the step, so the step did not produce it',
      p.step,
    );
  }
  return settled(
    exp,
    hit.length > 0 !== exp.negated,
    expected,
    hit.length ? `shown: ${quote(hit)}` : `the page shows ${quote(pool.slice(0, 4))}`,
    hit.length ? 'the text is on the page' : 'the text is not on the page',
    true,
    p.step,
  );
}

function judgeAuthentication(exp: IrExpectation, p: Pages & { after: Observation }): Evaluation {
  const { before, after } = p;
  const passwordShown = after.elements.some((e) => e.role === 'textbox' && squash(e.name).includes('password'));
  const errors = [...after.messages, ...after.fieldErrors.map((f) => f.message)].filter((m) => !wasThere(before, m));
  const moved = !!before && before.url !== after.url;
  const expected = exp.negated ? 'not logged in' : 'logged in';
  if (errors.length > 0 && !moved)
    return settled(exp, exp.negated, expected, `not logged in: ${quote(errors)}`, 'the page shows an error after the login and did not move on', true, p.step);
  if (moved && !passwordShown)
    return settled(
      exp,
      !exp.negated,
      expected,
      `logged in: the page moved to ${after.url}, with no login form`,
      'the page moved on and the login form is gone',
      true,
      p.step,
    );
  if (passwordShown && !moved)
    return settled(exp, exp.negated, expected, 'the login form is still shown and the page did not move', 'the login form is still there', true, p.step);
  return unproven(exp, 'NOT_OBSERVABLE', expected, `address ${after.url}`, 'the page does not show whether the login worked', p.step);
}

/** The kinds of check that conclude something about what a page holds, so that a frame nobody read can hide what they ask about. */
const ABOUT_CONTENT: ReadonlySet<string> = new Set(['VISIBILITY', 'TEXT', 'ENABLED', 'VALUE', 'COUNT', 'MASKED']);

/**
 * Judges one expectation on the page its step left (EX-06). While a frame could not be read, nothing can be said to be absent from it
 * (E0.13): a check that is disproven, or a "not shown" that is proven, only because the thing was not found is not decided. What was
 * found stays found.
 */
export function evaluateExpectation(exp: IrExpectation, ctx: JudgeContext): Evaluation {
  const ev = judgeExpectation(exp, ctx);
  if (!ABOUT_CONTENT.has(exp.condition.type)) return ev;
  const unread = pagesFor(exp, ctx).after?.unreadFrames;
  if (!unread?.length) return ev;
  if (ev.result === 'disproven' || (ev.result === 'proven' && exp.negated))
    return unproven(
      exp,
      'NOT_OBSERVABLE',
      ev.expected,
      `${ev.actual}; the frame ${unread.map((f) => `"${f}"`).join(', ')} could not be read`,
      'a frame could not be read after the page changed, so nothing can be said to be absent from it',
      ev.step,
    );
  return ev;
}

function judgeExpectation(exp: IrExpectation, ctx: JudgeContext): Evaluation {
  // A value the check names by its data key ("$data.First_Name") is compared as the value it stands for. A secret is never compared or shown.
  const given = exp.condition.expect;
  if (given?.startsWith('$data.')) {
    const value = ctx.values?.[given.slice(6)]?.value;
    const named = `${exp.negated ? 'not ' : ''}${exp.condition.type.toLowerCase()} ${describeTarget(exp.condition.target)} "${given}"`;
    if (value === undefined)
      return unproven(exp, 'UNRESOLVED', named, 'the value is not known', 'the value the check compares with was not resolved', ctx.stepOf.get(exp.id));
    if (typeof value !== 'string')
      return unproven(
        exp,
        'UNRESOLVED',
        named,
        'the value is a secret',
        'a secret is never shown, so it is not compared with the page',
        ctx.stepOf.get(exp.id),
      );
    return evaluateExpectation({ ...exp, condition: { ...exp.condition, expect: value } }, ctx);
  }
  const c = exp.condition;
  const p = pagesFor(exp, ctx);
  const expectedText = `${exp.negated ? 'not ' : ''}${c.type.toLowerCase()} ${describeTarget(c.target)}${c.expect ? ` ${c.expect}` : ''}`;
  if (!p.after) return unproven(exp, 'NO_PAGE', expectedText, 'the step it is judged on did not leave a page', 'there is no page to judge it on', p.step);
  const page = p as Pages & { after: Observation };
  switch (c.type) {
    case 'VISIBILITY': {
      const s = scoped(exp, c, page, expectedText);
      return 'unproven' in s ? s.unproven : judgeVisibility(exp, c, s.pages);
    }
    case 'TEXT': {
      const s = scoped(exp, c, page, expectedText);
      return 'unproven' in s ? s.unproven : judgeText(exp, c, s.pages, containerRef(c.target?.within) !== undefined && s.pages !== page);
    }
    case 'AUTHENTICATION':
      return judgeAuthentication(exp, page);
    case 'URL': {
      const wanted = c.expect ?? '';
      // "User stays on the Login page": the step did not move the page, which is a comparison with the page before it, not with a name.
      if (c.check === 'url-unchanged' || wanted === 'UNCHANGED') {
        const was = page.before?.url;
        if (!was)
          return unproven(
            exp,
            'NO_PAGE',
            'the address stays the same',
            'there is no page before the step to compare with',
            'nothing to compare the address with',
            p.step,
          );
        // When the page is only a shell around a frame, the screen is the frame's address: the shell can stay put while the screen changes (E8).
        const sameShell = pathOf(was) === pathOf(page.after.url);
        const sameScreen = pageIdentityOf(page.before?.contentUrl ?? '') === pageIdentityOf(page.after.contentUrl ?? '');
        const same = sameShell && sameScreen;
        return settled(
          exp,
          same !== exp.negated,
          `address ${exp.negated ? 'changes' : 'stays the same'}`,
          same
            ? `address is still ${page.after.url}`
            : sameShell
              ? `the page stayed at ${page.after.url}, but the screen in it went from ${page.before?.contentUrl ?? 'nothing'} to ${page.after.contentUrl ?? 'nothing'}`
              : `address went from ${was} to ${page.after.url}`,
          same ? 'the address did not change' : 'the address changed',
          true,
          p.step,
        );
      }
      if (!wanted || wanted.startsWith('$ref.')) return unproven(exp, 'UNRESOLVED', 'an address', 'not known', 'the wanted address was not resolved', p.step);
      // "OrangeHRM home/dashboard" is either page: each side is looked up as a page of its own.
      const names =
        wanted.includes('/') && !wanted.includes('://') && !wanted.startsWith('/')
          ? [
              wanted,
              ...wanted
                .split('/')
                .map((n) => n.trim())
                .filter(Boolean),
            ]
          : [wanted];
      const routes = names.map((n) => routeOf(n, ctx.pages)).filter((r): r is string => r !== undefined);
      const exact = c.check === 'equals' || c.check === 'exact-text';
      // The address of the page, and when the page is a shell around a frame, the address of the screen in it (E8).
      const addresses = [page.after.url, ...(page.after.contentUrl ? [page.after.contentUrl] : [])];
      const has = exact
        ? addresses.some((a) => a === wanted)
        : routes.length > 0
          ? routes.some((r) => addresses.some((a) => pathOf(a) === r))
          : names.some((n) => addresses.some((a) => compactKey(a).includes(compactKey(n)))); // a page name is not a path: "Dashboard" is /dashboard, "Add Employee" is /add-employee
      // The address says a page IS the one named when it matches. It says it is NOT only when the engine knows where the named page is,
      // or knows the page it is on is another one: a name it cannot place is not a reason to call the address wrong.
      const onAnotherKnownPage = Object.entries(ctx.pages ?? {}).some(
        ([n, where]) => where && addresses.some((a) => pathOf(a) === pathOf(where)) && !names.some((x) => compactKey(x) === compactKey(n)),
      );
      if (!has && !exact && routes.length === 0 && !onAnotherKnownPage)
        return unproven(
          exp,
          'UNRESOLVED',
          `address ${exp.negated ? 'does not contain' : 'contains'} "${wanted}"`,
          `address is ${addresses.join(' and the screen in it, ')}`,
          `"${wanted}" is not a page the run knows the address of, so the address cannot show that this is not that page`,
          p.step,
        );
      return settled(
        exp,
        has !== exp.negated,
        `address ${exp.negated ? 'does not contain' : 'contains'} "${wanted}"`,
        `address is ${page.after.url}`,
        has ? 'the address says it' : 'the address does not say it',
        true,
        p.step,
      );
    }
    case 'ENABLED': {
      const found = elementsFor(page.after, c.target);
      if (found.length === 0)
        return unproven(
          exp,
          'NOT_FOUND',
          `${describeTarget(c.target)} ${(c.expect ?? '').toLowerCase()}`,
          `${describeTarget(c.target)} is not on the page`,
          'the element is not on the page',
          p.step,
        );
      const wantDisabled = c.expect === 'DISABLED';
      const holds = found.every((e) => e.disabled === wantDisabled);
      return settled(
        exp,
        holds !== exp.negated,
        `${describeTarget(c.target)} is ${wantDisabled ? 'disabled' : 'enabled'}`,
        `${describeTarget(c.target)} is ${found[0]?.disabled ? 'disabled' : 'enabled'}`,
        'read from the page',
        true,
        p.step,
      );
    }
    case 'VALUE': {
      const found = elementsFor(page.after, c.target);
      if (found.length === 0)
        return unproven(
          exp,
          'NOT_FOUND',
          `${describeTarget(c.target)} value "${c.expect ?? ''}"`,
          'the field is not on the page',
          'the field is not on the page',
          p.step,
        );
      const holds = found.some((e) => e.value === c.expect);
      return settled(
        exp,
        holds !== exp.negated,
        `${describeTarget(c.target)} has the value "${c.expect ?? ''}"`,
        `${describeTarget(c.target)} has the value "${found[0]?.value ?? ''}"`,
        'read from the page',
        true,
        p.step,
      );
    }
    case 'MASKED': {
      const found = elementsFor(page.after, c.target);
      if (found.length === 0)
        return unproven(exp, 'NOT_FOUND', `${describeTarget(c.target)} is masked`, 'the field is not on the page', 'the field is not on the page', p.step);
      const masked = found.every((e) => (e.value ?? '').startsWith('•'));
      return settled(
        exp,
        masked !== exp.negated,
        `${describeTarget(c.target)} is masked`,
        masked ? 'it shows dots' : 'it shows its text',
        'read from the page',
        true,
        p.step,
      );
    }
    case 'HEALTH': {
      const bad = ctx.steps.filter((s) => s.status !== 'done');
      const title = page.after.title.toLowerCase();
      const broken = bad.length > 0 || title.includes('404') || title.includes('500') || title.includes('not found');
      return settled(
        exp,
        !broken,
        'the page works: no step failed and no error page',
        broken ? `a step did not finish, or the title is "${page.after.title}"` : 'every step finished and the page is a normal page',
        'read from the run',
        true,
        p.step,
      );
    }
    default:
      return unproven(
        exp,
        'NOT_OBSERVABLE',
        expectedText,
        'not observable through the page',
        `a ${c.type} check cannot be judged from what the page shows in this version`,
        p.step,
      );
  }
}

// ---- EX-08: the vacuous assertion guard ----

const FAILURE_WORDS = ['fail', 'invalid', 'unable', 'cannot', 'unsuccessful', 'denied', 'wrong', 'incorrect', 'not able'];

/**
 * A check that cannot fail, or that does not test what the tester meant (EX-08). It is never a PASS. Three kinds:
 * a check that something is not shown where the thing was never on any page and could not be; a long phrase that is
 * a garbled sentence rather than a name; and "the button is still shown" taken as proof that something failed.
 */
export function vacuity(exp: IrExpectation, ctx: JudgeContext): string | undefined {
  const c = exp.condition;
  if (exp.automatic) return undefined;
  const name = c.target?.name ?? '';
  const words = wordsOf(name);
  const everSeen = (text: string): boolean =>
    ctx.seen.some(
      (o) =>
        o.lines.some((l) => squash(l).includes(squash(text))) ||
        o.elements.some((e) => squash(e.name).includes(squash(text))) ||
        o.messages.some((m) => squash(m).includes(squash(text))),
    );
  const isMessage = c.target?.ontology === 'Message' || c.target?.ontology === 'Error';
  if (exp.negated && (c.type === 'VISIBILITY' || c.type === 'TEXT') && !isMessage && name) {
    // Whatever its length: a name no page of the run ever showed (a misspelling, a word from another screen) makes "not visible" true for any page.
    if (words.length >= 1 && !everSeen(name)) return `"${name}" is not a name that any page of this run shows: "not visible" cannot fail`;
    const heads = ['password', 'username', 'button', 'field', 'link'];
    if (words.length >= 3 && heads.some((h) => words.slice(0, -1).includes(h)) && !everSeen(name))
      return `"${name}" reads like a sentence, not the name of an element: "not visible" cannot fail`;
  }
  const clause = squash(`${ctx.clause} ${exp.clause}`);
  const failureCase = FAILURE_WORDS.some((w) => clause.includes(w));
  const isElement = ['Button', 'Link', 'Field', 'Username', 'Password', 'Heading'].includes(c.target?.ontology ?? '');
  if (failureCase && !exp.negated && c.type === 'VISIBILITY' && isElement && c.text === undefined) {
    return `a failure is "proven" by ${describeTarget(c.target)} being shown, and it is shown whether or not the failure happened`;
  }
  return undefined;
}
