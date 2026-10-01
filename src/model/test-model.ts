import { z } from 'zod';

/**
 * The Structured Test Model (ARCHITECTURE.md §10, FR-PA-01).
 *
 * Every imported test case becomes one of these before any browser opens.
 * Exploration, generation and review all work from this model, never from the raw text.
 */

/** A test case as the tester wrote it (SPEC §5). Importers produce this; the parser consumes it. */
export const RawTestCaseSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  type: z.string().optional(),
  preconditions: z.string().optional(),
  /** All steps in one cell, e.g. "1. Open Home page\n2. Click Login". */
  steps: z.string().min(1),
  /** `key=value` pairs, one per line or `;`-separated. */
  testData: z.string().optional(),
  expected: z.string().min(1),
  requirementId: z.string().optional(),
  /** Spreadsheet row, for messages and generated ids. */
  row: z.number().int().positive().optional(),
});
export type RawTestCase = z.infer<typeof RawTestCaseSchema>;

/** Where a step's value comes from (FR-PA-10). Secrets are always `env`, never `literal`. */
export const ValueRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('env'), name: z.string() }),
  z.object({ kind: z.literal('data'), key: z.string() }),
  /** e.g. `unique.email`, `unique.number`, `today` (FR-TD-04). */
  z.object({ kind: z.literal('generator'), name: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRefSchema>;

export const ACTIONS = ['navigate', 'back', 'forward', 'refresh', 'fill', 'clear', 'click', 'select', 'check', 'uncheck', 'hover', 'upload', 'press'] as const;
export type Action = (typeof ACTIONS)[number];

export const STATUSES = ['parsed', 'unparsed'] as const;

const TargetFields = {
  /** The element's visible name, e.g. `Login`. */
  target: z.string().optional(),
  /** Other names the tester gave, e.g. "Apply to the Network (or Apply)" → ["Apply"] (FR-PA-04). */
  alternatives: z.array(z.string()),
  /** The tester quoted the name, so it should match exactly. */
  exact: z.boolean().optional(),
  /** Role word the tester used, as an ARIA role (`button`, `textbox`…) or `page` (FR-PA-03). */
  roleHint: z.string().optional(),
  /** The name is a part of the page ("login form", "login section"): look for the form, region or table holding it. */
  container: z.boolean().optional(),
};

export const StepSchema = z.object({
  /** `S<n>`, where n is the tester's own step number (FR-GE-03). */
  id: z.string(),
  /** Missing when the step is unparsed. */
  action: z.enum(ACTIONS).optional(),
  ...TargetFields,
  value: ValueRefSchema.optional(),
  /** navigate: a full URL or a path such as `/login`. */
  url: z.string().optional(),
  /** navigate: the environment's BASE_URL exactly as set, path included ("Enter the URL", "Open the application"). */
  baseUrl: z.boolean().optional(),
  /** navigate: a page name such as `Home`, resolved to a URL per environment (FR-ENV-03). */
  page: z.string().optional(),
  /** press: a Playwright key name such as `Enter` or `Control+A`. */
  key: z.string().optional(),
  raw: z.string(),
  status: z.enum(STATUSES),
  /** Why the step is unparsed: a code and advice for the tester (FR-PA-11). */
  reason: z.object({ code: z.string(), text: z.string() }).optional(),
});
export type Step = z.infer<typeof StepSchema>;

/** The checks written in the first versions: see VALIDATIONS.md for the whole catalogue. */
const CORE_ASSERTIONS = ['url', 'url-unchanged', 'visible', 'text', 'enabled', 'disabled', 'checked', 'value', 'health'] as const;

/**
 * Every other check type (VALIDATIONS.md §7). Each is one module in src/validations/, with the words a
 * tester writes it in, the Playwright code it becomes and the sentence it reports.
 */
export const EXTRA_ASSERTIONS = [
  // A. page and navigation
  'title',
  'query-param',
  'new-tab',
  'href',
  'link-safe',
  'selected',
  // B. element presence and state
  'attached',
  'editable',
  'focused',
  'count',
  'empty',
  'in-viewport',
  'clickable',
  'expanded',
  'attribute',
  // C. text and content
  'exact-text',
  'contains-text',
  'text-pattern',
  'text-list',
  'selected-option',
  'options',
  'placeholder',
  'tooltip',
  'accessible-name',
  'today',
  'truncated',
  // D. forms
  'invalid',
  'field-error',
  'validation-message',
  'max-length',
  'suggestions',
  // E. messages, dialogs, loading
  'alert',
  'toast',
  'dialog',
  'dialog-content',
  'focus-in-dialog',
  'browser-dialog',
  'loading-done',
  // F. layout and visual
  'centered',
  'region',
  'relative-position',
  'aligned',
  'overlap',
  'size',
  'same-size',
  'css',
  'sticky',
  'images-loaded',
  'structure',
  'layout-shift',
  // G. tables and lists
  'table-headers',
  'row-count',
  'row-cell',
  'sorted',
  'every-row',
  'pagination',
  'no-duplicates',
  // H. network and I. health
  'request',
  'console-clean',
  'not-blank',
  'no-mixed-content',
  // J, K. session and storage
  'cookie',
  'cookie-flags',
  'storage',
  // L. accessibility
  'fields-labelled',
  'images-alt',
  'tab-order',
  // M, N, O, P. performance, files, data, timing
  'load-time',
  'web-vitals',
  'download',
  'sum',
  'matches-count',
  'value-changes',
] as const;

export const ASSERTION_TYPES = [...CORE_ASSERTIONS, ...EXTRA_ASSERTIONS] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

/** Settings a check can carry (VALIDATIONS.md §2.3, §7). Only the ones a type uses are set. */
export const AssertionOptionsSchema = z.object({
  /** Layout and colours: how far off is still right (a fraction of the screen for centring, pixels for alignment). */
  tolerance: z.number().optional(),
  axis: z.enum(['x', 'y', 'both']).optional(),
  relation: z.enum(['above', 'below', 'left-of', 'right-of', 'aligned-left', 'aligned-right', 'aligned-top', 'aligned-bottom']).optional(),
  region: z.enum(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']).optional(),
  /** Counts, sizes, durations: how the number is compared with `expected`. */
  compare: z.enum(['eq', 'gte', 'lte', 'gt', 'lt']).optional(),
  /** Attribute, CSS property, cookie or storage key, query parameter. */
  name: z.string().optional(),
  /** What the check reads: a size side, a table column, a request field. */
  side: z.string().optional(),
  column: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  /** Waits longer (or shorter) than the usual 5 seconds. */
  timeoutMs: z.number().optional(),
  /** Report all failures at the end instead of stopping at the first. */
  soft: z.boolean().optional(),
  /** `warn` records the problem without failing the test. */
  severity: z.enum(['fail', 'warn']).optional(),
  /** Network: method and status. */
  method: z.string().optional(),
  status: z.number().optional(),
  /** List checks: the whole list in order. */
  list: z.array(z.string()).optional(),
  /** `local` or `session` storage. */
  area: z.enum(['local', 'session']).optional(),
  /** Text checks: the whole text, a part of it, or a format. */
  mode: z.enum(['exact', 'contains', 'pattern']).optional(),
  /** Tables: the row, found by a word in it. */
  row: z.string().optional(),
  /** Cookies: which of secure / httpOnly / sameSite must be set. */
  flags: z.array(z.string()).optional(),
  /** Several-part checks: a column, a part of the page, a pop-up button… */
  note: z.string().optional(),
});
export type AssertionOptions = z.infer<typeof AssertionOptionsSchema>;

export const AssertionSchema = z.object({
  id: z.string(),
  /** Missing when the assertion is unparsed. */
  type: z.enum(ASSERTION_TYPES).optional(),
  ...TargetFields,
  expected: z.string().optional(),
  options: AssertionOptionsSchema.optional(),
  /** The second element of a check that compares two ("Cancel is to the left of Save"). */
  other: z.object({ ...TargetFields }).optional(),
  /** url / url-unchanged: whether `expected` is a page name or a URL/path. */
  match: z.enum(['page', 'url']).optional(),
  negated: z.boolean(),
  /**
   * The tester step this check was written as, e.g. `S3` for "3. Observe Registration page".
   * It runs after the action steps numbered before it. Missing for checks from the Expected Result
   * column, which run after the last step.
   */
  step: z.string().optional(),
  source: z.enum(['step', 'expected', 'builtin']),
  raw: z.string(),
  status: z.enum(STATUSES),
  reason: z.object({ code: z.string(), text: z.string() }).optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const PreconditionSchema = z.discriminatedUnion('kind', [
  /** "Unauthenticated visitor": start in a new browser context (FR-PF-01). */
  z.object({ kind: z.literal('fresh-context'), raw: z.string() }),
  /** "Logged in as admin": start from a saved login state. `user` missing = the default test user. */
  z.object({ kind: z.literal('logged-in'), user: z.string().optional(), raw: z.string() }),
  /** Any other precondition is a named reusable flow, e.g. "On Registration page" (FR-PF-02). */
  z.object({ kind: z.literal('flow'), name: z.string(), raw: z.string() }),
  /** Statements that need no action, e.g. "Application is accessible". */
  z.object({ kind: z.literal('note'), raw: z.string() }),
]);
export type Precondition = z.infer<typeof PreconditionSchema>;

export const WarningSchema = z.object({
  /** `S2`, `A1`, `data`, `preconditions` or missing for the whole test case. */
  at: z.string().optional(),
  code: z.string(),
  text: z.string(),
});
export type ModelWarning = z.infer<typeof WarningSchema>;

export const TEST_TYPES = ['positive', 'negative', 'validation', 'boundary'] as const;

export const TestModelSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  type: z.enum(TEST_TYPES).optional(),
  requirementId: z.string().optional(),
  preconditions: z.array(PreconditionSchema),
  /** Non-secret test data only (FR-TD-03). Secret-looking keys are bound to env vars instead. */
  data: z.record(z.string(), z.string()),
  steps: z.array(StepSchema),
  assertions: z.array(AssertionSchema),
  source: z.object({
    row: z.number().optional(),
    rawSteps: z.string(),
    rawExpected: z.string(),
    rawPreconditions: z.string().optional(),
    rawTestData: z.string().optional(),
  }),
  warnings: z.array(WarningSchema),
});
export type TestModel = z.infer<typeof TestModelSchema>;

/** Environment variables with a fixed meaning (FR-TD-02). */
export const ENV = {
  baseUrl: 'BASE_URL',
  username: 'TEST_USERNAME',
  password: 'TEST_PASSWORD',
} as const;
