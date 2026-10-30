import { z } from 'zod';
import { type RawTestCase, RawTestCaseSchema } from '../../model/test-model.js';
import type { ParserConfig } from '../../parser/index.js';
import { cacheEnabled, cacheKeyOf, copyOf, memo, readingVersions } from '../cache/index.js';
import { buildContexts } from '../context/context.js';
import { type ResolvedValue, resolveData as resolveDataValues } from '../data/resolver.js';
import type { CredentialStore } from '../data/store.js';
import type { IrSource } from '../ir/from-model.js';
import { QaIrSchema } from '../ir/schema.js';
import { validateIr } from '../ir/validate.js';
import { consolidate } from '../knowledge/labels.js';
import { resolvePage } from '../knowledge/pages.js';
import type { Application } from '../knowledge/schema.js';
import { type CaseLanguage, understandCase } from '../language/case.js';
import type { ProductionPattern } from '../patterns/redact.js';
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
  /** The environment variables the test data may come from (DR-01). Not given: they are read when the test runs. */
  env?: Record<string, string | undefined>;
  /** Central configuration values (`username.valid`, `TEST_PASSWORD`). */
  dataConfig?: Record<string, string>;
  /** The encrypted credential store (DS-04). */
  store?: CredentialStore;
  /** Test-data files, read already. */
  dataFiles?: Record<string, string>;
  /** The run, for the seed of generated values: the same run gives the same values. */
  run?: string;
  /** The longest value each field takes, from the application's knowledge. */
  maxLengths?: Record<string, number>;
  /** The shortest value each field takes, from the application's knowledge. */
  minLengths?: Record<string, number>;
  /** What the engine knows about the application (AK-01, PK-01): its pages, routes and components, and what they are called. */
  knowledge?: Application;
  /** Patterns for production identifiers (a real customer number): they are taken out of every output (DS-01). */
  productionPatterns?: ProductionPattern[];
  /** The application logs in with a one-time code that is read when the test runs (email or authenticator): "the valid OTP" has a source (AU-01). */
  otpAtRun?: boolean;
  /** Reuse what was worked out from the same text before (GV-11). Default: on, unless `AUTO_QA_CACHE=off`. The result is the same either way. */
  cache?: boolean;
}

/**
 * The understanding of a test case is a function of its text, its source and the components that read it, so it is worked out once
 * per process (GV-11). What the data of the test needs from the environment is not part of it and is resolved on every compile.
 */
function understood(raw: RawTestCase, options: CompileOptions): CaseLanguage {
  if (!cacheEnabled(options.cache)) return understandCase(raw, { source: options.source });
  const cache = memo<CaseLanguage>('understand', 2000);
  const key = cacheKeyOf({ raw, source: options.source ?? null, reads: readingVersions() });
  const hit = cache.get(key);
  if (hit) return copyOf(hit);
  const language = understandCase(raw, { source: options.source });
  cache.set(key, copyOf(language));
  return language;
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
const Values = z.custom<Record<string, ResolvedValue>>((v) => typeof v === 'object' && v !== null, 'must be the resolved values');
const WithIr = z.object({ ir: QaIrSchema, language: Language, values: Values.optional() });
const WithPages = WithIr.extend({ pages: z.record(z.string(), z.string().nullable()) });
const Planned = WithPages.extend({ plan: PlanSchema });

/**
 * Settles the values of a test case in the order of DR-01 (the data resolver) and says which questions that answers: a
 * value that was found or made is no longer missing; one that could not be says why. It does not log: the stage logs
 * what it returns, and a test case that stopped before the stage is settled the same way for its pre-flight report.
 */
export async function settleData(
  options: CompileOptions,
  language: CaseLanguage,
  ir: z.infer<typeof QaIrSchema>,
): Promise<{
  ir: z.infer<typeof QaIrSchema>;
  issues: CaseLanguage['issues'];
  values: Record<string, ResolvedValue>;
  decisions: Awaited<ReturnType<typeof resolveDataValues>>['decisions'];
}> {
  // Every value the test case needs is looked for in the fixed order of DR-01; a secret is never written anywhere.
  const resolution = await resolveDataValues(ir.data, {
    testId: ir.testCase.id,
    run: options.run,
    excel: language.excel,
    excelSecrets: language.excelSecrets,
    env: options.env,
    config: options.dataConfig,
    store: options.store,
    files: options.dataFiles,
    maxLengths: options.maxLengths,
    minLengths: options.minLengths,
    otpAtRun: options.otpAtRun,
    formats: language.formats,
    steps: ir.steps,
  });
  // What was settled is no longer a question; what was not says why.
  const why = new Map(resolution.unresolved.map((u) => [u.key, u.why]));
  const issues = language.issues
    .filter((i) => !(i.code === 'MISSING_DATA' && i.data && resolution.values[i.data]))
    .map((i) => (i.code === 'MISSING_DATA' && i.data && why.has(i.data) ? { ...i, message: `${i.message}: ${why.get(i.data)}` } : i));
  // A value that could not be found for a field the text did not even ask a question about becomes one.
  for (const u of resolution.unresolved) {
    if (!issues.some((i) => i.data === u.key)) {
      issues.push({
        code: 'MISSING_DATA',
        severity: 'review',
        where: 'test data',
        original: u.field,
        data: u.key,
        message: `no value for "${u.field}": ${u.why}`,
        suggestion: `Add it to Test Data: "${u.field}: <value>".`,
      });
    }
  }
  return { ir: { ...ir, data: resolution.data }, issues, values: resolution.values, decisions: resolution.decisions };
}

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
      const language = understood(raw, options);
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
    run: async ({ ir, language }, ctx) => {
      const settled = await settleData(options, language, ir);
      for (const d of settled.decisions) ctx.log.add('ResolveData', d.kind, d.message, d.data);
      if (!Object.keys(ir.data).length) ctx.log.add('ResolveData', 'info', 'no data to resolve');
      for (const a of ir.assumptions) ctx.log.add('ResolveData', 'assumption', a.text, { at: a.at ?? '' });
      const checked = validateIr(settled.ir);
      if (!checked.ok) throw Object.assign(new Error(checked.issues.map((i) => `${i.path}: ${i.message}`).join('; ')), { issues: checked.issues });
      return { ir: checked.ir, language: { ...language, issues: settled.issues }, values: settled.values };
    },
  };

  const resolvePageStage: Stage<z.infer<typeof WithIr>, z.infer<typeof WithPages>> = {
    name: 'ResolvePage',
    output: WithPages,
    run: ({ ir, language, values }, ctx) => {
      const kb = options.knowledge;
      const pages: Record<string, string | null> = {};
      const issues = [...language.issues];
      for (const [k, s] of ir.steps.entries()) {
        const name = s.action === 'NAVIGATE' && s.target?.ontology === 'Page' ? s.target.name : undefined;
        if (!name || name in pages) continue;
        // The stored page first (PK-01): its route, joined to the base address. A name two pages share is a question, never a pick.
        const stored = resolvePage(kb, name);
        if (stored.status === 'many') {
          pages[name] = pageRoutes[name] ?? null;
          issues.push({
            code: 'AMBIGUOUS',
            severity: 'review',
            where: `step ${s.id.slice(1)}`,
            original: s.original,
            message: `"${name}" fits more than one stored page: ${stored.pages.map((p) => p.name).join(', ')}`,
            suggestion: 'Say which page: use its full name.',
          });
          ctx.log.add('ResolvePage', 'warning', `${name} fits ${stored.pages.length} stored pages: none is chosen`);
          continue;
        }
        const page = stored.pages[0];
        const route = page?.route === undefined ? undefined : `${kb?.baseUrl ?? ''}${page.route}`;
        pages[name] = route ?? pageRoutes[name] ?? null;
        if (page)
          ctx.log.add('ResolvePage', 'decision', `${name} is the stored page "${page.name}"${route ? ` (${route})` : ', which has no route stored'}`, {
            step: ir.steps[k]?.id ?? '',
          });
        else
          ctx.log.add(
            'ResolvePage',
            'decision',
            pages[name] ? `${name} is ${pages[name]}` : `${name} has no known address: found when the application is explored`,
          );
      }
      if (!Object.keys(pages).length) ctx.log.add('ResolvePage', 'info', 'no page to resolve');
      return { ir, language: { ...language, issues }, values, pages };
    },
  };

  const resolveTarget: Stage<z.infer<typeof WithPages>, z.infer<typeof WithPages>> = {
    name: 'ResolveTarget',
    output: WithPages,
    run: (input, ctx) => {
      const kb = options.knowledge;
      const { ir } = input;
      const issues = [...input.language.issues];
      const known = new Set<string>();
      let toLocate = 0;
      // Each name is brought to the one component it stands for (LU-01), searched on the page the test case is on first (CX-04).
      const contexts = buildContexts(ir.testCase.id, ir.steps, ir.expectations);
      const settle = (target: (typeof ir.steps)[number]['target'], page: string | undefined, where: string, original: string) => {
        if (!target?.name) return target;
        const found = consolidate(kb, target.name, { page });
        if (found.status === 'one') {
          const one = found.components[0] as (typeof found.components)[number];
          const key = `${target.name}|${one.page}|${one.component.name}`;
          if (!known.has(key)) {
            known.add(key);
            ctx.log.add('ResolveTarget', 'decision', `"${target.name}" is the component "${one.component.name}" of the page "${one.page}"`);
          }
          // A class the application's knowledge gives replaces "some element".
          const ontology = target.ontology === 'Element' ? one.component.ontology : target.ontology;
          return { ...target, ontology, component: one.component.name, page: one.page };
        }
        if (found.status === 'many') {
          issues.push({
            code: 'AMBIGUOUS',
            severity: 'review',
            where,
            original,
            message: `"${target.name}" fits more than one component: ${found.components.map((c) => `${c.component.name} (${c.page})`).join(', ')}`,
            suggestion: 'Name the one meant: write its full name, or the page it is on.',
          });
          ctx.log.add('ResolveTarget', 'warning', `"${target.name}" fits ${found.components.length} components: none is chosen`);
        }
        return target;
      };
      const steps = ir.steps.map((s) => {
        if (s.action !== 'NAVIGATE') toLocate++;
        if (!s.target || s.action === 'NAVIGATE') return s;
        return { ...s, target: settle(s.target, contexts.get(s.id)?.page, `step ${s.id.slice(1)}`, s.original) };
      });
      const expectations = ir.expectations.map((e) => {
        const target = e.condition.target;
        if (!target?.name || target.ontology === 'Page') return e;
        const page = e.afterStep ? contexts.get(e.afterStep)?.page : undefined;
        return { ...e, condition: { ...e.condition, target: settle(target, page, `check ${e.id}`, e.clause) } };
      });
      // What the knowledge does not settle is found on the real page, by the candidate levels of LC-01 (see src/engine/locate).
      ctx.log.add(
        'ResolveTarget',
        'decision',
        `${toLocate} element(s) are located on the real page, by the candidate levels${kb ? ` ("${kb.name}" knowledge, version ${kb.version})` : ''}${kb?.screens?.length ? `; ${kb.screens.length} screen(s) are known from runs and walkthroughs (E0.14)` : ''}`,
      );
      return { ...input, ir: { ...ir, steps, expectations }, language: { ...input.language, issues } };
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

  return [read, understand, validate, buildIr, resolveData, resolvePageStage, resolveTarget, buildPlan, validatePlan];
}

/** The compilation stages come first, then Execute (run by the caller, which owns the browser). */
export const COMPILE_STAGE_NAMES = STAGE_NAMES.filter((n) => n !== 'Execute');
