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

export const ASSERTION_TYPES = ['url', 'url-unchanged', 'visible', 'text', 'enabled', 'disabled', 'checked', 'value', 'health'] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

export const AssertionSchema = z.object({
  id: z.string(),
  /** Missing when the assertion is unparsed. */
  type: z.enum(ASSERTION_TYPES).optional(),
  ...TargetFields,
  expected: z.string().optional(),
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
