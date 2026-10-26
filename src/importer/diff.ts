import type { RawTestCase } from '../model/test-model.js';
import { splitNumbered } from '../parser/text.js';

/**
 * What changed between two versions of a test case (IN-23): the fields that changed, and for the steps which one
 * (by number), so a re-import that changed one step shows that step and nothing else.
 */

export interface CaseChange {
  /** `steps` and `expected` are compared line by line; the rest as a whole. */
  field: 'title' | 'type' | 'preconditions' | 'steps' | 'testData' | 'expected' | 'requirementId' | 'stepExpected';
  kind: 'added' | 'removed' | 'changed';
  /** The step (or expected line) number, for `steps` and `expected`. */
  line?: number;
  before?: string;
  after?: string;
}

const norm = (text?: string) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Numbered items of a cell, in order, without their numbers. */
const itemsOf = (text?: string): string[] => splitNumbered(text ?? '').map((l) => norm(l.text));

function compareLines(field: 'steps' | 'expected', before: string[], after: string[]): CaseChange[] {
  const out: CaseChange[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const [a, b] = [before[i], after[i]];
    if (a === b) continue;
    if (a === undefined) out.push({ field, kind: 'added', line: i + 1, after: b });
    else if (b === undefined) out.push({ field, kind: 'removed', line: i + 1, before: a });
    else out.push({ field, kind: 'changed', line: i + 1, before: a, after: b });
  }
  return out;
}

export function diffCases(before: RawTestCase, after: RawTestCase): CaseChange[] {
  const out: CaseChange[] = [];
  for (const field of ['title', 'type', 'preconditions', 'testData', 'requirementId'] as const) {
    const [a, b] = [norm(before[field]), norm(after[field])];
    if (a === b) continue;
    out.push({ field, kind: !a ? 'added' : !b ? 'removed' : 'changed', ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) });
  }
  out.push(...compareLines('steps', itemsOf(before.steps), itemsOf(after.steps)));
  // The expected results given to single steps, as one text: "3: Text box accepts the values; 5: …".
  const checks = (c: RawTestCase) =>
    Object.entries(c.stepExpected ?? {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([n, text]) => `${n}: ${norm(text)}`)
      .join('; ');
  const [was, now] = [checks(before), checks(after)];
  if (was !== now)
    out.push({ field: 'stepExpected', kind: !was ? 'added' : !now ? 'removed' : 'changed', ...(was ? { before: was } : {}), ...(now ? { after: now } : {}) });
  // An expected result is usually one sentence: compare it as one unless it is a numbered or multi-line list.
  const lines = (t: string) => (/\n/.test(t.trim()) ? itemsOf(t) : [norm(t)]);
  out.push(...compareLines('expected', lines(before.expected), lines(after.expected)));
  return out;
}

/** One line a person can read: `Step 3: "Click Login" → "Click Sign in"`. */
export function describeChange(c: CaseChange): string {
  const where = c.line ? `${c.field === 'steps' ? 'Step' : 'Expected'} ${c.line}` : c.field;
  if (c.kind === 'added') return `${where} added: "${c.after}"`;
  if (c.kind === 'removed') return `${where} removed: "${c.before}"`;
  return `${where}: "${c.before}" → "${c.after}"`;
}
