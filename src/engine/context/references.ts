import type { IrCondition, IrExpectation, IrReference, IrStep, IrTarget } from '../ir/schema.js';
import type { Issue } from '../language/types.js';
import { compactKey } from '../text/compound.js';
import { buildContexts, type EnteredValue } from './context.js';
import {
  buildLedger,
  describeRecord,
  ENTERS,
  isPreviousPage,
  isSave,
  isWipe,
  type LedgerRecord,
  pageBefore,
  changesPage as pageChanges,
  recordBefore,
} from './ledger.js';

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
 *  - "the entered details"   → what was entered since the page was opened (the data ledger, E0.16)
 *  - "the added employee", "the updated record" → the values of the record the case saved (the data ledger)
 *  - "the previous page"     → the page the case was on before the current one (the data ledger)
 *
 * Where a person decides which record ("Click on Employee Name", "the same updated records"), the ledger suggests the record this
 * case created or changed (`Issue.suggested`), and the question stays for a person to confirm (owner, 4 Nov 2026).
 *
 * Words that need a look at the page ("above field", "corresponding button", "newly opened tab") are not resolved here.
 */

export interface RefInput {
  testId: string;
  steps: IrStep[];
  expectations: IrExpectation[];
  issues: Issue[];
  loggedIn?: boolean;
  /**
   * The ids of checks drawn from a sentence of the steps that only checks something ("Checking the login section at middle of the
   * page"), not from an expected result. Such a check is dropped when an expected result checks the same thing at the same point.
   */
  checkSteps?: ReadonlySet<string>;
}

export interface RefOutput {
  steps: IrStep[];
  expectations: IrExpectation[];
  /** For each expectation id the input had, the ids that stand for it now: one check can become several. */
  expectationMap: Record<string, string[]>;
  issues: Issue[];
  references: IrReference[];
  decisions: string[];
  /** What the report must point out: a check that is read as written although an earlier step probably makes it fail. */
  warnings: string[];
}

const PRONOUNS: ReadonlySet<string> = new Set(['it', 'them', 'this', 'that', 'these', 'those']);
const SAVED_DATA: ReadonlySet<string> = new Set(['added', 'updated', 'saved', 'created']);
const OPENED_DATA: ReadonlySet<string> = new Set(['entered', 'uploaded']);
const LIST_ROWS: ReadonlySet<string> = new Set(['record', 'records', 'row', 'rows', 'entries']);
const NEEDS_THE_PAGE: ReadonlySet<string> = new Set(['above', 'below', 'previous', 'corresponding', 'associated', 'newly']);
/** "the entered details", "the entered data": the whole group entered, not only the step before. */
const DATA_NOUNS: ReadonlySet<string> = new Set(['details', 'data', 'information', 'info', 'values', 'fields']);
/** A state check that names a saved record: "the added employee is shown", "the updated record". */
const RECORD_STATES: ReadonlySet<string> = new Set(['ADDED', 'CREATED', 'SAVED', 'UPDATED']);

const nameOf = (t?: IrTarget): string => t?.name ?? t?.label ?? '';
const baseId = (id: string): string => id.split('.')[0] as string;

export function resolveReferences(input: RefInput): RefOutput {
  const steps = input.steps.map((s) => ({ ...s }));
  const expectations = input.expectations.map((e) => ({ ...e }));
  /** The ids the input had, that each expectation stands for. */
  const origin = new Map<IrExpectation, string[]>(expectations.map((e) => [e, [e.id]]));
  const references: IrReference[] = [];
  const decisions: string[] = [];
  const warnings: string[] = [];
  const contexts = buildContexts(input.testId, steps, expectations, { loggedIn: input.loggedIn });
  // The data ledger (E0.16): what the case entered and saved, built before any check is rewritten.
  const ledger = buildLedger(steps, expectations);
  const resolved = new Set<Issue>();
  /** Questions the ledger raises itself: "the previous page" when the case was on no other page. */
  const unresolvedPages: Issue[] = [];
  /** Items already replaced by checks on what was entered: a second word of the same clause points at the same thing. */
  const consumed = new Set<string>();

  const add = (r: Omit<IrReference, 'id'>): void => {
    references.push({ id: `R${references.length + 1}`, ...r });
    decisions.push(`${r.status === 'RESOLVED' ? 'resolved' : 'not resolved'}: "${r.phrase}": ${r.because}`);
  };

  /** The page changes at a step that is followed by a check of the page it leads to: an entered group does not reach across it. */
  const changesPage = (s: IrStep): boolean => pageChanges(s, expectations);

  /** What was entered since the page was opened, up to the last Save before `index` (or up to `index` when nothing was saved yet). */
  function enteredGroup(index: number, needsSave: boolean): { group: EnteredValue[]; why: string; ok: boolean; wiped?: IrStep } {
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
    const wiped = needsSave ? span.find((s, k) => start + k > firstEntered && isWipe(s)) : undefined;
    const saved = needsSave ? `, saved by ${steps[end]?.id}` : '';
    // Reset before Save: the check is read as the tester wrote it, and the run shows whether it holds (owner, 4 Nov 2026).
    if (wiped)
      return {
        group,
        ok: true,
        wiped,
        why: `entered in ${group.map((g) => g.step).join(', ')}${saved}; ${wiped.id} ("${wiped.original}") probably emptied them before the save`,
      };
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
      // "the entered details": everything entered since the page was opened, as the ledger holds it (E0.16), not only the last step.
      const words = [...phrase.toLowerCase()]
        .map((c) => (c >= 'a' && c <= 'z' ? c : ' '))
        .join('')
        .split(' ');
      const all = words.includes('entered') && words.some((w) => DATA_NOUNS.has(w)) ? enteredGroup(afterIndex + 1, false) : undefined;
      const group = all?.ok ? all.group : siblings.map((s) => ({ step: s.id, target: s.target as IrTarget, value: s.value as string }));
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
      // "the same updated records": rows of a list, one per record. Which record is for a person to say (owner, 4 Nov 2026).
      const record = phrase
        .toLowerCase()
        .split(' ')
        .find((w) => LIST_ROWS.has(w));
      // "The added record" names it: the one this case added. "The same updated records" does not.
      if (record && word !== 'added' && word !== 'created') {
        issue.record ??= 'record';
        add({ phrase, kind: 'ENTERED_DATA', status: 'UNRESOLVED', steps: [], values: [], because: `"${record}" are rows of a list: which record is not said` });
        continue;
      }
      const mine = runOf(e);
      const at = e.afterStep ? steps.findIndex((s) => s.id === e.afterStep) + 1 : steps.length;
      const { group, ok, why, wiped } = enteredGroup(at, SAVED_DATA.has(word) || word === 'same');
      if (!ok) {
        add({ phrase, kind: 'ENTERED_DATA', status: 'UNRESOLVED', steps: group.map((g) => g.step), values: [], because: why });
        continue;
      }
      const empty = mine.some((m) => m.condition.type === 'VALUE' && m.condition.expect === '');
      if (wiped && !empty)
        warnings.push(
          `"${phrase}": ${wiped.id} ("${wiped.original}") empties what was entered before it is saved, so this check will probably fail. It is checked as written.`,
        );
      replaceRun(mine, checksOn(group, e, empty));
      consumed.add(issue.item as string);
      add({ phrase, kind: 'ENTERED_DATA', status: 'RESOLVED', steps: group.map((g) => g.step), values: empty ? [] : group.map((g) => g.value), because: why });
      resolved.add(issue);
    }
  }

  // ---- the data ledger (E0.16) ----
  /** Where a sentence stands: the index of its step, or of the step after the one its check follows. */
  const placeOf = (i: Issue): number => {
    const byItem = i.item ? steps.findIndex((s) => s.id === i.item) : -1;
    if (byItem >= 0) return byItem;
    const e = (i.item ? expectations.find((x) => x.id === i.item) : undefined) ?? expectations.find((x) => x.clause === i.original);
    if (e) return e.afterStep ? steps.findIndex((s) => s.id === e.afterStep) + 1 : steps.length;
    const step = steps.findIndex((s) => s.original === i.original);
    return step >= 0 ? step : steps.length;
  };

  // "User should navigate to the previous page": the page the case was on before this one, not a page called "previous".
  for (const e of expectations) {
    const t = e.condition.target;
    if (e.condition.type !== 'URL' || !isPreviousPage(t)) continue;
    const at = e.afterStep ? steps.findIndex((s) => s.id === e.afterStep) + 1 : steps.length;
    const before = pageBefore(ledger, steps, at);
    if (!before) {
      add({ phrase: e.clause, kind: 'PREVIOUS_STEP', status: 'UNRESOLVED', steps: [], values: [], because: 'the case was on no other page before this one' });
      unresolvedPages.push({
        code: 'NEEDS_REFERENCE',
        severity: 'review',
        reference: 'previous',
        item: e.id,
        where: 'expected result',
        original: e.clause,
        message: '"the previous page" points at the page before this one, and the case names no page before it',
        suggestion: 'Name the page: User should navigate to the <name> page.',
      });
      continue;
    }
    e.condition = { ...e.condition, target: { ...(t as IrTarget), name: before.page }, expect: before.page };
    add({
      phrase: e.clause,
      kind: 'PREVIOUS_STEP',
      status: 'RESOLVED',
      steps: [before.step],
      values: [],
      because: `the page the case was on after ${before.step}: "${before.page}"`,
    });
  }

  // "User should see the added employee in the list": a record the case saved, named plainly. Its values are checked (owner, 5 Nov 2026).
  for (const e of [...expectations]) {
    const c = e.condition;
    if (c.type !== 'STATE' || e.negated || !RECORD_STATES.has(c.expect ?? '') || !c.target?.name || consumed.has(e.id)) continue;
    const at = e.afterStep ? steps.findIndex((s) => s.id === e.afterStep) + 1 : steps.length;
    const thing = c.target.name;
    const record = recordBefore(ledger, steps, at, LIST_ROWS.has(thing.toLowerCase()) ? undefined : thing);
    if (!record?.entity && !LIST_ROWS.has(thing.toLowerCase())) continue;
    if (!record) continue;
    if (record.wipedBy)
      warnings.push(
        `"${e.clause}": ${record.wipedBy} empties what was entered before ${record.savedBy} saves it, so this check will probably fail. It is checked as written.`,
      );
    const group = record.values.map((v) => ({ step: v.step, target: v.field, value: v.value }));
    replaceRun([e], checksOn(group, e, false));
    add({
      phrase: e.clause,
      kind: 'ENTERED_DATA',
      status: 'RESOLVED',
      steps: group.map((g) => g.step),
      values: group.map((g) => g.value),
      because: describeRecord(record),
    });
  }

  // "Click on Employee Name", "the same updated records": a person decides which record. The ledger offers the one this case saved.
  for (const i of input.issues) {
    if (resolved.has(i) || !i.record) continue;
    const record = recordBefore(ledger, steps, placeOf(i), i.record === 'record' ? undefined : i.record);
    if (!record) continue;
    i.suggested = suggestionOf(record);
    decisions.push(`suggested for "${i.original}": ${i.suggested.answer} (a person confirms it)`);
  }

  // A check the tester wrote as a step and again as the expected result at the same point is checked once, under the expected result's
  // words (E0.15). Two expected results that read the same are both kept: each is a sentence of the tester's.
  const fromStep = (e: IrExpectation): boolean => (origin.get(e) ?? [e.id]).every((id) => input.checkSteps?.has(id));
  const sameCheck = (e: IrExpectation): string => {
    const c = e.condition;
    return JSON.stringify([
      c.type,
      e.negated,
      nameOf(c.target).toLowerCase(),
      c.target?.within ?? '',
      c.expect ?? '',
      c.text ?? '',
      c.region ?? '',
      (c.alternatives ?? []).map((a) => nameOf(a).toLowerCase()),
      e.afterStep ?? '',
      e.guard ?? '',
    ]);
  };
  // "User should see tabs" right after a step that named the tabs: the check is on those tabs, one each, not on the word "tabs"
  // (owner, 3 Nov 2026). Only a check that names a kind of thing and no thing, and only when things of that kind were named at the
  // same point; otherwise it stays as it is.
  for (const e of [...expectations]) {
    const t = e.condition.target;
    if (e.condition.type !== 'VISIBILITY' || e.negated || !t?.ontology || t.name || e.condition.alternatives?.length) continue;
    const named = expectations.filter(
      (x) =>
        x !== e &&
        x.condition.type === 'VISIBILITY' &&
        !x.negated &&
        x.afterStep === e.afterStep &&
        x.guard === e.guard &&
        x.condition.target?.ontology === t.ontology &&
        !!x.condition.target.name,
    );
    if (named.length < 2) continue;
    replaceRun(
      [e],
      named.map((x) => ({ ...x, id: e.id, clause: e.clause })),
    );
    decisions.push(`"${e.clause}": the ${t.label ?? t.ontology} are the ones named before it: ${named.map((x) => nameOf(x.condition.target)).join(', ')}`);
  }

  for (const e of [...expectations]) {
    if (!fromStep(e)) continue;
    const twin = expectations.find((x) => x !== e && !fromStep(x) && sameCheck(x) === sameCheck(e));
    if (!twin) continue;
    origin.set(twin, [...(origin.get(twin) ?? [twin.id]), ...(origin.get(e) ?? [e.id])]);
    expectations.splice(expectations.indexOf(e), 1);
    decisions.push(`"${e.clause}" checks the same as "${twin.clause}" at the same point: it is checked once`);
  }

  // Expectation ids stay unique and in order after one check became several.
  const expectationMap: Record<string, string[]> = {};
  expectations.forEach((e, i) => {
    const stood = origin.get(e) ?? [e.id];
    e.id = `E${i + 1}`;
    for (const old of stood) (expectationMap[old] ??= []).push(e.id);
  });
  return {
    steps,
    expectations,
    expectationMap,
    issues: [...input.issues.filter((i) => !resolved.has(i)), ...unresolvedPages],
    references,
    decisions,
    warnings,
  };
}

const LISTS: ReadonlySet<string> = new Set(['table', 'list', 'grid', 'results', 'listing', 'records', 'directory']);

/**
 * Whether the place a check names is a table or a list: data shown there is read as text. A "page" is not decided here: the
 * screen the data was typed on is often called a page too ("the same records in the Employee Information page"), so the
 * fields are read as before.
 */
function shownElsewhere(place: string | undefined): boolean {
  return (
    !!place &&
    place
      .toLowerCase()
      .split(' ')
      .some((w) => LISTS.has(w))
  );
}

/** What a person is offered as the answer: the record, in words, and the steps and values it holds. */
function suggestionOf(r: LedgerRecord): NonNullable<Issue['suggested']> {
  return { record: r.id, answer: describeRecord(r), steps: r.values.map((v) => v.step), values: r.values.map((v) => v.value) };
}
