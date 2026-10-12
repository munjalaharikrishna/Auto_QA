import { z } from 'zod';
import { type RawTestCase, RawTestCaseSchema } from '../../model/test-model.js';
import type { ParserConfig } from '../../parser/index.js';
import { isSecretName } from '../config/index.js';
import type { IrSource } from '../ir/from-model.js';
import { QaIrSchema } from '../ir/schema.js';
import { type CaseLanguage, understandCase } from '../language/case.js';
import { nonBlankLines } from '../patterns/shapes.js';
import { type AnyStage, STAGE_NAMES, type Stage } from './pipeline.js';

/**
 * The compilation stages in the order of GV-15, up to the plan. From E0.4 the text is read by the language layers
 * (src/engine/language): normalization and tokens, vocabulary and synonyms, the grammar models, clauses, negation,
 * conditionals and the ontology. The later versions replace what is behind a stage, never the stage's shape.
 */

export interface CompileOptions {
  /** Kept so callers written for the first version still compile; the language layers do not read it. */
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
const Language = z.custom<CaseLanguage>(
  (v) => typeof v === 'object' && v !== null && 'issues' in v && 'units' in v,
  'must be the result of reading the test case',
);
const Read = z.object({ language: Language });
const Understood = z.object({ language: Language, unparsed: Unparsed });
const WithIr = z.object({ ir: QaIrSchema, language: Language });
const WithPages = WithIr.extend({ pages: z.record(z.string(), z.string().nullable()) });
const Planned = WithPages.extend({ plan: PlanSchema });

export function compileStages(options: CompileOptions = {}): AnyStage[] {
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

  const understand: Stage<RawTestCase, z.infer<typeof Read>> = {
    name: 'Understand',
    output: Read,
    run: (raw, ctx) => {
      const language = understandCase(raw, { source: options.source });
      const steps = language.units.filter((u) => u.kind === 'step').length;
      const checks = language.units.filter((u) => u.kind === 'expectation').length;
      ctx.log.add('Understand', 'info', 'text turned into steps and checks', {
        steps,
        checks,
        understood: language.units.filter((u) => u.understood).length,
        models: Object.entries(language.models)
          .map(([m, n]) => `${m}x${n}`)
          .join(' '),
      });
      for (const d of language.decisions) ctx.log.add('Understand', d.kind, d.message, d.data);
      return { language };
    },
  };

  const validate: Stage<z.infer<typeof Read>, z.infer<typeof Understood>> = {
    name: 'Validate',
    output: Understood,
    run: ({ language }, ctx) => {
      const unparsed = language.issues
        .filter((i) => i.severity === 'blocking')
        .map((i, k) => ({ id: `${i.where.replace(' ', '-')}-${k + 1}`, raw: i.original, why: i.message }));
      for (const i of language.issues) {
        ctx.log.add('Validate', i.severity === 'info' ? 'info' : 'warning', `${i.where}: ${i.message}`, {
          code: i.code,
          severity: i.severity,
          text: i.original,
        });
      }
      if (!language.issues.some((i) => i.severity !== 'info')) ctx.log.add('Validate', 'info', 'every step and check understood, nothing to review');
      return { language, unparsed };
    },
    // Nothing is built on text that was not understood: it goes to review with the reasons above.
    stopWhen: (o) => (o.unparsed.length ? `${o.unparsed.length} step(s) or check(s) not understood` : undefined),
  };

  const buildIr: Stage<z.infer<typeof Understood>, z.infer<typeof WithIr>> = {
    name: 'BuildIr',
    output: WithIr,
    run: ({ language }, ctx) => {
      const ir = language.ir;
      // The language layers check the document before handing it on; a problem here is a fault of the engine, not of the test case.
      if (!ir) throw Object.assign(new Error(`no valid QA-IR: ${language.irProblems.join('; ') || 'no step or no check'}`), { issues: language.irProblems });
      ctx.log.add('BuildIr', 'info', 'QA-IR built and valid', {
        steps: ir.steps.length,
        expectations: ir.expectations.length,
        conditionals: ir.conditionals.length,
      });
      return { ir, language };
    },
  };

  const resolveData: Stage<z.infer<typeof WithIr>, z.infer<typeof WithIr>> = {
    name: 'ResolveData',
    output: WithIr,
    run: ({ ir, language }, ctx) => {
      const data = { ...ir.data };
      for (const [name, d] of Object.entries(data)) {
        const secret = d.secret || isSecretName(name) || (d.source === 'ENV' && isSecretName(d.value ?? ''));
        // A secret is only ever kept as a reference, whatever the test case or the parser put there.
        if (secret && d.class !== 'BLANK') data[name] = { ...d, secret: true, value: d.source === 'ENV' ? d.value : '***' };
        ctx.log.add('ResolveData', 'decision', `${name}: ${d.class}${secret ? ' (secret, kept as a reference)' : ''}`, { source: d.source });
      }
      if (!Object.keys(data).length) ctx.log.add('ResolveData', 'info', 'no data to resolve');
      for (const a of ir.assumptions) ctx.log.add('ResolveData', 'assumption', a.text, { at: a.at ?? '' });
      return { ir: { ...ir, data }, language };
    },
  };

  const resolvePage: Stage<z.infer<typeof WithIr>, z.infer<typeof WithPages>> = {
    name: 'ResolvePage',
    output: WithPages,
    run: ({ ir, language }, ctx) => {
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
      return { ir, language, pages };
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
      // A step or a check under a condition runs only when the condition is known to be true (CD-02). An unknown one is never chosen.
      const given = new Map(ir.conditionals.map((c) => [c.id, c.given]));
      const runs = (guard?: string): boolean => guard === undefined || given.get(guard) === 'TRUE';
      const after = (id?: string) => ir.expectations.filter((e) => e.afterStep === id && runs(e.guard));
      for (const e of after(undefined)) push('expect', e.id);
      for (const s of ir.steps) {
        if (!runs(s.guard)) {
          ctx.log.add('BuildPlan', 'decision', `${s.id} left out: its condition ${s.guard} is not known to be true`);
          continue;
        }
        push('step', s.id);
        for (const e of after(s.id)) push('expect', e.id);
      }
      for (const e of ir.expectations)
        if (!runs(e.guard)) ctx.log.add('BuildPlan', 'decision', `${e.id} left out: its condition ${e.guard} is not known to be true`);
      // An expectation written for no particular step runs at the end, after the last step.
      const placed = new Set(items.map((i) => i.ref));
      for (const e of ir.expectations) if (!placed.has(e.id) && runs(e.guard)) push('expect', e.id);
      // Nothing that could not be settled before the run may end in a clean PASS (DEC-05).
      const unsettled =
        ir.assumptions.length > 0 ||
        ir.conditionals.some((c) => c.given === 'UNKNOWN') ||
        Object.values(ir.data).some((d) => d.source === 'UNRESOLVED') ||
        ir.expectations.some((e) => e.condition.expect?.startsWith('$ref.'));
      const plan: Plan = { testId: ir.testCase.id, items, passAllowed: !unsettled };
      ctx.log.add('BuildPlan', 'info', `plan of ${items.length} item(s)`, { passAllowed: plan.passAllowed });
      return { ...input, plan };
    },
  };

  const validatePlan: Stage<z.infer<typeof Planned>, z.infer<typeof Planned>> = {
    name: 'ValidatePlan',
    output: Planned,
    run: (input, ctx) => {
      const refs = input.plan.items.map((i) => i.ref);
      const given = new Map(input.ir.conditionals.map((c) => [c.id, c.given]));
      const runs = (guard?: string): boolean => guard === undefined || given.get(guard) === 'TRUE';
      const want = [...input.ir.steps.filter((s) => runs(s.guard)).map((s) => s.id), ...input.ir.expectations.filter((e) => runs(e.guard)).map((e) => e.id)];
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
