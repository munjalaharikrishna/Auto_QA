import { normKey } from '../parser/config.js';

/**
 * Automatic column matching (FR-IN-09): a sheet's headers → the test case fields of SPEC §5.
 * Names are compared ignoring case, spaces and punctuation. The mapping screen (FR-IN-02) will use
 * the same matcher as its first guess; a mapping file overrides it for unusual headers.
 */

export const FIELDS = ['id', 'title', 'type', 'preconditions', 'steps', 'testData', 'expected', 'requirementId'] as const;
export type Field = (typeof FIELDS)[number];
export const REQUIRED: Field[] = ['title', 'steps', 'expected'];

/** Header names per field, best first. A header matches the first field that lists it. */
const NAMES: Record<Field, string[]> = {
  id: ['id', 'test case id', 'testcase id', 'tc id', 'tcid', 'test id', 'case id', 'test case no', 'test case number', 'tc no', 'tc number', 'tc #'],
  title: [
    'title',
    'test case title',
    'test case name',
    'testcase name',
    'test name',
    'test case',
    'testcase',
    'test scenario',
    'scenario',
    'name',
    'summary',
    'test case description',
    'description',
  ],
  type: ['type', 'test type', 'test case type', 'category', 'test category'],
  preconditions: ['preconditions', 'precondition', 'pre-conditions', 'pre-condition', 'pre conditions', 'prerequisites', 'prerequisite', 'pre-requisites'],
  steps: [
    'steps',
    'test steps',
    'test step',
    'steps to reproduce',
    'step description',
    'steps description',
    'procedure',
    'test procedure',
    'actions',
    'action',
  ],
  testData: ['test data', 'testdata', 'data', 'input data', 'inputs', 'input'],
  expected: [
    'expected result',
    'expected results',
    'expected',
    'expected outcome',
    'expected output',
    'expected behaviour',
    'expected behavior',
    'expected result(s)',
  ],
  requirementId: ['requirement id', 'requirement', 'req id', 'req', 'requirement reference', 'user story', 'story', 'story id', 'jira id'],
};
/** The header names per field; a test checks that no name belongs to two fields. */
export const HEADER_NAMES = NAMES;
const LOOKUP = new Map<string, Field>();
for (const f of FIELDS) for (const n of NAMES[f]) if (!LOOKUP.has(normKey(n))) LOOKUP.set(normKey(n), f);

/** Column numbers (1-based, as in ExcelJS) for each field found. */
export type ColumnMap = Partial<Record<Field, number>>;

export interface MatchResult {
  map: ColumnMap;
  /** Headers that matched nothing, e.g. "Priority" or "Automation status". They are kept in the results copy. */
  unmatched: string[];
  missing: Field[];
}

/**
 * `mapping` is `{ field: header }` from a mapping file, e.g. `{ "steps": "What to do" }`. It wins over the
 * automatic match. A field matched twice keeps the first column.
 */
export function matchColumns(headers: Array<string | undefined>, mapping: Partial<Record<Field, string>> = {}): MatchResult {
  const map: ColumnMap = {};
  const byHeader = new Map(headers.map((h, i) => [normKey(h ?? ''), i + 1]));
  for (const [field, header] of Object.entries(mapping) as Array<[Field, string]>) {
    const col = byHeader.get(normKey(header));
    if (!col) throw new Error(`The mapping says ${field} is "${header}", but the sheet has no such column. Headers: ${headers.filter(Boolean).join(', ')}`);
    map[field] = col;
  }
  const unmatched: string[] = [];
  headers.forEach((h, i) => {
    const key = normKey(h ?? '');
    if (!key) return;
    const col = i + 1;
    if (Object.values(map).includes(col)) return;
    const field = LOOKUP.get(key);
    if (field && map[field] === undefined) map[field] = col;
    else unmatched.push(h ?? '');
  });
  return { map, unmatched, missing: REQUIRED.filter((f) => map[f] === undefined) };
}

/** The header row is the first of the top rows that names at least two of the required fields. */
export function findHeaderRow(rows: Array<Array<string | undefined>>, mapping: Partial<Record<Field, string>> = {}): number | undefined {
  const wanted = new Set(Object.values(mapping).map((h) => normKey(h ?? '')));
  for (const [i, row] of rows.slice(0, 15).entries()) {
    const fields = new Set(row.map((c) => LOOKUP.get(normKey(c ?? ''))).filter(Boolean));
    const mapped = row.filter((c) => wanted.has(normKey(c ?? ''))).length;
    if (REQUIRED.filter((f) => fields.has(f)).length + mapped >= 2) return i;
  }
  return undefined;
}
