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
] as const;
export type IrAction = (typeof IR_ACTIONS)[number];

/** What a target is, in the application's own terms (the ontology, ON-01), and how the tester named it. */
export const IrTargetSchema = z.object({
  ontology: z.string().min(1),
  name: z.string().optional(),
  label: z.string().optional(),
  /** "validation message near Username". */
  near: z.string().optional(),
});
export type IrTarget = z.infer<typeof IrTargetSchema>;

export const DATA_CLASSES = ['EXPLICIT', 'BLANK', 'GENERATED', 'REFERENCE'] as const;
export const DATA_SOURCES = ['EXCEL', 'ENV', 'GENERATOR'] as const;

export const IrDataSchema = z
  .object({
    class: z.enum(DATA_CLASSES),
    source: z.enum(DATA_SOURCES),
    value: z.string().optional(),
    secret: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.class === 'BLANK' && d.value !== undefined && d.value !== '') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'a BLANK value must be empty' });
    }
    // A secret is a name to look up (`$env.TEST_PASSWORD`) or masked, never the secret itself.
    if (d.secret && d.value !== undefined && d.value !== '***' && !d.value.startsWith('$')) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'a secret must be a reference ($env.NAME) or ***, never the value' });
    }
    if (d.source === 'ENV' && d.class !== 'REFERENCE') {
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
  original: Original,
});
export type IrStep = z.infer<typeof IrStepSchema>;

export const CONDITION_TYPES = ['VISIBILITY', 'TEXT', 'URL', 'STATE', 'AUTHENTICATION', 'VALUE', 'ENABLED', 'COUNT', 'HEALTH', 'OTHER'] as const;
export const IrConditionSchema = z.object({
  type: z.enum(CONDITION_TYPES),
  target: IrTargetSchema.optional(),
  expect: z.string().optional(),
  /** A message must have appeared after the step, not be left over from earlier (freshness, VD-04). */
  fresh: z.boolean().optional(),
  /** The check type of the current platform this condition is verified with, until the new verifier exists (E0.8). */
  check: z.string().optional(),
});

export const IrExpectationSchema = z.object({
  id: z.string().refine(isExpectationId, 'an expectation id looks like E1'),
  clause: Original,
  negated: z.boolean(),
  condition: IrConditionSchema,
  afterStep: z.string().refine(isStepId).optional(),
  /** A guard rail the platform adds on every test (e.g. "no crash"); there are no words of the tester to point back to. */
  automatic: z.boolean().optional(),
});
export type IrExpectation = z.infer<typeof IrExpectationSchema>;

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
    conditionals: z.array(z.unknown()),
    references: z.array(z.unknown()),
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
