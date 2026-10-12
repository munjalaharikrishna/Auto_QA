import { z } from 'zod';
import { type RawTestCase, RawTestCaseSchema, type TestModel, TestModelSchema } from '../../model/test-model.js';
import { defaultParserConfig, type ParserConfig, parseTestCase } from '../../parser/index.js';
import { isSecretName } from '../config/index.js';
import { type IrSource, toQaIr } from '../ir/from-model.js';
import { QaIrSchema } from '../ir/schema.js';
import { validateIr } from '../ir/validate.js';
import { nonBlankLines } from '../patterns/shapes.js';
import { type AnyStage, STAGE_NAMES, type Stage } from './pipeline.js';

/**
 * The compilation stages in the order of GV-15, up to the plan. Each is the simplest form that works (the walking
 * skeleton, BP-1); the later versions replace what is behind a stage, never the stage's shape.
 */

export interface CompileOptions {
  config?: ParserConfig;
  source?: IrSource;
  /** Page names the environment knows, with their paths (page routes). */
  pageRoutes?: Record<string, string>;
}

const PlanItem = z.object({ seq: z.number().int().positive(), kind: z.enum(['step', 'expect']), ref: z.string() });
export const PlanSchema = z.object({
  testId: z.string(),
  items: z.array(PlanItem).min(1),
  /** An assumption anywhere in the test case means the run can never be a clean PASS (DEC-05). */
  passAllowed: z.boolean(),
});
export type Plan = z.infer<typeof PlanSchema>;

const Unparsed = z.array(z.object({ id: z.string(), raw: z.string(), why: z.string() }));
const Understood = z.object({ model: TestModelSchema, unparsed: Unparsed });
const WithIr = z.object({ ir: QaIrSchema });
const WithPages = WithIr.extend({ pages: z.record(z.string(), z.string().nullable()) });
const Planned = WithPages.extend({ plan: PlanSchema });

export function compileStages(options: CompileOptions = {}): AnyStage[] {
  const config = options.config ?? defaultParserConfig();
  const pageRoutes = options.pageRoutes ?? {};

  const read: Stage<unknown, RawTestCase> = {
    name: 'Read',
    output: RawTestCaseSchema,
    run: (input, ctx) => {
      const raw = RawTestCaseSchema.parse(input);
      ctx.log.add('Read', 'info', 'test case read', { id: raw.id ?? '', steps: nonBlankLines(raw.steps).length });
      return raw;
    },
  };

  const understand: Stage<RawTestCase, TestModel> = {
    name: 'Understand',
    output: TestModelSchema,
    run: (raw, ctx) => {
      const model = parseTestCase(raw, config);
      ctx.log.add('Understand', 'info', 'text turned into steps and checks', { steps: model.steps.length, checks: model.assertions.length });
      return model;
    },
  };

  const validate: Stage<TestModel, z.infer<typeof Understood>> = {
    name: 'Validate',
    output: Understood,
    run: (model, ctx) => {
      const unparsed = [...model.steps, ...model.assertions]
        .filter((x) => x.status === 'unparsed')
        .map((x) => ({ id: x.id, raw: x.raw, why: x.reason?.text ?? 'not understood' }));
      for (const u of unparsed) ctx.log.add('Validate', 'warning', `${u.id} not understood: ${u.why}`, { text: u.raw });
      if (!unparsed.length) ctx.log.add('Validate', 'info', 'every step and check understood');
      return { model, unparsed };
    },
    // Nothing is built on text that was not understood: it goes to review with the reasons above.
    stopWhen: (o) => (o.unparsed.length ? `${o.unparsed.length} step(s) or check(s) not understood` : undefined),
  };

  const buildIr: Stage<z.infer<typeof Understood>, z.infer<typeof WithIr>> = {
    name: 'BuildIr',
    output: WithIr,
    run: ({ model }, ctx) => {
      const ir = toQaIr(model, options.source);
      const checked = validateIr(ir);
      if (!checked.ok) throw Object.assign(new Error(checked.issues.map((i) => `${i.path}: ${i.message}`).join('; ')), { issues: checked.issues });
      ctx.log.add('BuildIr', 'info', 'QA-IR built and valid', { steps: ir.steps.length, expectations: ir.expectations.length });
      return { ir };
    },
  };

  const resolveData: Stage<z.infer<typeof WithIr>, z.infer<typeof WithIr>> = {
    name: 'ResolveData',
    output: WithIr,
    run: ({ ir }, ctx) => {
      const data = { ...ir.data };
      for (const [name, d] of Object.entries(data)) {
        const secret = d.secret || isSecretName(name) || (d.source === 'ENV' && isSecretName(d.value ?? ''));
        // A secret is only ever kept as a reference, whatever the test case or the parser put there.
        if (secret && d.class !== 'BLANK') data[name] = { ...d, secret: true, value: d.source === 'ENV' ? d.value : '***' };
        ctx.log.add('ResolveData', 'decision', `${name}: ${d.class}${secret ? ' (secret, kept as a reference)' : ''}`, { source: d.source });
      }
      if (!Object.keys(data).length) ctx.log.add('ResolveData', 'info', 'no data to resolve');
      for (const a of ir.assumptions) ctx.log.add('ResolveData', 'assumption', a.text, { at: a.at ?? '' });
      return { ir: { ...ir, data } };
    },
  };

  const resolvePage: Stage<z.infer<typeof WithIr>, z.infer<typeof WithPages>> = {
    name: 'ResolvePage',
    output: WithPages,
    run: ({ ir }, ctx) => {
      const pages: Record<string, string | null> = {};
      for (const s of ir.steps) {
        const name = s.action === 'NAVIGATE' && s.target?.ontology === 'Page' ? s.target.name : undefined;
        if (name && !(name in pages)) {
          pages[name] = pageRoutes[name] ?? null;
          ctx.log.add(
            'ResolvePage',
            'decision',
            pages[name] ? `${name} is ${pages[name]}` : `${name} has no known address: found when the application is explored`,
          );
        }
      }
      if (!Object.keys(pages).length) ctx.log.add('ResolvePage', 'info', 'no page to resolve');
      return { ir, pages };
    },
  };

  const resolveTarget: Stage<z.infer<typeof WithPages>, z.infer<typeof WithPages>> = {
    name: 'ResolveTarget',
    output: WithPages,
    run: (input, ctx) => {
      const targets = input.ir.steps.filter((s) => s.target && s.action !== 'NAVIGATE').length;
      // The locator ladder runs against the real page when the test case is explored (E0.6 brings the knowledge layers).
      ctx.log.add('ResolveTarget', 'decision', `${targets} element(s) are located on the real page during exploration`);
      return input;
    },
  };

  const buildPlan: Stage<z.infer<typeof WithPages>, z.infer<typeof Planned>> = {
    name: 'BuildPlan',
    output: Planned,
    run: (input, ctx) => {
      const { ir } = input;
      const items: Plan['items'] = [];
      const push = (kind: 'step' | 'expect', ref: string) => items.push({ seq: items.length + 1, kind, ref });
      const after = (id?: string) => ir.expectations.filter((e) => e.afterStep === id);
      for (const e of after(undefined)) push('expect', e.id);
      for (const s of ir.steps) {
        push('step', s.id);
        for (const e of after(s.id)) push('expect', e.id);
      }
      // An expectation written for no particular step runs at the end, after the last step.
      const placed = new Set(items.map((i) => i.ref));
      for (const e of ir.expectations) if (!placed.has(e.id)) push('expect', e.id);
      const plan: Plan = { testId: ir.testCase.id, items, passAllowed: ir.assumptions.length === 0 };
      ctx.log.add('BuildPlan', 'info', `plan of ${items.length} item(s)`, { passAllowed: plan.passAllowed });
      return { ...input, plan };
    },
  };

  const validatePlan: Stage<z.infer<typeof Planned>, z.infer<typeof Planned>> = {
    name: 'ValidatePlan',
    output: Planned,
    run: (input, ctx) => {
      const refs = input.plan.items.map((i) => i.ref);
      const want = [...input.ir.steps.map((s) => s.id), ...input.ir.expectations.map((e) => e.id)];
      const missing = want.filter((id) => !refs.includes(id));
      const twice = refs.filter((r, i) => refs.indexOf(r) !== i);
      if (missing.length || twice.length) {
        throw new Error(
          `the plan must hold every step and expectation exactly once (missing: ${missing.join(', ') || 'none'}; repeated: ${twice.join(', ') || 'none'})`,
        );
      }
      ctx.log.add('ValidatePlan', 'info', 'every step and expectation is in the plan exactly once');
      return input;
    },
  };

  return [read, understand, validate, buildIr, resolveData, resolvePage, resolveTarget, buildPlan, validatePlan];
}

/** The compilation stages come first, then Execute (run by the caller, which owns the browser). */
export const COMPILE_STAGE_NAMES = STAGE_NAMES.filter((n) => n !== 'Execute');
