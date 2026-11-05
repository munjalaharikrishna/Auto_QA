import type { IrExpectation, IrStep, IrTarget } from '../ir/schema.js';

/**
 * The data ledger (E0.16 item 2, audit U5). As a case is read, every value it enters is written down with the step that entered
 * it, and every Save that keeps a group of them makes a record: what kind of thing it is (an employee), whether it was created or
 * updated, and on which page. The pages the case goes through are written down too. References are read through it:
 *
 *  - "the entered details", "the added employee", "the updated record" name the record plainly and resolve to its values;
 *  - "previous page" is the page the case was on before the current one;
 *  - where a person decides which record ("Click on Employee Name", "the same updated records", owner, 4 Nov 2026), the ledger
 *    only suggests the record this case created or changed: a person confirms it, and one answer covers every case with that
 *    sentence.
 *
 * The ledger is built from QA-IR alone, before the run: it holds what the case says it will create. Values are kept as the case
 * holds them (`$data.First_Name_valid`), so a secret is never written down as text.
 */

export interface LedgerValue {
  step: string;
  field: IrTarget;
  /** `$data.name`, `$env.NAME` or the literal, as the step holds it. */
  value: string;
  /** A file chosen through an upload: it is checked as uploaded, not as text. */
  upload: boolean;
}

export type RecordKind = 'created' | 'updated' | 'saved';

export interface LedgerRecord {
  /** `D1`, `D2`, … in the order the case saves them. */
  id: string;
  /** What kind of thing it is, as the page names it ("Employee" from "Add Employee"); unknown when no page names it. */
  entity?: string;
  /** The page the values were entered on. */
  page?: string;
  kind: RecordKind;
  values: LedgerValue[];
  /** The step that saved it. */
  savedBy: string;
  /** A step between the values and the Save that probably emptied them (Reset): the record was saved, probably without them. */
  wipedBy?: string;
}

export interface LedgerPage {
  /** The step after which the case is on the page. */
  step: string;
  page: string;
}

export interface Ledger {
  values: LedgerValue[];
  records: LedgerRecord[];
  pages: LedgerPage[];
}

export const ENTERS: ReadonlySet<string> = new Set(['ENTER_VALUE', 'SELECT', 'UPLOAD', 'CHECK', 'UNCHECK']);
const WIPES: ReadonlySet<string> = new Set(['reset', 'clear', 'cancel']);
const CREATES: ReadonlySet<string> = new Set(['add', 'new', 'create', 'register', 'addnew']);
const UPDATES: ReadonlySet<string> = new Set(['edit', 'update', 'modify', 'change']);
/** Words of a page name that say what is done there, not what the thing is. */
const PAGE_WORDS: ReadonlySet<string> = new Set([
  ...CREATES,
  ...UPDATES,
  'page',
  'screen',
  'form',
  'section',
  'popup',
  'details',
  'information',
  'info',
  'list',
  'personal',
  'general',
  'basic',
  'my',
]);

const nameOf = (t?: IrTarget): string => t?.name ?? t?.label ?? '';

/** Whether a step saves what was entered: a click or a save on a Save/Submit/Update target. */
export const isSave = (s: IrStep): boolean =>
  s.action === 'SAVE' || s.action === 'SUBMIT' || (s.action === 'CLICK' && ['save', 'submit', 'update', 'confirm'].includes(nameOf(s.target).toLowerCase()));

/** Whether a step probably empties the form: Reset, Clear, Cancel. */
export const isWipe = (s: IrStep): boolean => s.action === 'CLEAR' || (s.action === 'CLICK' && WIPES.has(nameOf(s.target).toLowerCase()));

/** The page a step leads to, when the step opens one or a check right after it names the page reached. */
export function pageAfter(s: IrStep, expectations: readonly IrExpectation[]): string | undefined {
  if (s.action === 'NAVIGATE' && s.target?.name) return s.target.name;
  const url = expectations.find(
    (e) => e.afterStep === s.id && e.condition.type === 'URL' && e.condition.expect !== 'UNCHANGED' && !e.negated && !isPreviousPage(e.condition.target),
  );
  return url ? nameOf(url.condition.target) || undefined : undefined;
}

/** "the previous page": a page named by where it stands, not by its name. */
export const isPreviousPage = (t?: IrTarget): boolean => ['previous', 'previous page', 'last page'].includes(nameOf(t).toLowerCase());

/** Whether a step changes the page: a group of entered values does not reach across it. */
export const changesPage = (s: IrStep, expectations: readonly IrExpectation[]): boolean =>
  s.action === 'NAVIGATE' || expectations.some((e) => e.afterStep === s.id && e.condition.type === 'URL' && e.condition.expect !== 'UNCHANGED' && !e.negated);

/** "Add Employee" → "Employee"; "Personal Information" → undefined (it names no kind of thing). */
export function entityOf(page: string | undefined): string | undefined {
  const kept = (page ?? '')
    .split(' ')
    .filter(Boolean)
    .filter((w) => !PAGE_WORDS.has(w.toLowerCase()));
  return kept.length ? kept.join(' ') : undefined;
}

/** "Add Employee", "Edit Employee": a page that makes or changes one thing, and names it. */
const opensRecord = (page: string | undefined): boolean => {
  const first = (page ?? '').split(' ')[0]?.toLowerCase() ?? '';
  return CREATES.has(first) || UPDATES.has(first);
};

const kindOf = (page: string | undefined, earlier: readonly LedgerRecord[], entity: string | undefined): RecordKind => {
  const first = (page ?? '').split(' ')[0]?.toLowerCase() ?? '';
  if (CREATES.has(first)) return 'created';
  if (UPDATES.has(first)) return 'updated';
  // A later save of the same kind of thing, with no page that adds one in between, changes what the case created.
  if (earlier.some((r) => !entity || !r.entity || sameEntity(r.entity, entity))) return 'updated';
  return 'saved';
};

const sameEntity = (a: string, b: string): boolean => {
  const k = (s: string): string => s.toLowerCase().replace(/s$/, '');
  return k(a) === k(b);
};

export function buildLedger(steps: readonly IrStep[], expectations: readonly IrExpectation[]): Ledger {
  const values: LedgerValue[] = [];
  const records: LedgerRecord[] = [];
  const pages: LedgerPage[] = [];
  /** The values entered since the page was opened and not yet saved, and the step that emptied them, if one did. */
  let open: LedgerValue[] = [];
  let wipedBy: string | undefined;
  let page: string | undefined;
  let entity: string | undefined;

  for (const s of steps) {
    if (ENTERS.has(s.action) && s.target && s.value !== undefined) {
      const v: LedgerValue = { step: s.id, field: s.target, value: s.value, upload: s.action === 'UPLOAD' };
      values.push(v);
      open.push(v);
    }
    if (open.length && isWipe(s)) wipedBy = s.id;
    if (isSave(s) && open.length) {
      // "Add Employee" names the thing. A later page of it ("Job", "Personal Information") is a part of the same employee.
      const thing = (opensRecord(page) ? entityOf(page) : undefined) ?? entity ?? entityOf(page) ?? entityOf(open.find((v) => v.field.within)?.field.within);
      records.push({
        id: `D${records.length + 1}`,
        ...(thing ? { entity: thing } : {}),
        ...(page ? { page } : {}),
        kind: kindOf(page, records, thing),
        values: open,
        savedBy: s.id,
        ...(wipedBy ? { wipedBy } : {}),
      });
      if (thing) entity = thing;
      open = [];
      wipedBy = undefined;
    }
    const next = pageAfter(s, expectations);
    if (next) {
      pages.push({ step: s.id, page: next });
      page = next;
      open = [];
      wipedBy = undefined;
      if (opensRecord(next)) entity = entityOf(next) ?? entity;
    } else if (changesPage(s, expectations)) {
      open = [];
      wipedBy = undefined;
    }
  }
  return { values, records, pages };
}

/** Where a step stands in the case. */
const indexOf = (steps: readonly IrStep[], id: string | undefined): number => (id ? steps.findIndex((s) => s.id === id) : -1);

/**
 * The record a sentence most likely means: the last one saved before `at` (an index into `steps`), of the kind of thing named
 * when one is (`employee`), else the last one saved. Only a suggestion: who decides is the caller's business.
 */
export function recordBefore(ledger: Ledger, steps: readonly IrStep[], at: number, thing?: string): LedgerRecord | undefined {
  const before = ledger.records.filter((r) => indexOf(steps, r.savedBy) < at);
  if (!thing) return before.at(-1);
  const named = before.filter((r) => r.entity && sameEntity(r.entity, thing));
  return named.at(-1) ?? (before.every((r) => !r.entity) ? before.at(-1) : undefined);
}

/** The page the case was on before the one it is on at `at`: what "the previous page" means. */
export function pageBefore(ledger: Ledger, steps: readonly IrStep[], at: number): LedgerPage | undefined {
  const seen = ledger.pages.filter((p) => indexOf(steps, p.step) < at);
  const current = seen.at(-1);
  if (!current) return undefined;
  return [...seen].reverse().find((p) => p.page.toLowerCase() !== current.page.toLowerCase());
}

/** "the employee this case created in S7-S11, saved by S14 (Code, First Name, …)": a record in words, for a person to confirm. */
export function describeRecord(r: LedgerRecord): string {
  const thing = r.entity ? r.entity.toLowerCase() : 'record';
  const steps = r.values.map((v) => v.step);
  const span = steps.length > 1 ? `${steps[0]}-${steps.at(-1)}` : steps[0];
  const fields = r.values.map((v) => nameOf(v.field) || v.field.ontology).join(', ');
  const wiped = r.wipedBy ? `; ${r.wipedBy} probably emptied the form before the save` : '';
  return `the ${thing} this case ${r.kind} in ${span}, saved by ${r.savedBy} (${fields}${wiped})`;
}
