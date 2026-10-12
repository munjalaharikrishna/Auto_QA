import type { IrAction, IrTarget, QaIr } from '../ir/schema.js';
import type { Plan } from '../pipeline/stages.js';
import { componentVersions } from '../versions.js';
import type { FunctionName } from './capabilities.js';

/**
 * Layer 36, the action planner (EX-01). The QA-IR plan says which steps and checks run and in what order; the action
 * planner says how each step is done: as a chain of small operations, such as `ENTER_VALUE → find the field → resolve
 * the locator → validate it → fill → wait → observe`. The chains are data. They are shown in review before anything
 * runs and stored with the run, so what was done can always be compared with what was planned. A value is shown as the
 * name it comes from, never as the value of a secret.
 */

export type OpKind = 'resolve-address' | 'resolve-value' | 'find-row' | 'find' | 'resolve-locator' | 'validate-locator' | 'act' | 'wait' | 'observe';

export interface PlannedOp {
  op: OpKind;
  /** The MCP function the operation calls, when it calls one. */
  function?: FunctionName;
  detail: string;
}

export interface Chain {
  /** The step of the QA-IR (`S3`). */
  step: string;
  action: IrAction;
  /** The tester's own words. */
  original: string;
  target?: IrTarget;
  /** The value, as the document writes it: `$data.username`, a literal, a key name. Never the value of a secret. */
  value?: string;
  /** The value is a secret: a plan shows it by its name only. */
  secret?: boolean;
  /** What to do with a native pop-up (alert, confirm) that this step opens. */
  dialog: 'accept' | 'dismiss';
  ops: PlannedOp[];
  /** The checks of the QA-IR that are judged on the page this step leaves. */
  checksAfter: string[];
}

export interface ExecutionPlan {
  testId: string;
  chains: Chain[];
  /** The functions the run needs: what the capability manager is asked about before anything runs. */
  needs: FunctionName[];
  /** The versions of the components that made it (GV-12). */
  versions: Record<string, string>;
}

const CLICKS: ReadonlySet<IrAction> = new Set([
  'CLICK',
  'SUBMIT',
  'SAVE',
  'CANCEL',
  'CLOSE',
  'DELETE',
  'EDIT',
  'REMOVE',
  'EXPAND',
  'COLLAPSE',
  'DOWNLOAD',
  'LOGOUT',
]);

/** The name a verb gives its target when the step names none: "Save" is the Save button. */
const IMPLIED_TARGET: Partial<Record<IrAction, string>> = { SAVE: 'Save', SUBMIT: 'Submit', CANCEL: 'Cancel', CLOSE: 'Close', LOGOUT: 'Logout' };

const DIALOG_WORDS = ['confirm', 'dialog', 'alert', 'prompt', 'pop-up', 'popup'];
const dismisses = (next: { action: IrAction; target?: IrTarget } | undefined): boolean =>
  (next?.action === 'CANCEL' || next?.action === 'CLOSE') &&
  DIALOG_WORDS.some((w) => (next.target?.name ?? next.target?.label ?? '').toLowerCase().includes(w));

const targetName = (t?: IrTarget): string => t?.name ?? t?.label ?? 'the element';

function opsFor(action: IrAction, target: IrTarget | undefined, value: string | undefined): PlannedOp[] {
  const name = targetName(target);
  const find: PlannedOp[] = [
    ...(target?.row
      ? [{ op: 'find-row' as const, detail: `find the table row that holds ${target.row.map((r) => `"${r}"`).join(' and ')}, on any page of the table` }]
      : []),
    { op: 'find', detail: `find "${name}"${target?.row ? ' in that row' : ''} (${target?.ontology ?? 'Element'})` },
    { op: 'resolve-locator', detail: 'take the first candidate level that finds exactly one usable element' },
    { op: 'validate-locator', detail: 'check that the locator finds that one element' },
  ];
  const wait: PlannedOp = { op: 'wait', detail: 'until the page is loaded, the network is quiet and the page has stopped changing' };
  const look: PlannedOp = { op: 'observe', detail: 'read the page and compare it with before' };
  switch (action) {
    case 'NAVIGATE':
      return [{ op: 'resolve-address', detail: `the address of "${name}"` }, { op: 'act', function: 'navigate', detail: 'open the address' }, wait, look];
    case 'ENTER_VALUE':
    case 'CLEAR':
      return [
        { op: 'resolve-value', detail: action === 'CLEAR' ? 'nothing: the field is emptied' : `the value ${value ?? '(none)'}` },
        ...find,
        { op: 'act', function: 'type', detail: `${action === 'CLEAR' ? 'empty' : 'fill'} the field` },
        wait,
        look,
      ];
    case 'SEARCH':
      return [
        { op: 'resolve-value', detail: `the value ${value ?? '(none)'}` },
        ...find,
        { op: 'act', function: 'type', detail: 'type the text and submit' },
        wait,
        look,
      ];
    case 'SELECT':
      return [
        { op: 'resolve-value', detail: `the option ${value ?? '(none)'}` },
        ...find,
        { op: 'act', function: 'selectOption', detail: 'choose the option' },
        wait,
        look,
      ];
    case 'CHECK':
    case 'UNCHECK':
      return [...find, { op: 'act', function: 'click', detail: `${action === 'CHECK' ? 'tick' : 'untick'} it, only if it is not so already` }, wait, look];
    case 'UPLOAD':
      return [
        { op: 'resolve-value', detail: `the file ${value ?? '(none)'}` },
        ...find,
        { op: 'act', function: 'click', detail: 'open the file chooser' },
        { op: 'act', function: 'fileUpload', detail: 'give the file' },
        wait,
        look,
      ];
    case 'PRESS':
      return [
        { op: 'resolve-value', detail: `the key ${value ?? '(none)'}` },
        ...(target ? find : []),
        { op: 'act', function: 'pressKey', detail: 'press the key' },
        wait,
        look,
      ];
    case 'HOVER':
      return [...find, { op: 'act', function: 'hover', detail: 'move the pointer over it' }, wait, look];
    case 'BACK':
      return [{ op: 'act', function: 'back', detail: 'go back one page' }, wait, look];
    case 'FORWARD':
      return [{ op: 'act', function: 'back', detail: 'go forward one page (through the page history)' }, wait, look];
    case 'REFRESH':
      return [{ op: 'act', function: 'back', detail: 'load the page again (through the page)' }, wait, look];
    case 'SCROLL':
      return [{ op: 'act', function: 'wheel', detail: 'scroll' }, wait, look];
    case 'WAIT':
      return [{ op: 'wait', detail: `until the page is idle, for at most ${value ?? '5000'} ms: never a fixed sleep` }, look];
    default:
      return CLICKS.has(action)
        ? [...find, { op: 'act', function: 'click', detail: 'click it' }, wait, look]
        : [{ op: 'act', detail: `${action} is not run in this version` }];
  }
}

/** The functions a chain calls. */
export const functionsOf = (c: Chain): FunctionName[] => [...new Set(c.ops.flatMap((o) => (o.function ? [o.function] : [])))];

export function planActions(ir: QaIr, plan: Pick<Plan, 'items'>): ExecutionPlan {
  const byId = new Map(ir.steps.map((s) => [s.id, s]));
  const expectations = new Map(ir.expectations.map((e) => [e.id, e]));
  const stepsInPlan = plan.items
    .filter((i) => i.kind === 'step')
    .map((i) => byId.get(i.ref))
    .filter((s): s is QaIr['steps'][number] => s !== undefined);
  const chains: Chain[] = [];
  for (const [k, s] of stepsInPlan.entries()) {
    const target = s.target ?? (IMPLIED_TARGET[s.action] ? { ontology: 'Button', name: IMPLIED_TARGET[s.action] as string } : undefined);
    // A check judged on the page this step leaves: the ones the plan puts right after it.
    const here = plan.items.findIndex((i) => i.kind === 'step' && i.ref === s.id);
    const after: string[] = [];
    for (let j = here + 1; j < plan.items.length && plan.items[j]?.kind === 'expect'; j++) after.push((plan.items[j] as { ref: string }).ref);
    const secret = s.value?.startsWith('$data.') && (ir.data[s.value.slice(6)]?.secret ?? false);
    chains.push({
      step: s.id,
      action: s.action,
      original: s.original,
      ...(target ? { target } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(secret ? { secret: true } : {}),
      dialog: dismisses(stepsInPlan[k + 1]) ? 'dismiss' : 'accept',
      ops: opsFor(s.action, target, s.value),
      checksAfter: after.filter((id) => expectations.has(id)),
    });
  }
  // A check the plan puts before every step is judged on the page the run starts on.
  const needs = [...new Set(chains.flatMap(functionsOf))].sort() as FunctionName[];
  return { testId: ir.testCase.id, chains, needs, versions: { ...componentVersions() } };
}

/** The plan as text, for the review before a run. */
export function renderPlan(p: ExecutionPlan): string {
  const lines = [`Execution plan for ${p.testId}: ${p.chains.length} step(s); needs ${p.needs.join(', ') || 'nothing'}`];
  for (const c of p.chains) {
    lines.push(
      `  ${c.step} ${c.action}  "${c.original}"${c.secret ? '  [the value is a secret]' : ''}${c.dialog === 'dismiss' ? '  [a pop-up it opens is dismissed]' : ''}`,
    );
    for (const o of c.ops) lines.push(`      ${o.op}${o.function ? ` (${o.function})` : ''}: ${o.detail}`);
    if (c.checksAfter.length) lines.push(`      then judged: ${c.checksAfter.join(', ')}`);
  }
  return lines.join('\n');
}
