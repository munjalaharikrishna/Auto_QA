import type { CompileResult } from '../engine/index.js';
import { reasonOf } from '../engine/language/coverage.js';
import type { Issue } from '../engine/language/types.js';
import { semanticSupport } from './semantic-run.js';

/**
 * The grouped review report. Every reason a test case is set aside, from the compile (before any browser) and from a run (the
 * results sheet), grouped by cause and labelled with who can fix it:
 *
 *   engine  code has to change (a sentence the engine cannot read and has no better wording for, a check the verdict engine does
 *           not judge, a step the executor cannot do, the old parser that still runs the case)
 *   tester  a person has to say something: reword a sentence, name one of two alternatives, state the expected message
 *   data    a value or an element the project has to supply
 *
 * It answers one question: is the review caused by the engine not being finished, or by the way the cases are written? A case
 * "waits only for engine work" when every one of its reasons is the engine's. The owner of a reason is a rule, stated here and
 * not guessed: a sentence the engine does not understand is the tester's when it has a clearer wording to offer, else the engine's.
 */

export type Owner = 'engine' | 'tester' | 'data';

export interface Classified {
  cause: string;
  owner: Owner;
  fix: string;
}

export interface ReviewItem extends Classified {
  workbook: string;
  caseId: string;
  /** Found when the case was compiled, or when it was run. */
  source: 'compile' | 'run';
  /** The tester's words the reason is about. */
  original: string;
  /** What the engine said. */
  message: string;
}

/** A compile-time reason, and who can fix it. */
export function classifyIssue(issue: Pick<Issue, 'code' | 'message' | 'suggestion'>): Classified {
  const cause = reasonOf(issue);
  const clearer = issue.suggestion ? `Reword it: ${issue.suggestion}` : undefined;
  switch (issue.code) {
    case 'NOT_UNDERSTOOD':
    case 'UNSUPPORTED':
      return clearer
        ? { cause, owner: 'tester', fix: clearer }
        : { cause, owner: 'engine', fix: 'Teach the language layers this sentence (grammar or vocabulary); no clearer wording is known.' };
    case 'AMBIGUOUS':
      return { cause, owner: 'tester', fix: clearer ?? 'Say which one is meant, or what exactly should be true.' };
    case 'UNKNOWN_BRANCH':
      return { cause, owner: 'tester', fix: clearer ?? 'State the expected result for each outcome, or the test data that decides it.' };
    case 'PARADOX':
      return { cause, owner: 'tester', fix: clearer ?? 'The sentence asks for something that cannot be done; rewrite it.' };
    case 'NOT_CHECKED':
      return { cause, owner: 'tester', fix: clearer ?? 'A note is kept and never verified; make it a check or remove it.' };
    case 'MISSING_DATA':
      return { cause, owner: 'data', fix: 'Give the value in Test Data, an environment variable or the credential store.' };
    case 'NEEDS_REFERENCE':
      return { cause, owner: 'engine', fix: 'Resolve the reference to the earlier step it points at.' };
  }
}

const NOT_JUDGED = (type: string): Classified => ({
  cause: `verdict engine: ${type} checks are not judged yet`,
  owner: 'engine',
  fix: `Teach the verdict engine to judge ${type} checks; until then the case cannot be run through it.`,
});

/** What a compiled case still has against it. An empty list is a case that is understood and that the verdict engine can judge. */
export function compileItems(workbook: string, caseId: string, compile: CompileResult): ReviewItem[] {
  const at = { workbook, caseId, source: 'compile' as const };
  if (compile.status === 'error') {
    return [
      {
        ...at,
        cause: 'engine fault: a compile stage failed',
        owner: 'engine',
        fix: 'A stage broke its contract; this is a defect.',
        original: '',
        message: compile.error ?? compile.stage ?? '',
      },
    ];
  }
  const issues = compile.issues.filter((i) => i.severity !== 'info');
  if (issues.length > 0) return issues.map((i) => ({ ...at, ...classifyIssue(i), original: i.original, message: `${i.where}: ${i.message}` }));
  const support = semanticSupport(compile);
  if (support.ok) return [];
  const type = /is a ([A-Z_]+) check/.exec(support.why)?.[1];
  const c: Classified = type
    ? NOT_JUDGED(type)
    : {
        cause: 'verdict engine: the case cannot be run through it',
        owner: 'engine',
        fix: 'See the reason; the case compiled but the verdict engine cannot take it.',
      };
  return [{ ...at, ...c, original: '', message: support.why }];
}

const PATTERNS: Array<[RegExp, (text: string) => Classified]> = [
  [
    /the page showed new text/i,
    () => ({
      cause: 'a message was shown in other words than the expected result',
      owner: 'tester',
      fix: 'State the exact message in the expected result, or decide PASS once on the review card so the engine remembers it.',
    }),
  ],
  [
    /VALUE_UNRESOLVED|LOCATE_|LOCATOR_NOT_UNIQUE|ROW_|UNSUPPORTED_ACTION|ACTION_FAILED|TOOL_MISSING|PAGE_UNKNOWN|FILE_/,
    () => ({
      cause: 'the executor cannot do a step',
      owner: 'engine',
      fix: 'Support the step in the executor (for example "leave blank"), or reword the step.',
    }),
  ],
  [
    /not yet runnable|switch-over/i,
    () => ({
      cause: 'understood, but the old parser still runs it',
      owner: 'engine',
      fix: 'Run it through the new engine (E1.0 switch-over), or add the check type to the verdict engine.',
    }),
  ],
  [
    /Not verified:/,
    () => ({
      cause: 'a check could not be verified from the page',
      owner: 'tester',
      fix: 'Say what should be true on the screen (a message, a heading, an address), so that it can be checked.',
    }),
  ],
  [
    /unknown branch/i,
    () => ({
      cause: 'the expected result depends on an unknown condition',
      owner: 'tester',
      fix: 'State the expected result for each outcome, or the data that decides it.',
    }),
  ],
  [
    /not understood|fits none of the grammar/i,
    (text) =>
      /To fix:|Say |Try:/.test(text)
        ? { cause: 'a sentence was not understood', owner: 'tester', fix: 'Reword it as the review suggests.' }
        : { cause: 'a sentence was not understood (no clearer wording is known)', owner: 'engine', fix: 'Teach the language layers this sentence.' },
  ],
  [
    /(?:^|[\s:])(?:A|E)\d+\s+"[^"]*":\s*(?:More than one element|I could not find)/,
    () => ({
      cause: 'an expected result was searched for as an element',
      owner: 'engine',
      fix: 'The old parser reads the outcome as something to click; run the expected result through the verdict engine (E1.0 switch-over).',
    }),
  ],
  [
    /(?:^|[\s:])S\d+\s+"[^"]*":\s*I could not find/,
    () => ({
      cause: 'an element a step names is not on the page',
      owner: 'data',
      fix: 'Name the element as the page shows it, or give the application knowledge.',
    }),
  ],
  [
    /(?:^|[\s:])S\d+\s+"[^"]*":\s*More than one element/,
    () => ({
      cause: 'a step names more than one element',
      owner: 'data',
      fix: 'Name the section or the button text, or pick the right one on the screenshot once.',
    }),
  ],
];

/** A reason found in a run (the text of the results sheet), and who can fix it. What nothing recognises is shown, never dropped. */
export function classifyRun(text: string): Classified {
  for (const [pattern, make] of PATTERNS) if (pattern.test(text)) return make(text);
  return {
    cause: `unclassified: ${text.replace(/"[^"]*"/g, '"…"').slice(0, 90)}`,
    owner: 'engine',
    fix: 'Read the reason and add a rule for it here.',
  };
}

/**
 * The reasons in one cell of a results sheet, as items. A cell lists its reasons joined by " | ", and next to them can be plain
 * observations ("the login form is still shown"): those are not reasons, so they are dropped when at least one part is recognised.
 * When none is, the whole text is kept as one unclassified item, so nothing is lost.
 */
export function runItems(workbook: string, caseId: string, text: string): ReviewItem[] {
  const whole = text.trim();
  if (!whole) return [];
  const make = (message: string, c: Classified): ReviewItem => ({ workbook, caseId, source: 'run', ...c, original: '', message });
  const parts = whole
    .split(' | ')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ p, c: classifyRun(p) }));
  const known = parts.filter((x) => !x.c.cause.startsWith('unclassified'));
  return known.length > 0 ? known.map((x) => make(x.p, x.c)) : [make(whole, classifyRun(whole))];
}

export interface ReviewGroup extends Classified {
  count: number;
  /** `workbook/case`, sorted. */
  cases: string[];
  examples: Array<{ case: string; original: string; message: string }>;
}

export type CaseState = 'ready' | 'engineOnly' | 'needsTester' | 'needsData';

export interface ReviewReport {
  items: number;
  cases: { total: number; ready: number; engineOnly: number; needsTester: number; needsData: number };
  perCase: Array<{ workbook: string; caseId: string; state: CaseState; owners: Owner[] }>;
  groups: ReviewGroup[];
}

const keyOf = (workbook: string, caseId: string): string => `${workbook}/${caseId}`;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Groups the items. A case waits for a person if any of its reasons is the tester's, then for data, and otherwise only for the engine. */
export function buildReport(items: readonly ReviewItem[], cases: ReadonlyArray<{ workbook: string; caseId: string }>): ReviewReport {
  const sorted = [...items].sort(
    (a, b) =>
      cmp(keyOf(a.workbook, a.caseId), keyOf(b.workbook, b.caseId)) || cmp(a.cause, b.cause) || cmp(a.original, b.original) || cmp(a.message, b.message),
  );
  const groups = new Map<string, ReviewGroup>();
  for (const i of sorted) {
    const k = `${i.owner}|${i.cause}`;
    const g = groups.get(k) ?? { cause: i.cause, owner: i.owner, fix: i.fix, count: 0, cases: [], examples: [] };
    g.count++;
    const c = keyOf(i.workbook, i.caseId);
    if (!g.cases.includes(c)) g.cases.push(c);
    if (g.examples.length < 3) g.examples.push({ case: c, original: i.original, message: i.message });
    groups.set(k, g);
  }
  const owners = new Map<string, Set<Owner>>();
  for (const i of items) owners.set(keyOf(i.workbook, i.caseId), (owners.get(keyOf(i.workbook, i.caseId)) ?? new Set()).add(i.owner));
  const perCase = [...cases]
    .sort((a, b) => cmp(keyOf(a.workbook, a.caseId), keyOf(b.workbook, b.caseId)))
    .map((c) => {
      const o = owners.get(keyOf(c.workbook, c.caseId));
      const state: CaseState = !o ? 'ready' : o.has('tester') ? 'needsTester' : o.has('data') ? 'needsData' : 'engineOnly';
      return { ...c, state, owners: [...(o ?? [])].sort() };
    });
  const count = (s: CaseState): number => perCase.filter((c) => c.state === s).length;
  return {
    items: items.length,
    cases: { total: perCase.length, ready: count('ready'), engineOnly: count('engineOnly'), needsTester: count('needsTester'), needsData: count('needsData') },
    perCase,
    groups: [...groups.values()].sort((a, b) => b.count - a.count || cmp(a.cause, b.cause) || cmp(a.owner, b.owner)),
  };
}

const OWNER_WORDS: Record<Owner, string> = { engine: 'ENGINE', tester: 'TESTER', data: 'DATA' };

export function reportText(r: ReviewReport, { examples = true }: { examples?: boolean } = {}): string {
  const lines = [
    `${r.cases.total} test cases: ${r.cases.ready} ready, ${r.cases.engineOnly} wait only for engine work, ${r.cases.needsTester} need a tester, ${r.cases.needsData} need project data`,
    '',
    `${r.items} review reason(s), grouped by cause (ENGINE = code to change, TESTER = a person must say something, DATA = the project must supply it):`,
  ];
  for (const g of r.groups) {
    lines.push(
      '',
      `  ${String(g.count).padStart(3)}  [${OWNER_WORDS[g.owner]}] ${g.cause}`,
      `       fix: ${g.fix}`,
      `       cases: ${g.cases.length > 6 ? `${g.cases.slice(0, 6).join(', ')} … (${g.cases.length})` : g.cases.join(', ')}`,
    );
    if (examples) for (const e of g.examples.slice(0, 2)) lines.push(`       e.g. ${e.case}: ${(e.original || e.message).slice(0, 140)}`);
  }
  return lines.join('\n');
}
