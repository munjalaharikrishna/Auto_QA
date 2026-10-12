import { z } from 'zod';
import { dataRefKey, isAssumptionId, isExpectationId, isStateName, isStepId } from '../patterns/shapes.js';

/**
 * QA-IR: the machine-readable form every test case is compiled into before anything executes (IR-01, ENGINE-SPEC §12).
 * Rules: every step and expectation carries the tester's original words (NM-19); a secret is never a literal value
 * (DS-02, DS-03); the document is validated before planning (GV-15, "Validate").
 */

/** `LOGIN_PAGE`, `LOGIN_SUBMITTED`: upper snake case, so states are compared as names, never as free text. */
const StateName = z.string().refine(isStateName, 'a state is written in UPPER_SNAKE_CASE');
const Original = z.string().trim().min(1, 'must hold the original words of the tester');

export const IR_ACTIONS = [
  'NAVIGATE',
  'ENTER_VALUE',
  'CLEAR',
  'CLICK',
  'SELECT',
  'CHECK',
  'UNCHECK',
  'HOVER',
  'UPLOAD',
  'PRESS',
  'BACK',
  'FORWARD',
  'REFRESH',
  // The rest of the controlled action vocabulary (VO-01): the verbs the new language layer understands.
  'DOWNLOAD',
  'SUBMIT',
  'LOGIN',
  'LOGOUT',
  'SEARCH',
  'SCROLL',
  'DRAG',
  'DROP',
  'REMOVE',
  'DELETE',
  'EDIT',
  'SAVE',
  'CANCEL',
  'CLOSE',
  'EXPAND',
  'COLLAPSE',
] as const;
export type IrAction = (typeof IR_ACTIONS)[number];

/** What a target is, in the application's own terms (the ontology, ON-01), and how the tester named it. */
export const IrTargetSchema = z.object({
  ontology: z.string().min(1),
  name: z.string().optional(),
  label: z.string().optional(),
  /** "validation message near Username". */
  near: z.string().optional(),
  /** Where the tester says it is: "in the Employee Information section". */
  within: z.string().optional(),
  /** The one component the names resolve to in the application's knowledge ("Login Name", "username": `Username`), LU-01. */
  component: z.string().optional(),
  /** The page of the application's knowledge the component is on (PK-01). */
  page: z.string().optional(),
});
export type IrTarget = z.infer<typeof IrTargetSchema>;

/**
 * The data classes of TD-01: a value the tester gave (EXPLICIT), or the kind of value the text asks for ("valid",
 * "invalid", "blank", "existing", "maximum length"). `REFERENCE` is a value that lives elsewhere ($env.NAME).
 */
export const DATA_CLASSES = [
  'EXPLICIT',
  'VALID',
  'INVALID',
  'EMPTY',
  'BLANK',
  'MISSING',
  'NULL',
  'BOUNDARY',
  'MAXIMUM',
  'MINIMUM',
  'EXISTING',
  'NON_EXISTING',
  'DUPLICATE',
  'GENERATED',
  'RANDOM',
  'CREDENTIAL',
  'ENVIRONMENT',
  'REFERENCE',
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
/**
 * Where a value comes from, in the fixed order the resolver tries them (DR-01): the test case's own text, environment
 * variables, central configuration, the credential store, test-data files, the generator, earlier steps, and what the
 * application created. `UNRESOLVED`: nothing gave one yet; the test case is asked about it, never given a made-up value.
 */
export const DATA_SOURCES = ['EXCEL', 'ENV', 'CONFIG', 'STORE', 'FILE', 'GENERATOR', 'STEP', 'APPLICATION', 'UNRESOLVED'] as const;

export const IrDataSchema = z
  .object({
    class: z.enum(DATA_CLASSES),
    source: z.enum(DATA_SOURCES),
    value: z.string().optional(),
    secret: z.boolean().optional(),
    /** What kind of value the step asked for when the value itself was given ("invalid username" with `Username: invaliduser`). */
    intent: z.enum(DATA_CLASSES).optional(),
    /** For a generated value: the rule that made it, and the seed (DG-01). Never the value of a secret. */
    rule: z.string().optional(),
    seed: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.class === 'BLANK' && d.value !== undefined && d.value !== '') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'a BLANK value must be empty' });
    }
    // A secret is a name to look up (`$env.TEST_PASSWORD`) or masked, never the secret itself.
    if (d.secret && d.value !== undefined && d.value !== '***' && !d.value.startsWith('$')) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'a secret must be a reference ($env.NAME) or ***, never the value' });
    }
    if (d.source === 'ENV' && !['REFERENCE', 'ENVIRONMENT', 'CREDENTIAL'].includes(d.class)) {
      ctx.addIssue({ code: 'custom', path: ['class'], message: 'a value from the environment is a REFERENCE' });
    }
  });
export type IrData = z.infer<typeof IrDataSchema>;

export const IrPreconditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STATE'), state: StateName, original: Original.optional() }),
  z.object({ type: z.literal('FRESH_CONTEXT'), original: Original }),
  z.object({ type: z.literal('LOGGED_IN'), user: z.string().optional(), original: Original }),
  z.object({ type: z.literal('NOTE'), original: Original }),
]);

export const IrStepSchema = z.object({
  /** `S3`, or `S3.2` when one written step holds several actions. */
  id: z.string().refine(isStepId, 'a step id looks like S1 or S3.2'),
  action: z.enum(IR_ACTIONS),
  target: IrTargetSchema.optional(),
  /** `$data.username` (a name in `data`), or a literal. */
  value: z.string().optional(),
  /** The page state the step should leave the application in. */
  expectedState: StateName.optional(),
  /** The conditional (`C1`) this step only runs under (GR-03). */
  guard: z.string().optional(),
  original: Original,
});
export type IrStep = z.infer<typeof IrStepSchema>;

export const CONDITION_TYPES = [
  'VISIBILITY',
  'TEXT',
  'URL',
  'STATE',
  'AUTHENTICATION',
  'VALUE',
  'ENABLED',
  'COUNT',
  'HEALTH',
  'LAYOUT',
  'MASKED',
  'OTHER',
] as const;
export const IrConditionSchema = z.object({
  type: z.enum(CONDITION_TYPES),
  target: IrTargetSchema.optional(),
  expect: z.string().optional(),
  /** What a message must say, in the tester's words ("username is required"): a meaning to look for, not an exact text. */
  text: z.string().optional(),
  /** Where a layout check puts the element: `center`, `top-left`, … */
  region: z.string().optional(),
  /** A message must have appeared after the step, not be left over from earlier (freshness, VD-04). */
  fresh: z.boolean().optional(),
  /** The check type of the current platform this condition is verified with, until the new verifier exists (E0.8). */
  check: z.string().optional(),
});

export type IrCondition = z.infer<typeof IrConditionSchema>;

export const IrExpectationSchema = z.object({
  id: z.string().refine(isExpectationId, 'an expectation id looks like E1'),
  clause: Original,
  negated: z.boolean(),
  condition: IrConditionSchema,
  afterStep: z.string().refine(isStepId).optional(),
  /** A guard rail the platform adds on every test (e.g. "no crash"); there are no words of the tester to point back to. */
  automatic: z.boolean().optional(),
  /** The conditional (`C1`) this expectation only holds under; it is checked only when the condition is true (CD-01). */
  guard: z.string().optional(),
});
export type IrExpectation = z.infer<typeof IrExpectationSchema>;

/**
 * A condition and what follows from it (CD-01, CD-02): `given` is what is known about the condition before the run.
 * `UNKNOWN` is never turned into a branch by guessing; it goes to the tester.
 */
export const IrConditionalSchema = z.object({
  id: z.string().min(1),
  keyword: z.string().min(1),
  condition: IrConditionSchema,
  given: z.enum(['TRUE', 'FALSE', 'UNKNOWN']),
  /** Why `given` is what it is: the fact it rests on, or what is missing. */
  because: z.string(),
  whenTrue: z.array(z.string().refine(isExpectationId)),
  whenFalse: z.array(z.string().refine(isExpectationId)),
  /** Steps that only run when the condition is true. */
  steps: z.array(z.string().refine(isStepId)),
  original: Original,
});
export type IrConditional = z.infer<typeof IrConditionalSchema>;

/** What a word like "it", "same field" or "added data" stands for, found from what the test case did earlier (RF-01). */
export const REFERENCE_KINDS = ['PREVIOUS_TARGET', 'PREVIOUS_VALUE', 'ENTERED_DATA', 'PREVIOUS_STEP'] as const;
export const IrReferenceSchema = z.object({
  id: z.string().min(1),
  /** The tester's own words. */
  phrase: Original,
  kind: z.enum(REFERENCE_KINDS),
  status: z.enum(['RESOLVED', 'UNRESOLVED']),
  /** The steps the phrase stands for. */
  steps: z.array(z.string().refine(isStepId)),
  /** The values those steps entered, as `$data.name`. */
  values: z.array(z.string()),
  because: z.string(),
});
export type IrReference = z.infer<typeof IrReferenceSchema>;

export const IrAssumptionSchema = z.object({ id: z.string().refine(isAssumptionId), text: Original, at: z.string().optional() });

export const IrVersionsSchema = z.object({ grammar: z.string(), vocabulary: z.string(), ontology: z.string(), patterns: z.string() });

export const QaIrSchema = z
  .object({
    testCase: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      version: z.number().int().positive(),
      source: z.object({ file: z.string().optional(), sheet: z.string().optional(), rows: z.array(z.number().int().positive()) }),
      priority: z.string().nullable(),
      tags: z.array(z.string()),
    }),
    preconditions: z.array(IrPreconditionSchema),
    data: z.record(z.string(), IrDataSchema),
    steps: z.array(IrStepSchema).min(1, 'a test case needs at least one step'),
    expectations: z.array(IrExpectationSchema).min(1, 'a test case needs at least one expectation'),
    conditionals: z.array(IrConditionalSchema),
    references: z.array(IrReferenceSchema),
    assumptions: z.array(IrAssumptionSchema),
    versions: IrVersionsSchema,
  })
  .superRefine((ir, ctx) => {
    const ids = new Set<string>();
    ir.steps.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'id'], message: `step id ${s.id} is used twice` });
      ids.add(s.id);
      const key = dataRefKey(s.value ?? '');
      if (key !== undefined && !(key in ir.data)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'value'], message: `${s.value} is not in data` });
    });
    ir.expectations.forEach((e, i) => {
      if (e.afterStep && !ids.has(e.afterStep)) ctx.addIssue({ code: 'custom', path: ['expectations', i, 'afterStep'], message: `no step ${e.afterStep}` });
    });
  });
export type QaIr = z.infer<typeof QaIrSchema>;
