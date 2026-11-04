import type { IrTarget, QaIr } from '../ir/schema.js';
import { labelKey, nameWords } from '../knowledge/labels.js';
import type { Application } from '../knowledge/schema.js';
import type { Screen } from '../knowledge/screens.js';
import type { Unit } from './case.js';
import type { Issue } from './types.js';

/**
 * The lint before a run (E0.15, plan item 5). Every line of a test case gets one status, in plain words, with a suggestion when
 * the line could be written better or the engine cannot find what it names:
 *
 *   understood              read, and nothing more is known about it
 *   matched                 read, and what it names is on a screen the engine has learned (from a run or a walkthrough)
 *   not found               read, but what it names is not on the learned screen it should be on; the closest names are suggested
 *   screen not learned yet  read, but no run or walkthrough has reached its screen: a walkthrough shows it (E0.14b)
 *   vague                   read, but it leaves something open: a value to make up, or a kind of element with no name
 *   ambiguous               it can be read in more than one way, or points at something earlier that must be settled
 *   not understood          it could not be read
 *
 * Nothing is run and no page is opened: the screens are what the runs and walkthroughs saved.
 */

export type LintStatus = 'understood' | 'matched' | 'not found' | 'screen not learned yet' | 'vague' | 'ambiguous' | 'not understood';

export interface LintLine {
  /** Where the line is: `step 3`, `expected result`. */
  where: string;
  kind: Unit['kind'];
  /** The tester's own words. */
  original: string;
  status: LintStatus;
  /** Why it has that status, in plain words. */
  why: string;
  suggestion?: string;
}

/** What the lint reads of a test case: the result of reading it (understandCase) or of compiling it (compileCase). */
export interface LintInput {
  testId: string;
  ir?: QaIr;
  /** What was read when the compile stopped (CompileResult.reading): used when there is no `ir`. */
  reading?: QaIr;
  issues: readonly Issue[];
  units: readonly Unit[];
}

const AMBIGUOUS_CODES: ReadonlySet<Issue['code']> = new Set(['AMBIGUOUS', 'PARADOX', 'UNKNOWN_BRANCH', 'NEEDS_REFERENCE']);
/** Kinds of target that need no name: a message is found by what it says, a page by its address, the user is whoever logs in. */
const UNNAMED_OK: ReadonlySet<string> = new Set(['Message', 'Error', 'Validation', 'Page', 'User', 'Application', 'Record']);
/** Pages that are not a screen of their own name: where the application starts. */
const START_PAGES: ReadonlySet<string> = new Set(['application']);

const lower = (s: string): string => s.toLowerCase().split(' ').filter(Boolean).join(' ');
const nameOf = (t: IrTarget | undefined): string | undefined => t?.name ?? undefined;

/** Whether an issue is about this line: the same place, and its words are in the line (or the line's words in it). */
function about(issue: Issue, unit: Unit): boolean {
  if (issue.where !== unit.where && !(issue.where.startsWith('step') && unit.where === issue.where)) return false;
  const a = lower(issue.original);
  const b = lower(unit.original);
  return a === b || b.includes(a) || a.includes(b);
}

/** The names a screen gives its elements and itself, by label key, with the name to show. */
function namesOn(screen: Screen): Map<string, string> {
  const out = new Map<string, string>();
  const put = (n: string | undefined): void => {
    if (n?.trim()) out.set(labelKey(n), n.trim());
  };
  for (const e of screen.elements) {
    put(e.name);
    put(e.label);
    put(e.placeholder);
  }
  for (const w of screen.words) out.set(labelKey(w.word), w.means);
  for (const h of screen.headings) put(h);
  for (const row of screen.tables) for (const h of row) put(h);
  put(screen.title);
  return out;
}

/**
 * Whether a screen holds something called `name`: the same name, or a name with every word of it ("Email" is the "Email address"
 * field). The locator decides between several later; the lint only says whether the screen has it.
 */
function holds(screen: Screen, name: string): boolean {
  const key = labelKey(name);
  if (!key) return false;
  const words = nameWords(name);
  for (const [k, shown] of namesOn(screen)) {
    if (k === key) return true;
    const theirs = nameWords(shown);
    if (words.length && words.every((w) => theirs.includes(w))) return true;
  }
  return false;
}

/** What the learned screens call themselves, for a suggestion. */
const screenNames = (screens: readonly Screen[]): string[] => [...new Set(screens.map((s) => s.title ?? s.headings[0] ?? s.key).filter(Boolean))].slice(0, 4);

/** The screen a page name stands for: the one whose title or a heading is that name. */
function screenOf(screens: readonly Screen[], page: string): Screen | undefined {
  const key = labelKey(page);
  return screens.find((s) => (s.title && labelKey(s.title) === key) || s.headings.some((h) => labelKey(h) === key));
}

/** How alike two names are, 0 to 1: the words they share, then the letters (for "Employe Id" and "Employee Id"). */
function likeness(a: string, b: string): number {
  const wa = nameWords(a);
  const wb = nameWords(b);
  const shared = wa.filter((w) => wb.includes(w)).length / Math.max(wa.length, wb.length, 1);
  const x = labelKey(a);
  const y = labelKey(b);
  return Math.max(shared, 1 - editDistance(x, y) / Math.max(x.length, y.length, 1));
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** The names on the screens most like `name`, best first: what the tester may have meant. */
function closest(name: string, screens: readonly Screen[], max = 3): string[] {
  const all = new Map<string, string>();
  for (const s of screens) for (const [k, v] of namesOn(s)) all.set(k, v);
  return [...all.values()]
    .map((n) => ({ n, score: likeness(name, n) }))
    .filter((x) => x.score >= 0.5)
    .sort((p, q) => q.score - p.score)
    .slice(0, max)
    .map((x) => x.n);
}

/** The steps and checks of the IR that one line made, in order. */
function itemsOf(ir: QaIr | undefined, unit: Unit): { targets: IrTarget[]; pages: string[] } {
  const targets: IrTarget[] = [];
  const pages: string[] = [];
  if (!ir) return { targets, pages };
  const lineNo = unit.where.startsWith('step ') ? unit.where.slice('step '.length) : undefined;
  const words = lower(unit.original);
  for (const s of ir.steps) {
    const mine = lineNo !== undefined ? s.id === `S${lineNo}` || s.id.startsWith(`S${lineNo}.`) : words.includes(lower(s.original));
    if (!mine) continue;
    if (s.action === 'NAVIGATE' && s.target?.name) pages.push(s.target.name);
    else if (s.target) targets.push(s.target);
  }
  for (const e of ir.expectations) {
    if (e.automatic) continue;
    const clause = lower(e.clause.startsWith('Verify ') ? e.clause.slice('Verify '.length) : e.clause);
    if (!(words === clause || words.includes(clause) || clause.includes(words))) continue;
    if (e.condition.type === 'URL' && e.condition.target?.name) pages.push(e.condition.target.name);
    else if (e.condition.target) targets.push(e.condition.target);
  }
  return { targets, pages };
}

/**
 * Lints one test case. `knowledge` is what the engine has learned of the application; without screens, a line that was read is
 * "understood", since there is nothing to match it with.
 */
export function lintCase(input: LintInput, knowledge?: Pick<Application, 'screens'>): LintLine[] {
  const screens = knowledge?.screens ?? [];
  const known = screens.length > 0;
  /** A run or walkthrough of this very case reached some screens: a name missing from all of them is not found, not unlearned. */
  const reached = screens.some((s) => s.cases.includes(input.testId));
  /** The screen the case is on, from the last page it opened or checked; undefined at the start. */
  let page: string | undefined;
  /** Something named on the current page was found on a learned screen: the page is learned, under another name. */
  let pageSeen = false;
  const out: LintLine[] = [];
  for (const unit of input.units) {
    const base = { where: unit.where, kind: unit.kind, original: unit.original };
    const mine = input.issues.filter((i) => i.severity !== 'info' && about(i, unit));
    const first = (codes: (c: Issue['code']) => boolean) => mine.find((i) => codes(i.code));
    const blocking = mine.find((i) => i.severity === 'blocking');
    if (!unit.understood || blocking) {
      const i = blocking ?? mine[0];
      out.push({
        ...base,
        status: 'not understood',
        why: i?.message ?? 'nothing could be read from it',
        ...(i?.suggestion ? { suggestion: i.suggestion } : {}),
      });
      continue;
    }
    const unclear = first((c) => AMBIGUOUS_CODES.has(c) || c === 'NOT_UNDERSTOOD' || c === 'UNSUPPORTED');
    if (unclear) {
      out.push({ ...base, status: 'ambiguous', why: unclear.message, ...(unclear.suggestion ? { suggestion: unclear.suggestion } : {}) });
      continue;
    }
    const missing = first((c) => c === 'MISSING_DATA');
    const { targets, pages } = itemsOf(input.ir ?? input.reading, unit);
    const unnamed = targets.find((t) => !t.name && !UNNAMED_OK.has(t.ontology ?? ''));
    if (missing || unnamed) {
      out.push({
        ...base,
        status: 'vague',
        why: missing ? missing.message : `it names a kind of element ("${unnamed?.label ?? unnamed?.ontology}"), not which one`,
        suggestion: missing?.suggestion ?? `Name it as the screen shows it: the '<name>' ${(unnamed?.ontology ?? 'element').toLowerCase()}.`,
      });
      continue;
    }
    // The pages it opens or checks: each is a screen the engine knows, or one no run has reached yet.
    let line: LintLine | undefined;
    for (const p of pages) {
      pageSeen = false;
      if (START_PAGES.has(labelKey(p))) {
        page = undefined;
        continue;
      }
      page = p;
      if (!known) continue;
      // A screen is known by what it calls itself; the tester's name for it ("Book Market Home") is often another. Until a person ties
      // the two in a walkthrough, the screen is not learned under that name.
      line = screenOf(screens, p)
        ? { ...base, status: 'matched', why: `the "${p}" screen is known from a run or a walkthrough` }
        : {
            ...base,
            status: 'screen not learned yet',
            why: `no learned screen is called "${p}"`,
            suggestion: `If it is one of the learned screens (${screenNames(screens)
              .map((n) => `'${n}'`)
              .join(', ')}), name it in a walkthrough; otherwise run this case once so the engine learns it.`,
          };
    }
    if (known && targets.some((t) => nameOf(t))) {
      const here = page ? screenOf(screens, page) : undefined;
      const named = targets.filter((t) => nameOf(t)).map((t) => nameOf(t) as string);
      const lost = named.filter((n) => !screens.some((s) => holds(s, n)));
      if (lost.length < named.length) pageSeen = true;
      if (!lost.length)
        line = { ...base, status: 'matched', why: `${named.map((n) => `"${n}"`).join(', ')} ${named.length > 1 ? 'are' : 'is'} on a learned screen` };
      else if (page && !here && !pageSeen)
        line = {
          ...base,
          status: 'screen not learned yet',
          why: `"${lost[0]}" is on the "${page}" screen, and no learned screen is called that`,
          suggestion: 'Run this case once, or show the screen in a walkthrough, so the engine learns it.',
        };
      else if (!page && !reached)
        line = {
          ...base,
          status: 'screen not learned yet',
          why: `"${lost[0]}" is on a screen no run of this case has reached yet`,
          suggestion: 'Run this case once, or show the screen in a walkthrough, so the engine learns it.',
        };
      else {
        const near = closest(lost[0] as string, here ? [here] : screens);
        line = {
          ...base,
          status: 'not found',
          why: `"${lost[0]}" is not on ${here ? `the "${page}" screen` : 'any screen the engine has learned'}`,
          suggestion: near.length
            ? `Did you mean ${near.map((n) => `'${n}'`).join(' or ')}? Write the name as the screen shows it.`
            : 'Write the name as the screen shows it, or show it in a walkthrough.',
        };
      }
    }
    out.push(line ?? { ...base, status: 'understood', why: known ? 'read; nothing it names needs a screen' : 'read; no screens learned yet to match it with' });
  }
  return out;
}

const MARK: Readonly<Record<LintStatus, string>> = {
  understood: '✓',
  matched: '✓',
  'not found': '✗',
  'screen not learned yet': '…',
  vague: '?',
  ambiguous: '?',
  'not understood': '✗',
};

const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** The lint of one case as text: one line per line of the case, with the suggestion under it. For a results workbook cell. */
export function lintText(lines: readonly LintLine[]): string {
  return lines
    .map(
      (l) =>
        `${MARK[l.status]} ${l.where} "${short(l.original)}": ${l.status}${l.status === 'understood' || l.status === 'matched' ? '' : ` (${l.why})`}${l.suggestion ? `\n    → ${l.suggestion}` : ''}`,
    )
    .join('\n');
}

/** How many lines have each status. */
export function lintCounts(lines: readonly LintLine[]): Record<LintStatus, number> {
  const counts = { understood: 0, matched: 0, 'not found': 0, 'screen not learned yet': 0, vague: 0, ambiguous: 0, 'not understood': 0 };
  for (const l of lines) counts[l.status]++;
  return counts;
}
