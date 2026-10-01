import type { ManifestTest } from '../generator/plan.js';
import type { AssertionType } from '../model/test-model.js';
import { passedText } from '../validations/registry.js';

/**
 * Result validator (FR-VAL-01…05, FR-FC-01 basic labels): what the reporter recorded + what the
 * tester wrote → a verdict with expected and actual for every check. Pure and deterministic.
 */

export type Status = 'PASS' | 'FAIL' | 'BLOCKED' | 'NEEDS REVIEW';
export type Category = 'Assertion' | 'Locator' | 'Application' | 'Network' | 'Environment' | 'Timeout' | 'Test Data' | 'Authentication';

/** What the generated reporter writes per test (reporters/auto-qa-reporter.ts). */
export interface ReportedTest {
  testId: string;
  automationId?: string;
  title: string;
  status: string;
  expectedStatus: string;
  duration: number;
  startedAt: string;
  steps: Array<{ title: string; status: 'passed' | 'failed'; duration: number; error?: string }>;
  errors: string[];
  facts?: PageFacts;
  screenshots: string[];
  /** The page after each step (FR-EV-01). Missing in results from older runs. */
  stepScreenshots?: Array<{ step: string; file: string }>;
  trace?: string;
  video?: string;
}

export interface PageFacts {
  url: string;
  path: string;
  title: string;
  headings: string[];
  messages: string[];
  invalid: string[];
  problems: string[];
  /** Browser pop-ups the page showed, e.g. `alert "Saved!"`; each was accepted. */
  dialogs?: string[];
}

export interface CheckVerdict {
  id: string;
  raw: string;
  expected: string;
  actual: string;
  result: 'passed' | 'failed' | 'not run' | 'not checked';
}

export interface StepVerdict {
  id: string;
  raw: string;
  result: 'passed' | 'failed' | 'not run';
  durationMs?: number;
  /** The page when the step ended (a kept file). */
  screenshot?: string;
  /** What went wrong, for a failed step. */
  error?: string;
}

/** One thing that needs the tester, in plain words (see explorer/explain.ts). */
export interface ReviewReason {
  id: string;
  raw: string;
  headline: string;
  why: string;
  todo: string[];
}

export interface TestVerdict {
  executionId: string;
  /** Decisions the platform made that the tester did not state (made-up values, learned messages): PASS (with assumptions). */
  assumptions?: string[];
  testId: string;
  title: string;
  automationId: string;
  status: Status;
  category?: Category;
  /** e.g. `S4 Click Login` or `A1 User is redirected to Dashboard page`. */
  failedStep?: string;
  /** One line for the report and the results sheet. */
  reason: string;
  /** For NEEDS REVIEW: each thing to fix, with what happened and what to do (FR-RV). */
  review?: ReviewReason[];
  expected: string;
  actual: string;
  steps: StepVerdict[];
  checks: CheckVerdict[];
  durationMs: number;
  startedAt?: string;
  evidence: { screenshots: string[]; trace?: string; video?: string; facts?: PageFacts };
  error?: string;
}

export interface VerdictContext {
  executionId: string;
  /** Environment variables the test needs that are not set: the test is BLOCKED without running. */
  missingEnv?: string[];
  /** Why no test ran at all, from Playwright's output. */
  runError?: string;
}

export function verdictFor(test: ManifestTest, reported: ReportedTest | undefined, ctx: VerdictContext): TestVerdict {
  const base = {
    executionId: ctx.executionId,
    testId: test.testId,
    title: test.title,
    automationId: test.automationId,
    expected: test.checks
      .map((c) => c.raw)
      .filter(Boolean)
      .join(' '),
  };
  const notRun = {
    steps: test.steps.map((s) => ({ id: s.id, raw: s.raw, result: 'not run' as const })),
    checks: test.checks.map((c) => ({ id: c.id, raw: c.raw, expected: expectedOf(c), actual: '', result: 'not run' as const })),
    durationMs: 0,
    evidence: { screenshots: [] },
  };

  if (ctx.missingEnv?.length) {
    const reason = `Set ${ctx.missingEnv.join(', ')} in the environment or the workspace's .env.`;
    return { ...base, ...notRun, status: 'BLOCKED', category: 'Test Data', reason, actual: `Not run: ${reason}` };
  }
  if (!reported) {
    const reason = ctx.runError ? `The test did not run: ${ctx.runError}` : 'The test did not run (see the runner output).';
    return { ...base, ...notRun, status: 'BLOCKED', category: 'Environment', reason, actual: `Not run: ${reason}` };
  }

  const facts = reported.facts;
  const records = reported.steps.map((s) => ({ ...s, ...labelOf(s.title) }));
  const failedRecord = records.find((r) => r.status === 'failed');
  const passedIds = new Set(records.filter((r) => r.status === 'passed' && !r.setup).flatMap((r) => r.ids));
  const failedIds = new Set(failedRecord && !failedRecord.setup ? failedRecord.ids : []);
  const unparsed = new Set(test.unparsed);
  // Playwright may prefix the message ("Error: Health check failed: …"); keep just the problems.
  const healthError = reported.errors.map((e) => /Health check failed: (.*)/.exec(e)?.[1]).find((x): x is string => !!x);
  const firstError = failedRecord?.error ?? reported.errors[0];

  const shotOf = (id: string) => reported.stepScreenshots?.find((x) => labelOf(x.step).ids.includes(id) && !x.step.startsWith('Precondition · '))?.file;
  const steps: StepVerdict[] = test.steps.map((s) => {
    const record = records.find((r) => !r.setup && r.ids.includes(s.id));
    return {
      id: s.id,
      raw: s.raw,
      result: passedIds.has(s.id) ? ('passed' as const) : failedIds.has(s.id) ? ('failed' as const) : ('not run' as const),
      durationMs: record?.duration,
      screenshot: shotOf(s.id),
      error: failedIds.has(s.id) ? record?.error : undefined,
    };
  });
  const checks: CheckVerdict[] = test.checks.map((c) => {
    const expected = expectedOf(c);
    if (unparsed.has(c.id)) return { id: c.id, raw: c.raw, expected, actual: 'Not checked: the expected result could not be read.', result: 'not checked' };
    if (c.type === 'health') {
      const ok = !healthError && reported.status !== 'skipped';
      return {
        id: c.id,
        raw: c.raw || 'No crash',
        expected,
        actual: ok ? 'No errors on the page' : (healthError ?? ''),
        result: ok ? 'passed' : healthError ? 'failed' : 'not run',
      };
    }
    if (failedIds.has(c.id)) return { id: c.id, raw: c.raw, expected, actual: actualFromError(c, failedRecord?.error ?? '', facts), result: 'failed' };
    if (passedIds.has(c.id)) return { id: c.id, raw: c.raw, expected, actual: actualWhenPassed(c), result: 'passed' };
    return { id: c.id, raw: c.raw, expected, actual: '', result: 'not run' };
  });

  const common = {
    ...base,
    steps,
    checks,
    durationMs: reported.duration,
    startedAt: reported.startedAt,
    evidence: {
      screenshots: reported.screenshots,
      trace: reported.trace,
      video: reported.video,
      facts,
    },
    error: firstError,
  };
  const failedLabel = failedRecord ? failedRecord.title.replace(/^Precondition · /, '') : undefined;
  const pageSummary = describePage(facts);

  if (reported.status === 'passed' || reported.status === reported.expectedStatus) {
    if (unparsed.size) {
      const ids = [...unparsed].join(', ');
      return {
        ...common,
        status: 'NEEDS REVIEW',
        reason: `${ids} could not be read, so the result is not known. Rewrite ${unparsed.size > 1 ? 'them' : 'it'} and run again.`,
        actual: summary(checks),
      };
    }
    const assumptions = test.assumptions?.length ? test.assumptions : undefined;
    return {
      ...common,
      status: 'PASS',
      assumptions,
      reason: assumptions ? 'Every check passed, with assumptions (listed).' : 'Every check passed.',
      actual: summary(checks) + (assumptions ? ` Assumed or learned: ${assumptions.join(' ')}` : ''),
    };
  }

  const category = classify(firstError ?? '', failedRecord, healthError, reported.status);
  const blocked = category === 'Network' || category === 'Environment' || category === 'Test Data' || category === 'Authentication';
  // A script error is not the application's doing, so it says nothing about the check it happened in.
  const failedCheck = SCRIPT_ERROR.test(firstError ?? '') ? undefined : checks.find((c, i) => c.result === 'failed' && test.checks[i].type !== 'health');
  const actual = failedCheck
    ? failedCheck.actual
    : healthError
      ? `The page had errors: ${healthError}.${pageSummary ? ` ${pageSummary}` : ''}`
      : `${failedLabel ? `"${failedLabel}" could not be done: ` : ''}${firstLine(firstError)}.${pageSummary ? ` ${pageSummary}` : ''}`;
  return {
    ...common,
    status: blocked ? 'BLOCKED' : 'FAIL',
    category,
    failedStep: failedLabel,
    reason: reasonFor(category, failedLabel, firstError),
    actual,
  };
}

/** "S2, S3, S4: Enter …" → [S2, S3, S4]; "Precondition · S1: …" is setup. */
function labelOf(title: string): { ids: string[]; setup: boolean } {
  const setup = title.startsWith('Precondition · ');
  const head = title.replace(/^Precondition · /, '').split(':')[0];
  return { ids: head.split(/\s*,\s*/).filter((x) => /^[SA]\d+$/.test(x)), setup };
}

function classify(error: string, failed: ReturnType<typeof labelOf> | undefined, healthError: string | undefined, status: string): Category {
  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(error)) return 'Network';
  if (/Executable doesn't exist|Failed to launch|browserType\.launch|Chromium distribution .* is not found/i.test(error)) return 'Environment';
  if (/expected string, got undefined|Unknown generator/i.test(error)) return 'Test Data';
  if (SCRIPT_ERROR.test(error)) return 'Environment';
  if (healthError && !failed) return 'Application';
  if (failed?.setup) return 'Authentication';
  if (failed?.ids.some((id) => id.startsWith('A'))) return 'Assertion';
  if (status === 'timedOut' || /Test timeout of \d+ms exceeded/.test(error)) return 'Timeout';
  if (/waiting for (getBy|locator)|element\(s\) not found|strict mode violation|resolved to \d+ elements/i.test(error)) return 'Locator';
  if (healthError) return 'Application';
  return 'Application';
}

/** An error in the generated test code itself, not in the application under test. */
const SCRIPT_ERROR = /^(ReferenceError|TypeError|SyntaxError)\b|is not a function|is not defined/m;

function reasonFor(category: Category, step?: string, error?: string): string {
  if (category === 'Environment' && error && SCRIPT_ERROR.test(error)) {
    return `The generated test has an error (a problem in Auto QA, not in the application): ${firstLine(error)}. Generate it again or report it.`;
  }
  const at = step ? ` at ${step.split(':')[0]}` : '';
  switch (category) {
    case 'Assertion':
      return `A check failed${at}: the application did not do what the test case expects.`;
    case 'Locator':
      return `An element was not found${at}. The page may have changed (re-discover it) or it may be a defect.`;
    case 'Application':
      return `The application showed an error${at}.`;
    case 'Timeout':
      return `The test ran out of time${at}.`;
    case 'Network':
      return 'The application could not be reached.';
    case 'Environment':
      return 'The browser could not be started.';
    case 'Test Data':
      return 'A value the test needs is missing.';
    case 'Authentication':
      return 'The login needed by the precondition did not work.';
  }
}

type Check = ManifestTest['checks'][number];

function expectedOf(c: Check): string {
  return c.raw || (c.type === 'health' ? 'No errors on the page' : '');
}

function actualWhenPassed(c: Check): string {
  const not = c.negated ? ' not' : '';
  const what = c.target ?? c.expected ?? '';
  switch (c.type) {
    case 'url':
      return c.negated ? `Did not go to ${what}` : `Went to ${c.expected ?? 'the expected page'}${/page$/i.test(c.expected ?? '') ? '' : ' page'}`;
    case 'url-unchanged':
      return `Stayed on ${c.expected ? `the ${c.expected} page` : 'the same page'}`;
    case 'visible':
      return `"${what}" was${not} visible`;
    case 'text':
      return `"${c.expected}" was${not} shown`;
    case 'enabled':
      return `"${what}" was${not} enabled`;
    case 'disabled':
      return `"${what}" was${not} disabled`;
    case 'checked':
      return `"${what}" was${not} checked`;
    case 'value':
      return `"${what}" had${c.negated ? ' not' : ''} the value "${c.expected}"`;
    default:
      // The checks of the validation catalogue say it themselves (src/validations).
      return (
        passedText({
          type: c.type as AssertionType,
          target: c.target,
          expected: c.expected ?? c.learned,
          negated: c.negated,
          options: c.options,
          other: c.other ? { target: c.other, alternatives: [] } : undefined,
        }) ?? 'As expected'
      );
  }
}

/** Turns Playwright's assertion error into what the page actually showed (FR-VAL-02). */
function actualFromError(c: Check, error: string, facts?: PageFacts): string {
  // The checks of the validation catalogue write "Actual: …" themselves, with what they measured.
  const told = /^\s*Actual:\s*(.+)$/m.exec(error)?.[1]?.trim();
  if (told) return `${told.replace(/\.$/, '')}.`;
  const received = /Received(?: string| value)?:\s*"?([^"\n]*)"?/.exec(error)?.[1]?.trim();
  const what = c.target ?? c.expected ?? '';
  let specific: string;
  if (/element\(s\) not found/.test(error)) specific = c.type === 'text' ? `"${c.expected}" was not shown` : `"${what}" was not found`;
  else if (c.type === 'url' || c.type === 'url-unchanged')
    specific = received !== undefined ? `Page was ${received || '(empty)'}` : `Page was ${facts?.path ?? 'unknown'}`;
  else if (received !== undefined && received !== '') specific = `"${what}" was ${received}`;
  else specific = firstLine(error);
  const page = describePage(facts, c.type === 'url' || c.type === 'url-unchanged');
  return `${specific}.${page ? ` ${page}` : ''}`;
}

/** "The page showed heading "Sign in"; message "Invalid username or password"." */
function describePage(facts?: PageFacts, skipPath = false): string {
  if (!facts) return '';
  const parts: string[] = [];
  if (!skipPath) parts.push(`page ${facts.path}`);
  if (facts.headings[0]) parts.push(`heading "${facts.headings[0]}"`);
  for (const m of facts.messages.slice(0, 2)) parts.push(`message "${m}"`);
  for (const v of facts.invalid.slice(0, 1)) parts.push(`field error "${v}"`);
  return parts.length ? `The page showed ${parts.join('; ')}.` : '';
}

function summary(checks: CheckVerdict[]): string {
  return checks
    .filter((c) => c.result === 'passed' || c.result === 'not checked')
    .map((c) => c.actual)
    .join('. ')
    .concat('.')
    .replace(/\.\.$/, '.');
}

function firstLine(text?: string): string {
  return (
    (text ?? 'unknown error')
      .split('\n')
      .find((l) => l.trim())
      ?.trim()
      .replace(/\.$/, '') ?? 'unknown error'
  );
}
