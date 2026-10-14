import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type AssistProvider, noAssist } from '../assist/provider.js';
import { CATEGORY, type CompileResult, compileCase, type EngineKind, type Issue, preflightOf } from '../engine/index.js';
import { nextExecutionId, type RunEvent, runWorkspace } from '../executor/runner.js';
import { type ExplorationResult, explore, type Resolver } from '../explorer/controller.js';
import { type Explanation, explain } from '../explorer/explain.js';
import { filePageStore, type PageStore } from '../explorer/page-store.js';
import { type GenerateInput, generateProject, workspaceName, writeProject } from '../generator/index.js';
import { automationId } from '../generator/names.js';
import { planProject } from '../generator/plan.js';
import { openSession } from '../locators/session.js';
import type { TestModel } from '../model/test-model.js';
import type { ParserConfig } from '../parser/config.js';
import type { ReviewReason, TestVerdict } from '../results/verdict.js';
import { DEFAULT_POLICY, observeUnclearChecks, type Policy } from './policy.js';
import { runSemanticJobs, type SemanticJob, semanticSupport } from './semantic-run.js';

/**
 * The whole flow for a set of test cases (M6): parse → explore → generate → run → verdict.
 * A case that cannot be automated yet still gets a verdict, from the stage where it stopped:
 * NEEDS REVIEW for unreadable steps or unanswered questions, BLOCKED for missing values (FR-VAL-05).
 * M6b runs a whole workbook through this.
 */

export interface PipelineOptions {
  config: ParserConfig;
  baseUrl: string;
  env: Record<string, string | undefined>;
  resolver: Resolver;
  /** Questions the resolver was asked, collected per case for the review queue (FR-HI-07). */
  questions?: () => string[];
  testIdAttribute?: string;
  headless?: boolean;
  /** The generated project. Default: workspaces/<site>. */
  workspace?: string;
  /** Where explorations are kept. Default: .auto-qa/explore. */
  exploreDir?: string;
  /** Where run records and evidence are kept. Default: .auto-qa/runs. */
  runsDir?: string;
  /** Test case to run first for "Logged in" preconditions. */
  login?: TestModel;
  /** Explore again even when a complete exploration is already saved. */
  reexplore?: boolean;
  /** How much may be decided without asking (D30). Default: balanced. */
  policy?: Policy;
  /** Where learned page URLs are kept. Default: `.auto-qa/pages.json`; the server uses the database. */
  pages?: PageStore;
  /** Called with each new exploration after its file is written, so it can be recorded (DATABASE.md §5.5). */
  onExplored?: (model: TestModel, result: ExplorationResult, file: string) => void | Promise<void>;
  /** The next `EXEC-…` id. Default: a counter file in the runs folder; the server uses the database. */
  nextExecutionId?: () => Promise<string>;
  /** A word the tester just named an element for, to keep as a project rule (FR-RULE-01). */
  onRule?: (rule: { kind: 'element'; pattern: string; meaning: string }) => void;
  onProgress?: (message: string) => void;
  onRunEvent?: (event: RunEvent) => void;
  /** Optional helper for unreadable steps (FR-AI-01). Default: none. */
  assist?: AssistProvider;
  /** `legacy` (default) runs exactly as before. `semantic` first compiles every case to QA-IR with a decision log (E0.1). */
  engine?: EngineKind;
  /** Called with each case's compilation, when the engine is `semantic`. */
  onCompiled?: (result: CompileResult) => void | Promise<void>;
}

export interface PipelineResult {
  verdicts: TestVerdict[];
  workspace?: string;
  executionId?: string;
}

/** What exploring and generating produced, before anything runs: the plan the tester reviews (FR-RV-01). */
export interface Prepared {
  /** Cases that are explored and generated, ready to run. */
  explored: GenerateInput[];
  /** Cases that stopped before generation, with their verdict (NEEDS REVIEW or BLOCKED). */
  early: Map<string, TestVerdict>;
  workspace?: string;
  /** Generated files that are new or changed, with what was there before (FR-RV-04). */
  changes: Array<{ path: string; before?: string; after: string }>;
  /**
   * Cases the legacy route stopped on that the new engine understood and the verdict engine can judge, offered to run through it
   * (semantic engine only). Each also has its legacy stop in `early`, which stays the answer unless the new run gives a verdict.
   */
  semantic?: Map<string, SemanticJob>;
}

/** parse → explore → generate → run → verdict. */
export async function runCases(models: TestModel[], options: PipelineOptions): Promise<PipelineResult> {
  const prepared = await prepareCases(models, options);
  return executeCases(models, prepared, options);
}

/** Explores each case (or reuses its exploration) and writes the generated project. Nothing runs yet. */
export async function prepareCases(models: TestModel[], options: PipelineOptions): Promise<Prepared> {
  const progress = options.onProgress ?? (() => {});
  const exploreDir = options.exploreDir ?? path.join('.auto-qa', 'explore');
  const early = new Map<string, TestVerdict>();
  const semantic = new Map<string, SemanticJob>();
  const explored: GenerateInput[] = [];
  const pages = options.pages ?? filePageStore(options.baseUrl);
  let pageUrls = await pages.load();

  /** Complete explorations from this run by case signature: an identical case is not explored twice. */
  const bySignature = new Map<string, ExplorationResult>();

  const policy = options.policy ?? DEFAULT_POLICY;
  for (const [index, original] of models.entries()) {
    // A check nothing can verify does not stop the test (balanced and lenient); under strict it is asked about.
    const model = policy === 'strict' ? original : observeUnclearChecks(original);
    const at = `[${index + 1}/${models.length}] ${model.id}`;
    let compiledOf: CompileResult | undefined;
    /** The legacy route could not finish this case: offer it to the new run, if the new engine understood it and the verdict engine judges every check. */
    const offerSemantic = (m: TestModel): boolean => {
      if (options.engine !== 'semantic' || !compiledOf || !semanticSupport(compiledOf).ok) return false;
      semantic.set(m.id, { model: m, compiled: compiledOf, baseUrl: options.baseUrl, headless: options.headless, testIdAttribute: options.testIdAttribute });
      return true;
    };
    if (options.engine === 'semantic') {
      const compiled = await compileCase(
        {
          id: original.id,
          title: original.title,
          type: original.type,
          preconditions: original.source.rawPreconditions,
          steps: original.source.rawSteps,
          testData: original.source.rawTestData,
          expected: original.source.rawExpected,
          requirementId: original.requirementId,
          row: original.source.row,
        },
        { config: options.config, pageRoutes: await pages.load(), env: options.env },
      );
      const dir = path.join(exploreDir, original.id);
      await mkdir(dir, { recursive: true });
      if (compiled.ir)
        await writeFile(
          path.join(dir, 'qa-ir.json'),
          `${JSON.stringify(compiled.ir, null, 2)}
`,
        );
      await writeFile(
        path.join(dir, 'decision-log.json'),
        `${JSON.stringify({ status: compiled.status, versions: compiled.versions, log: compiled.log }, null, 2)}
`,
      );
      compiledOf = compiled;
      await options.onCompiled?.(compiled);
      progress(`… ${at}: compiled (${compiled.status}), ${compiled.log.length} decision(s) logged`);
      // A stage that broke its contract is an engine fault, not a test result: say so instead of running on a bad plan.
      if (compiled.status === 'error') {
        early.set(model.id, stopped(model, 'NEEDS REVIEW', `The new engine could not compile this test case (${compiled.error}).`));
        continue;
      }
    }
    // The new engine decides what needs a person: its own reasons, in the tester's words, replace the legacy parser's questions.
    let newEngineReady = false;
    if (options.engine === 'semantic' && compiledOf) {
      const reasons = reasonsOf(compiledOf.issues);
      if (preflightOf(model.title, compiledOf).status !== 'ready' && reasons.length) {
        early.set(model.id, stopped(model, 'NEEDS REVIEW', reasonText(reasons), undefined, undefined, reasons));
        progress(`? ${at}: needs review: ${reasons.length} thing(s) the new engine did not understand or cannot decide`);
        continue;
      }
      newEngineReady = true;
    }
    const unparsed = [...model.steps, ...model.assertions].filter((x) => x.status === 'unparsed');
    if (unparsed.length && newEngineReady) {
      // The new engine understood every step and check, but running a case is still done by the legacy parser (E1.0 switches it over).
      const reasons: ReviewReason[] = [
        {
          id: model.id,
          raw: unparsed.map((x) => x.raw).join(' | '),
          headline: 'Understood, but not yet runnable.',
          why: 'The new engine understands this test case. Running it still goes through the old parser, which does not read these sentences; the switch-over to the new engine (E1.0) is not done.',
          todo: ['Nothing to rewrite for the new engine. Until the switch-over, reword these sentences in the simpler form the old parser reads.'],
        },
      ];
      early.set(model.id, stopped(model, 'NEEDS REVIEW', reasonText(reasons), undefined, undefined, reasons));
      progress(`? ${at}: understood by the new engine, not yet runnable${offerSemantic(model) ? ', offered to the new run' : ''}`);
      continue;
    }
    if (unparsed.length) {
      // Nothing to explore until the tester rewrites these; no browser needed to say so.
      const assist = options.assist ?? noAssist;
      const reasons = await Promise.all(
        unparsed.map(async (x): Promise<ReviewReason> => {
          const reason = x.reason?.text ?? '';
          const suggestion = await assist.suggestRewrite({ raw: x.raw, kind: 'source' in x ? 'check' : 'step', reason });
          const e = explain({ code: x.reason?.code ?? 'NO_PATTERN', raw: x.raw, text: reason });
          return { id: x.id, raw: x.raw, ...e, todo: suggestion ? [`Try: "${suggestion}"`, ...e.todo] : e.todo };
        }),
      );
      early.set(model.id, stopped(model, 'NEEDS REVIEW', reasonText(reasons), undefined, undefined, reasons));
      progress(`? ${at}: needs review before it can be automated`);
      continue;
    }

    const file = path.join(exploreDir, model.id, 'exploration.json');
    const signature = signatureOf(model);
    let result: ExplorationResult | undefined;
    if (!options.reexplore && existsSync(file)) {
      const saved = JSON.parse(await readFile(file, 'utf8')) as ExplorationResult;
      // Explorations saved before the login steps were recorded cannot be generated on their own.
      const stale = saved.items.some((i) => i.phase === 'setup') && !saved.setup;
      if (saved.status === 'complete' && saved.baseUrl === options.baseUrl && sameSteps(saved, model) && !stale) result = saved;
    }
    const twin = bySignature.get(signature);
    if (!result && twin) {
      result = { ...twin, testId: model.id, title: model.title };
      progress(`✔ ${at}: same steps as ${twin.testId}, exploration reused`);
    }
    if (!result) {
      progress(`… ${at}: exploring`);
      const before = options.questions?.().length ?? 0;
      try {
        const session = await openSession({ headless: options.headless ?? true, testIdAttribute: options.testIdAttribute });
        try {
          result = await explore(model, session, {
            config: options.config,
            baseUrl: options.baseUrl,
            env: options.env,
            pageUrls,
            resolver: options.resolver,
            outDir: path.dirname(file),
            policy,
            onRule: options.onRule,
            login: model.preconditions.some((p) => p.kind === 'logged-in') ? options.login : undefined,
          });
        } finally {
          await session.close();
        }
      } catch (e) {
        // One case must not stop a batch (FR-IN-08): the browser or the app failed under it.
        const message = (e as Error).message.split('\n')[0];
        early.set(
          model.id,
          stopped(
            model,
            'BLOCKED',
            `Exploration stopped: ${message}`,
            undefined,
            /net::ERR_|ECONNREFUSED|ENOTFOUND/i.test(message) ? 'Network' : 'Environment',
          ),
        );
        progress(`■ ${at}: ${message}`);
        continue;
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(result, null, 2));
      await pages.save(result.learnedPageUrls);
      await options.onExplored?.(model, result, file);
      pageUrls = { ...pageUrls, ...result.learnedPageUrls };
      if (result.status !== 'complete') {
        const asked = options.questions?.().slice(before) ?? [];
        early.set(model.id, fromExploration(model, result, asked));
        const offered = early.get(model.id)?.status === 'NEEDS REVIEW' && offerSemantic(model);
        progress(`${early.get(model.id)?.status === 'BLOCKED' ? '■' : '?'} ${at}: ${early.get(model.id)?.reason}${offered ? ' (offered to the new run)' : ''}`);
        continue;
      }
    }
    // Strict asks before using a value that was made up or a message that was learned (D30, D31).
    if (policy === 'strict') {
      const reasons: ReviewReason[] = [
        ...model.warnings
          .filter((w) => w.code === 'ASSUMED_VALUE')
          .map((w) => ({ id: w.at ?? '', raw: model.steps.find((s) => s.id === w.at)?.raw ?? '', ...explain({ code: 'NEEDS_VALUE', text: w.text }) })),
        ...result.items
          .filter((i) => i.learned && i.phase === 'test')
          .map((i) => ({ id: i.id, raw: i.raw, ...explain({ code: 'LEARNED', text: i.learned?.text }) })),
      ];
      if (reasons.length) {
        early.set(model.id, stopped(model, 'NEEDS REVIEW', reasonText(reasons), undefined, undefined, reasons));
        progress(`? ${at}: the Strict policy asks first`);
        continue;
      }
    }
    // One case that cannot be generated must not stop the others: check each on its own first.
    try {
      planProject([{ model, exploration: result }]);
    } catch (e) {
      early.set(model.id, stopped(model, 'NEEDS REVIEW', `Could not generate the test: ${(e as Error).message}`));
      progress(`? ${at}: ${(e as Error).message}`);
      continue;
    }
    bySignature.set(signature, result);
    explored.push({ model, exploration: result });
  }

  let workspace: string | undefined;
  const changes: Prepared['changes'] = [];
  if (explored.length) {
    workspace = options.workspace ?? path.join('workspaces', workspaceName(options.baseUrl));
    progress(`… generating ${explored.length} test(s) into ${workspace}`);
    const { files } = await generateProject(explored, path.basename(workspace));
    for (const [rel, after] of Object.entries(files)) {
      const before = await readFile(path.join(workspace, rel), 'utf8').catch(() => undefined);
      if (before !== after) changes.push({ path: rel, before, after });
    }
    // The project holds exactly this run's tests, so an old test or page for a changed case cannot linger.
    for (const dir of ['tests', 'pages', 'locators', 'data']) await rm(path.join(workspace, dir), { recursive: true, force: true });
    await writeProject(workspace, files);
  }
  return { explored, early, workspace, changes, ...(semantic.size ? { semantic } : {}) };
}

/** Runs what `prepareCases` generated and puts every case's verdict in the models' order. */
export async function executeCases(
  models: TestModel[],
  prepared: Prepared,
  options: Pick<PipelineOptions, 'env' | 'runsDir' | 'onProgress' | 'onRunEvent' | 'nextExecutionId'>,
): Promise<PipelineResult> {
  const { explored, early, workspace } = prepared;
  let executionId: string | undefined;
  const ran = new Map<string, TestVerdict>();
  if (explored.length && workspace) {
    options.onProgress?.('… running');
    const run = await runWorkspace(workspace, {
      testIds: explored.map((e) => e.model.id),
      env: options.env,
      runsDir: options.runsDir,
      nextExecutionId: options.nextExecutionId,
      onEvent: options.onRunEvent,
    });
    executionId = run.executionId;
    for (const v of run.verdicts) ran.set(v.testId, v);
  }

  // Cases the legacy route could not finish and the new engine can judge: a verdict from the new run replaces the legacy stop.
  const fromNewRun = new Map<string, TestVerdict>();
  if (prepared.semantic?.size) {
    executionId ??= await (options.nextExecutionId ?? (() => nextExecutionId(options.runsDir ?? path.join('.auto-qa', 'runs'))))();
    const screenshotDir = path.join(options.runsDir ?? path.join('.auto-qa', 'runs'), executionId, 'semantic');
    for (const [id, v] of await runSemanticJobs([...prepared.semantic.values()], { screenshotDir, onProgress: options.onProgress })) fromNewRun.set(id, v);
  }

  const verdicts = models.map((m) => ran.get(m.id) ?? fromNewRun.get(m.id) ?? early.get(m.id)).filter((v): v is TestVerdict => !!v);
  for (const v of verdicts) if (executionId && !ran.has(v.testId)) v.executionId = executionId;
  return { verdicts, workspace, executionId };
}

/** Everything that decides what exploring a case finds: identical signatures give identical explorations. */
function signatureOf(model: TestModel): string {
  return JSON.stringify([
    model.steps.map((s) => `${s.id} ${s.raw}`),
    model.assertions.map((a) => `${a.id} ${a.raw}`),
    model.data,
    model.preconditions.map((p) => p.raw),
  ]);
}

/** A saved exploration is reused only if the test case's steps and checks have not changed since. */
function sameSteps(saved: ExplorationResult, model: TestModel): boolean {
  const raws = saved.items.filter((i) => i.phase === 'test').map((i) => `${i.id}|${i.raw}`);
  const now = [...model.steps, ...model.assertions].map((x) => `${x.id}|${x.raw}`);
  return raws.length === now.length && now.every((x) => raws.includes(x));
}

function fromExploration(model: TestModel, result: ExplorationResult, questions: string[]): TestVerdict {
  const failed = result.items.find((i) => i.status === 'failed');
  const skipped = result.items.filter((i) => i.status === 'skipped');
  const asReason = (i: ExplorationResult['items'][number]): ReviewReason => {
    const e: Explanation = i.review ?? explain({ code: 'OTHER', raw: i.raw, text: i.error ?? i.warnings.at(-1) ?? 'It could not be done.' });
    return { id: i.id, raw: i.raw, ...e };
  };
  if (failed?.error && /^Set [A-Z_]+/.test(failed.error)) return stopped(model, 'BLOCKED', failed.error, `${failed.id} ${failed.raw}`, 'Test Data');
  if (failed?.error && /net::ERR_|ECONNREFUSED|ENOTFOUND/i.test(failed.error)) {
    return stopped(model, 'BLOCKED', 'The application could not be reached.', `${failed.id} ${failed.raw}`, 'Network');
  }
  const reasons = [...(failed ? [asReason(failed)] : []), ...skipped.map(asReason)];
  const stoppedNote = result.status === 'aborted' ? ' You stopped the exploration before it finished.' : '';
  const reason = reasons.length ? reasonText(reasons) + stoppedNote : (questions[0] ?? `Exploration did not finish.${stoppedNote}`);
  return stopped(
    model,
    'NEEDS REVIEW',
    reason,
    failed ? `${failed.id} ${failed.raw}` : skipped[0] ? `${skipped[0].id} ${skipped[0].raw}` : undefined,
    undefined,
    reasons,
  );
}

/** The reasons as sentences for the results sheet: what happened and the first thing to do. */
/** What the new engine could not read or cannot decide, as the tester's review reasons. Notes that are only kept are not reasons. */
function reasonsOf(issues: readonly Issue[]): ReviewReason[] {
  const seen = new Set<string>();
  const out: ReviewReason[] = [];
  for (const i of issues) {
    if (i.severity === 'info') continue;
    const key = `${i.where}|${i.original}|${i.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: i.item ?? i.where, raw: i.original, headline: `${CATEGORY[i.code]}:`, why: i.message, todo: i.suggestion ? [i.suggestion] : [] });
  }
  return out;
}

export function reasonText(reasons: ReviewReason[]): string {
  return reasons.map((r) => `${r.id} "${r.raw}": ${r.headline} ${r.why}${r.todo[0] ? ` To fix: ${r.todo[0]}` : ''}`).join(' | ');
}

function stopped(
  model: TestModel,
  status: 'NEEDS REVIEW' | 'BLOCKED',
  reason: string,
  failedStep?: string,
  category?: TestVerdict['category'],
  review?: ReviewReason[],
): TestVerdict {
  return {
    executionId: '',
    testId: model.id,
    title: model.title,
    automationId: automationId(model.id),
    status,
    category,
    failedStep,
    reason,
    review,
    expected: model.assertions
      .map((a) => a.raw)
      .filter(Boolean)
      .join(' '),
    actual: `Not run: ${reason}`,
    steps: model.steps.map((s) => ({ id: s.id, raw: s.raw, result: 'not run' })),
    checks: model.assertions.map((a) => ({ id: a.id, raw: a.raw, expected: a.raw, actual: '', result: a.status === 'unparsed' ? 'not checked' : 'not run' })),
    durationMs: 0,
    evidence: { screenshots: [] },
  };
}
