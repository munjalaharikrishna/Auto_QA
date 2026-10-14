import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { type CompileResult, compileCase } from '../engine/index.js';
import type { Issue } from '../engine/language/types.js';
import { readWorkbook } from '../importer/workbook.js';
import type { RawTestCase } from '../model/test-model.js';
import { buildReport, classifyIssue, classifyRun, compileItems, type ReviewItem, reportText, runItems } from './review-report.js';

/**
 * The grouped review report: every reason a case is set aside, grouped by cause, with who can fix it. It must account for every
 * review item exactly once, and say how many cases wait only for engine work and how many wait for a person.
 */

const issue = (code: Issue['code'], extra: Partial<Issue> = {}): Issue => ({
  code,
  severity: 'blocking',
  message: `a "thing" about ${code}`,
  original: 'the sentence',
  where: 'step 2',
  ...extra,
});
const raw = (id: string, steps: string[], expected: string, extra: Partial<RawTestCase> = {}): RawTestCase => ({
  id,
  title: id,
  steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
  expected,
  ...extra,
});

describe('who can fix a compile-time reason', () => {
  it('puts what only a tester can decide with the tester', () => {
    for (const code of ['AMBIGUOUS', 'UNKNOWN_BRANCH', 'PARADOX', 'NOT_CHECKED'] as const) assert.equal(classifyIssue(issue(code)).owner, 'tester', code);
  });
  it('puts a missing value with the project data', () => {
    assert.equal(classifyIssue(issue('MISSING_DATA')).owner, 'data');
  });
  it('puts a sentence the engine cannot read with the engine when it has no clearer wording, and with the tester when it has', () => {
    for (const code of ['NOT_UNDERSTOOD', 'UNSUPPORTED'] as const) {
      assert.equal(classifyIssue(issue(code)).owner, 'engine', `${code} without a suggestion`);
      assert.equal(classifyIssue(issue(code, { suggestion: 'Say it like this' })).owner, 'tester', `${code} with one`);
    }
  });
  it('groups the same reason together whatever the tester wrote inside the quotes', () => {
    const a = classifyIssue(issue('AMBIGUOUS', { message: 'the word "it" could mean two things' }));
    const b = classifyIssue(issue('AMBIGUOUS', { message: 'the word "same" could mean two things' }));
    assert.equal(a.cause, b.cause);
  });
});

describe('who can fix a reason found in a run', () => {
  const cases: Array<[string, string, string]> = [
    [
      'A2 "Login is rejected": More than one element matches "appropriate invalid username". 2 elements fit about equally well',
      'engine',
      'an expected result was searched for as an element',
    ],
    [
      'A2 "Login is rejected": I could not find "appropriate invalid username" on the page. Nothing on this page looks like it.',
      'engine',
      'an expected result was searched for as an element',
    ],
    ['S3 "Click Save": I could not find "Save" on the page. Nothing on this page looks like it.', 'data', 'an element a step names is not on the page'],
    ['S3 "Click the Add button": More than one element matches "Add". 2 elements fit about equally well', 'data', 'a step names more than one element'],
    [
      'E2 "an appropriate error message is displayed": the page showed new text ("Invalid Login"), but not in the words expected',
      'tester',
      'a message was shown in other words',
    ],
    [
      'VALUE_UNRESOLVED at S2: the value for "Login Name" is empty: a password or secret written inside a step is not kept',
      'engine',
      'the executor cannot do a step',
    ],
    ['ACTION_FAILED at S4: the click did not work', 'engine', 'the executor cannot do a step'],
    [
      'Understood, but not yet runnable. The new engine understands this test case. Running it still goes through the old parser',
      'engine',
      'understood, but the old parser still runs it',
    ],
    [
      'expected result "The system handles the whitespace": not understood: the sentence fits none of the grammar models. To fix: Say what should be true',
      'tester',
      'a sentence was not understood',
    ],
    [
      'No errors on the page. Not verified: A1 "The system handles it"; A2 "spaces are not accepted". The page showed page /x',
      'tester',
      'a check could not be verified from the page',
    ],
    ['"spaces are not accepted": unknown branch: it depends on how the application behaves', 'tester', 'the expected result depends on an unknown condition'],
  ];
  for (const [text, owner, cause] of cases)
    it(`${owner}: ${cause}`, () => {
      const c = classifyRun(text);
      assert.equal(c.owner, owner, `${text} -> ${JSON.stringify(c)}`);
      assert.ok(c.cause.includes(cause), `${c.cause}`);
    });
  it('keeps what it cannot classify visible instead of hiding it', () => {
    const c = classifyRun('something nobody has seen before');
    assert.equal(c.owner, 'engine');
    assert.ok(c.cause.startsWith('unclassified'), c.cause);
  });
});

describe('the reasons in one cell of a results sheet', () => {
  it('makes one item for each reason the cell lists', () => {
    const cell =
      'expected result "The system handles it": not understood: fits none of the grammar models To fix: Say what should be true | expected result "spaces are not accepted": unknown branch: it depends on the application';
    const out = runItems('r.xlsx', 'TC_10', cell);
    assert.deepEqual(
      out.map((i) => i.cause),
      ['a sentence was not understood', 'the expected result depends on an unknown condition'],
    );
    assert.ok(out.every((i) => i.source === 'run' && i.workbook === 'r.xlsx' && i.caseId === 'TC_10'));
  });
  it('does not turn the plain observations next to a recognised reason into reasons of their own', () => {
    const out = runItems('r.xlsx', 'TC_2', 'the login form is still shown and the page did not move | the page showed new text: "Invalid Login"');
    assert.equal(out.length, 1);
    assert.equal(out[0]?.owner, 'tester');
  });
  it('keeps one unclassified item with the whole text when nothing in the cell is recognised', () => {
    const out = runItems('r.xlsx', 'TC_3', 'something odd | something else');
    assert.equal(out.length, 1);
    assert.ok(out[0]?.cause.startsWith('unclassified'));
    assert.equal(out[0]?.message, 'something odd | something else');
  });
  it('makes no item for an empty cell', () => {
    assert.deepEqual(runItems('r.xlsx', 'TC_4', '  '), []);
  });
});

describe('what the compile finds in real sentences', () => {
  const items = async (r: RawTestCase, id = r.id ?? ''): Promise<ReviewItem[]> => compileItems('w.xlsx', id, await compileCase(r, { env: {} }));
  it('finds nothing in a case that is ready and judged', async () => {
    const out = await items(
      raw(
        'T-OK',
        ['Open the login page', "Click the 'Login' button"],
        'Login is rejected and an appropriate invalid username/password error message is displayed.',
      ),
    );
    assert.deepEqual(out, []);
  });
  it('says so when the case is understood but a check is of a type the verdict engine does not judge', async () => {
    const c = await compileCase(
      raw(
        'T-L',
        ['Open the login page', "Click the 'Login' button"],
        'Login is rejected and an appropriate invalid username/password error message is displayed.',
      ),
      { env: {} },
    );
    assert.ok(c.ir);
    const odd = {
      ...c,
      ir: { ...c.ir, expectations: c.ir.expectations.map((e, i) => (i === 0 ? { ...e, condition: { ...e.condition, type: 'LAYOUT' as const } } : e)) },
    } as CompileResult;
    const out = compileItems('w.xlsx', 'T-L', odd);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.owner, 'engine');
    assert.ok(out[0]?.cause.includes('LAYOUT'), out[0]?.cause);
  });
  it('finds the reason of a vague case, with the tester words and where it is', async () => {
    const out = await items(raw('T-V', ['Open Login page', 'Do the needful'], 'System works correctly'));
    assert.ok(out.length >= 1);
    assert.ok(out.every((i) => i.caseId === 'T-V' && i.workbook === 'w.xlsx' && i.fix.length > 0));
    assert.ok(
      out.some((i) => i.original.includes('needful')),
      JSON.stringify(out),
    );
  });
});

describe('the grouped report', () => {
  const item = (caseId: string, owner: ReviewItem['owner'], cause: string): ReviewItem => ({
    workbook: 'w.xlsx',
    caseId,
    source: 'compile',
    cause,
    owner,
    fix: 'f',
    original: `text of ${caseId}`,
    message: 'm',
  });
  const items: ReviewItem[] = [
    item('A', 'engine', 'verdict engine: LAYOUT checks'),
    item('B', 'engine', 'verdict engine: LAYOUT checks'),
    item('C', 'tester', 'ambiguous'),
    item('C', 'engine', 'verdict engine: LAYOUT checks'),
    item('D', 'data', 'missing value'),
  ];
  const report = buildReport(
    items,
    ['A', 'B', 'C', 'D', 'E'].map((id) => ({ workbook: 'w.xlsx', caseId: id })),
  );

  it('counts every item exactly once, groups biggest first, and lists the cases of a group', () => {
    assert.equal(report.items, 5);
    assert.equal(
      report.groups.reduce((n, g) => n + g.count, 0),
      5,
    );
    assert.deepEqual(
      report.groups.map((g) => [g.cause, g.count]),
      [
        ['verdict engine: LAYOUT checks', 3],
        ['ambiguous', 1],
        ['missing value', 1],
      ],
    );
    assert.deepEqual(report.groups[0]?.cases, ['w.xlsx/A', 'w.xlsx/B', 'w.xlsx/C']);
  });
  it('says how many cases wait only for engine work, how many need a tester, how many need data, and how many are fine', () => {
    assert.deepEqual(report.cases, { total: 5, ready: 1, engineOnly: 2, needsTester: 1, needsData: 1 });
  });
  it('puts a case that waits for a tester and for data with the tester, and one that waits for data and the engine with the data', () => {
    const mixed = buildReport(
      [
        item('P', 'tester', 'ambiguous'),
        item('P', 'data', 'missing value'),
        item('Q', 'data', 'missing value'),
        item('Q', 'engine', 'verdict engine: LAYOUT checks'),
      ],
      [
        { workbook: 'w.xlsx', caseId: 'P' },
        { workbook: 'w.xlsx', caseId: 'Q' },
      ],
    );
    assert.deepEqual(
      mixed.perCase.map((c) => [c.caseId, c.state]),
      [
        ['P', 'needsTester'],
        ['Q', 'needsData'],
      ],
    );
  });
  it('is the same every time', () => {
    assert.deepEqual(
      buildReport(
        [...items].reverse(),
        [...report.perCase].reverse().map((c) => ({ workbook: c.workbook, caseId: c.caseId })),
      ),
      report,
    );
  });
  it('writes the answer to "is it the implementation or the wording" at the top', () => {
    const text = reportText(report);
    assert.match(text, /5 test cases: 1 ready, 2 wait only for engine work, 1 need a tester, 1 need project data/);
    assert.ok(text.indexOf('engine work') < text.indexOf('verdict engine: LAYOUT checks'));
  });
});

describe('the real workbooks', () => {
  it('account for every review item and every case', async () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const all: ReviewItem[] = [];
    const cases: Array<{ workbook: string; caseId: string }> = [];
    for (const f of ['OrangeHRM_Login_Test_Cases_Updated.xlsx', 'Add_Employee.xlsx']) {
      const w = await readWorkbook(path.join(root, 'test/fixtures', f));
      for (const c of w.cases) {
        const id = c.raw.id ?? '';
        cases.push({ workbook: f, caseId: id });
        all.push(...compileItems(f, id, await compileCase(c.raw, {})));
      }
    }
    const r = buildReport(all, cases);
    assert.equal(r.cases.total, 29);
    assert.equal(r.cases.ready + r.cases.engineOnly + r.cases.needsTester + r.cases.needsData, 29);
    assert.equal(
      r.groups.reduce((n, g) => n + g.count, 0),
      r.items,
    );
    assert.ok(r.items > 0);
  });
});
