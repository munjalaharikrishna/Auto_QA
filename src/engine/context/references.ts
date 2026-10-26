import type { IrCondition, IrExpectation, IrReference, IrStep, IrTarget } from '../ir/schema.js';
import type { Issue } from '../language/types.js';
import { compactKey } from '../text/compound.js';
import { buildContexts, type EnteredValue } from './context.js';

/**
 * Layer 14, reference resolution (RF-01). "Click it", "the same field", "the added data": the words point at something
 * the test case did earlier, and the context says what. A reference is resolved only when it points at exactly one
 * thing or one group that can be named; anything else stays a question for the tester, and nothing is guessed:
 *
 *  - "it", "this", "that"   → what the step before acted on (CX-02)
 *  - "same field", "same X"  → the field the test case used last, or the earlier one called X
 *  - "same value"            → the value entered last (CX-03)
 *  - "accepts the values"    → what the step before the check entered
 *  - "entered text boxes"    → what was entered since the page was opened
 *  - "added data", "updated records" → what was entered since the page was opened, up to the Save
 *
 * Words that need a look at the page ("above field", "corresponding button", "newly opened tab") are not resolved here.
 */

export interface RefInput {
  testId: string;
  steps: IrStep[];
  expectations: IrExpectation[];
  issues: Issue[];
  loggedIn?: boolean;
}

export interface RefOutput {
  steps: IrStep[];
  expectations: IrExpectation[];
  /** For each expectation id the input had, the ids that stand for it now: one check can become several. */
  expectationMap: Record<string, string[]>;
  issues: Issue[];
  references: IrReference[];
  decisions: string[];
}

const PRONOUNS: ReadonlySet<string> = new Set(['it', 'them', 'this', 'that', 'these', 'those']);
const SAVED_DATA: ReadonlySet<string> = new Set(['added', 'updated', 'saved', 'created']);
const OPENED_DATA: ReadonlySet<string> = new Set(['entered', 'uploaded']);
const NEEDS_THE_PAGE: ReadonlySet<string> = new Set(['above', 'below', 'previous', 'corresponding', 'associated', 'newly']);
const ENTERS: ReadonlySet<string> = new Set(['ENTER_VALUE', 'SELECT', 'UPLOAD', 'CHECK', 'UNCHECK']);
const WIPES: ReadonlySet<string> = new Set(['reset', 'clear', 'cancel']);

const nameOf = (t?: IrTarget): string => t?.name ?? t?.label ?? '';
const baseId = (id: string): string => id.split('.')[0] as string;

/** Whether a step is a save of what was entered: a click or a save on a Save/Submit/Update target. */
const isSave = (s: IrStep): boolean =>
  s.action === 'SAVE' || s.action === 'SUBMIT' || (s.action === 'CLICK' && ['save', 'submit', 'update', 'confirm'].includes(nameOf(s.target).toLowerCase()));

export function resolveReferences(input: RefInput): RefOutput {
  const steps = input.steps.map((s) => ({ ...s }));
  const expectations = input.expectations.map((e) => ({ ...e }));
  /** The ids the input had, that each expectation stands for. */
  const origin = new Map<IrExpectation, string[]>(expectations.map((e) => [e, [e.id]]));
  const references: IrReference[] = [];
  const decisions: string[] = [];
  const contexts = buildContexts(input.testId, steps, expectations, { loggedIn: input.loggedIn });
  const resolved = new Set<Issue>();
  /** Items already replaced by checks on what was entered: a second word of the same clause points at the same thing. */
  const consumed = new Set<string>();

  const add = (r: Omit<IrReference, 'id'>): void => {
    references.push({ id: `R${references.length + 1}`, ...r });
    decisions.push(`${r.status === 'RESOLVED' ? 'resolved' : 'not resolved'}: "${r.phrase}": ${r.because}`);
  };

  /** The page changes at a step that is followed by a check of the page it leads to: an entered group does not reach across it. */
  const changesPage = (s: IrStep): boolean =>
    s.action === 'NAVIGATE' || expectations.some((e) => e.afterStep === s.id && e.condition.type === 'URL' && e.condition.expect !== 'UNCHANGED' && !e.negated);

  /** What was entered since the page was opened, up to the last Save before `index` (or up to `index` when nothing was saved yet). */
  function enteredGroup(index: number, needsSave: boolean): { group: EnteredValue[]; why: string; ok: boolean } {
    let end = Math.min(index, steps.length);
    if (needsSave) {
      let save = -1;
      for (let i = end - 1; i >= 0; i--) {
        if (isSave(steps[i] as IrStep)) {
          save = i;
          break;
        }
      }
      if (save < 0) return { group: [], ok: false, why: 'no step before it saves what was entered' };
      end = save;
    }
    let start = end;
    while (start > 0 && !changesPage(steps[start - 1] as IrStep)) start--;
    const span = steps.slice(start, end);
    const group = span
      .filter((s) => ENTERS.has(s.action) && s.target && s.value !== undefined)
      .map((s) => ({ step: s.id, target: s.target as IrTarget, value: s.value as string }));
    if (!group.length) return { group, ok: false, why: `nothing was entered after ${steps[start - 1]?.id ?? 'the start'}` };
    const firstEntered = steps.findIndex((s) => s.id === (group[0] as EnteredValue).step);
    const wiped = needsSave
      ? span.find((s, k) => start + k > firstEntered && (s.action === 'CLEAR' || (s.action === 'CLICK' && WIPES.has(nameOf(s.target).toLowerCase()))))
      : undefined;
    if (wiped) return { group, ok: false, why: `${wiped.id} ("${wiped.original}") may have emptied what was entered before it was saved` };
    const saved = needsSave ? `, saved by ${steps[end]?.id}` : '';
    return { group, ok: true, why: `entered in ${group.map((g) => g.step).join(', ')}${saved}` };
  }

  /** One check for each thing entered: the field holds what was entered, a file is there, or (when the check is about emptiness) it is empty. */
  const checksOn = (group: readonly EnteredValue[], like: IrExpectation, empty: boolean): IrExpectation[] =>
    group.map((g) => {
      const upload = steps.find((s) => s.id === g.step)?.action === 'UPLOAD';
      // "… in the table", "… in the list": the data is read where it is shown, as text, not from the field it was typed in.
      const elsewhere = !empty && !upload && shownElsewhere(like.condition.target?.within);
      const condition: IrCondition = upload
        ? { type: 'STATE', target: g.target, expect: 'UPLOADED', check: 'uploaded' }
        : elsewhere
          ? { type: 'TEXT', expect: g.value, check: 'contains-text' }
          : { type: 'VALUE', target: g.target, expect: empty ? '' : g.value, check: 'value' };
      return {
        id: like.id,
        clause: like.clause,
        negated: upload && empty,
        condition,
        ...(like.afterStep ? { afterStep: like.afterStep } : {}),
        ...(like.guard ? { guard: like.guard } : {}),
      };
    });

  /** The checks that one sentence made, starting at `first`: they stand next to each other with the same words and the same step. */
  const runOf = (first: IrExpectation): IrExpectation[] => {
    const at = expectations.indexOf(first);
    let end = at + 1;
    while (end < expectations.length && expectations[end]?.clause === first.clause && expectations[end]?.afterStep === first.afterStep) end++;
    return expectations.slice(at, end);
  };

  /** Replaces the checks of one sentence by others, at the place of the first. The new ones stand for every id the old ones had. */
  const replaceRun = (run: IrExpectation[], replacements: IrExpectation[]): void => {
    const stood = run.flatMap((r) => origin.get(r) ?? [r.id]);
    for (const r of replacements) origin.set(r, stood);
    expectations.splice(expectations.indexOf(run[0] as IrExpectation), run.length, ...replacements);
  };

  for (const issue of input.issues) {
    if (issue.code !== 'NEEDS_REFERENCE' || !issue.reference) continue;
    const word = issue.reference;
    const phrase = issue.original;
    if (issue.item && consumed.has(issue.item)) {
      resolved.add(issue);
      continue;
    }
    const stepIndex = steps.findIndex((s) => s.id === issue.item);
    const itemExpectation = expectations.find((x) => x.id === issue.item);

    // "Text box should accept values": what the step before the check entered.
    if (word === '$entered') {
      const e = itemExpectation;
      const afterIndex = e?.afterStep ? steps.findIndex((s) => s.id === e.afterStep) : steps.length - 1;
      const entry = [...steps.slice(0, afterIndex + 1)].reverse().find((s) => ENTERS.has(s.action) && s.target && s.value !== undefined);
      if (!e || !entry) {
        add({ phrase, kind: 'PREVIOUS_VALUE', status: 'UNRESOLVED', steps: [], values: [], because: 'no value was entered before this check' });
        continue;
      }
      // One written step can enter several fields (S35, S35.2, …): "the values" are all of them.
      const siblings = steps.filter((s) => baseId(s.id) === baseId(entry.id) && ENTERS.has(s.action) && s.target && s.value !== undefined);
      const group = siblings.map((s) => ({ step: s.id, target: s.target as IrTarget, value: s.value as string }));
      replaceRun(runOf(e), checksOn(group, e, false));
      consumed.add(issue.item as string);
      add({
        phrase,
        kind: 'PREVIOUS_VALUE',
        status: 'RESOLVED',
        steps: group.map((g) => g.step),
        values: group.map((g) => g.value),
        because: `what ${group.map((g) => g.step).join(', ')} entered ("${entry.original}")`,
      });
      resolved.add(issue);
      continue;
    }

    if (NEEDS_THE_PAGE.has(word)) {
      add({
        phrase,
        kind: 'PREVIOUS_TARGET',
        status: 'UNRESOLVED',
        steps: [],
        values: [],
        because: `"${word}" depends on where things are on the page, which is known only when the page is seen`,
      });
      continue;
    }

    // "same value": the value entered last.
    if (word === 'same value') {
      const step = steps[stepIndex];
      const ctx = step ? contexts.get(step.id) : undefined;
      if (step && ctx?.previousValue !== undefined) {
        step.value = ctx.previousValue;
        add({
          phrase,
          kind: 'PREVIOUS_VALUE',
          status: 'RESOLVED',
          steps: ctx.previousStep ? [ctx.previousStep.id] : [],
          values: [ctx.previousValue],
          because: `the value entered last (${ctx.previousStep?.id})`,
        });
        resolved.add(issue);
      } else add({ phrase, kind: 'PREVIOUS_VALUE', status: 'UNRESOLVED', steps: [], values: [], because: 'no value was entered before this step' });
      continue;
    }

    // A step acting on "it", "this", "the same field".
    if (stepIndex >= 0 && (PRONOUNS.has(word) || word === 'same')) {
      const step = steps[stepIndex] as IrStep;
      const name = nameOf(step.target).toLowerCase();
      const wanted = name.startsWith('same ') ? name.slice(5) : name === 'same' || PRONOUNS.has(name) ? '' : undefined;
      if (wanted === undefined) {
        add({
          phrase,
          kind: 'PREVIOUS_TARGET',
          status: 'UNRESOLVED',
          steps: [],
          values: [],
          because: `"${word}" is part of "${name}", which names no earlier target`,
        });
        continue;
      }
      // The last earlier step that acted on something, or on the thing called by that name.
      const earlier = steps.slice(0, stepIndex).filter((s) => s.target);
      const source = (wanted ? earlier.filter((s) => compactKey(nameOf(s.target)) === compactKey(wanted)) : earlier).at(-1);
      if (!source?.target) {
        add({
          phrase,
          kind: 'PREVIOUS_TARGET',
          status: 'UNRESOLVED',
          steps: [],
          values: [],
          because: wanted ? `no earlier step acted on "${wanted}"` : 'no earlier step acted on anything',
        });
        continue;
      }
      step.target = source.target;
      add({
        phrase,
        kind: 'PREVIOUS_TARGET',
        status: 'RESOLVED',
        steps: [source.id],
        values: [],
        because: `"${word}" is what ${source.id} acted on ("${nameOf(source.target)}")`,
      });
      resolved.add(issue);
      continue;
    }

    // "added data", "the same updated records", "entered text boxes": what was entered before.
    if (SAVED_DATA.has(word) || OPENED_DATA.has(word) || word === 'same') {
      const e = itemExpectation;
      if (!e) continue;
      const mine = runOf(e);
      const at = e.afterStep ? steps.findIndex((s) => s.id === e.afterStep) + 1 : steps.length;
      const { group, ok, why } = enteredGroup(at, SAVED_DATA.has(word) || word === 'same');
      if (!ok) {
        add({ phrase, kind: 'ENTERED_DATA', status: 'UNRESOLVED', steps: group.map((g) => g.step), values: [], because: why });
        continue;
      }
      const empty = mine.some((m) => m.condition.type === 'VALUE' && m.condition.expect === '');
      replaceRun(mine, checksOn(group, e, empty));
      consumed.add(issue.item as string);
      add({ phrase, kind: 'ENTERED_DATA', status: 'RESOLVED', steps: group.map((g) => g.step), values: empty ? [] : group.map((g) => g.value), because: why });
      resolved.add(issue);
    }
  }

  // Expectation ids stay unique and in order after one check became several.
  const expectationMap: Record<string, string[]> = {};
  expectations.forEach((e, i) => {
    const stood = origin.get(e) ?? [e.id];
    e.id = `E${i + 1}`;
    for (const old of stood) (expectationMap[old] ??= []).push(e.id);
  });
  return { steps, expectations, expectationMap, issues: input.issues.filter((i) => !resolved.has(i)), references, decisions };
}

const LISTS: ReadonlySet<string> = new Set(['table', 'list', 'grid', 'results', 'listing', 'records', 'directory']);

/**
 * Whether the place a check names is a table or a list: data shown there is read as text. A "page" is not decided here: the
 * screen the data was typed on is often called a page too ("the same records in the Employee Information page"), so the
 * fields are read as before.
 */
function shownElsewhere(place: string | undefined): boolean {
  return !!place && place.toLowerCase().split(' ').some((w) => LISTS.has(w));
}
