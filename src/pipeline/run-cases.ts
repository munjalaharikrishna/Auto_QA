import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type RunEvent, runWorkspace } from '../executor/runner.js';
import { type ExplorationResult, explore, type Resolver } from '../explorer/controller.js';
import { loadPageUrls, savePageUrls } from '../explorer/page-store.js';
import { type GenerateInput, generateProject, workspaceName, writeProject } from '../generator/index.js';
import { automationId } from '../generator/names.js';
import { openSession } from '../locators/session.js';
import type { TestModel } from '../model/test-model.js';
import type { ParserConfig } from '../parser/config.js';
import type { TestVerdict } from '../results/verdict.js';

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
  onProgress?: (message: string) => void;
  onRunEvent?: (event: RunEvent) => void;
}

export interface PipelineResult {
  verdicts: TestVerdict[];
  workspace?: string;
  executionId?: string;
}

export async function runCases(models: TestModel[], options: PipelineOptions): Promise<PipelineResult> {
  const progress = options.onProgress ?? (() => {});
  const exploreDir = options.exploreDir ?? path.join('.auto-qa', 'explore');
  const early = new Map<string, TestVerdict>();
  const explored: GenerateInput[] = [];
  let pageUrls = await loadPageUrls(options.baseUrl);

  for (const model of models) {
    const unparsed = [...model.steps, ...model.assertions].filter((x) => x.status === 'unparsed');
    if (unparsed.length) {
      // Nothing to explore until the tester rewrites these; no browser needed to say so.
      early.set(model.id, stopped(model, 'NEEDS REVIEW', `${unparsed.map((x) => `${x.id} "${x.raw}": ${x.reason?.text ?? ''}`).join(' ')}`));
      progress(`? ${model.id}: needs review before it can be automated`);
      continue;
    }

    const file = path.join(exploreDir, model.id, 'exploration.json');
    let result: ExplorationResult | undefined;
    if (!options.reexplore && existsSync(file)) {
      const saved = JSON.parse(await readFile(file, 'utf8')) as ExplorationResult;
      if (saved.status === 'complete' && saved.baseUrl === options.baseUrl && sameSteps(saved, model)) result = saved;
    }
    if (!result) {
      progress(`… ${model.id}: exploring`);
      const before = options.questions?.().length ?? 0;
      const session = await openSession({ headless: options.headless ?? true, testIdAttribute: options.testIdAttribute });
      try {
        result = await explore(model, session, {
          config: options.config,
          baseUrl: options.baseUrl,
          env: options.env,
          pageUrls,
          resolver: options.resolver,
          outDir: path.dirname(file),
          login: model.preconditions.some((p) => p.kind === 'logged-in') ? options.login : undefined,
        });
      } finally {
        await session.close();
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(result, null, 2));
      await savePageUrls(options.baseUrl, result.learnedPageUrls);
      pageUrls = { ...pageUrls, ...result.learnedPageUrls };
      if (result.status !== 'complete') {
        const asked = options.questions?.().slice(before) ?? [];
        early.set(model.id, fromExploration(model, result, asked));
        progress(`${early.get(model.id)?.status === 'BLOCKED' ? '■' : '?'} ${model.id}: ${early.get(model.id)?.reason}`);
        continue;
      }
    }
    explored.push({ model, exploration: result });
  }

  let workspace: string | undefined;
  let executionId: string | undefined;
  const ran = new Map<string, TestVerdict>();
  if (explored.length) {
    workspace = options.workspace ?? path.join('workspaces', workspaceName(options.baseUrl));
    progress(`… generating ${explored.length} test(s) into ${workspace}`);
    const { files } = await generateProject(explored, path.basename(workspace));
    // The project holds exactly this run's tests, so an old test or page for a changed case cannot linger.
    for (const dir of ['tests', 'pages', 'locators', 'data']) await rm(path.join(workspace, dir), { recursive: true, force: true });
    await writeProject(workspace, files);
    progress('… running');
    const run = await runWorkspace(workspace, {
      testIds: explored.map((e) => e.model.id),
      env: options.env,
      runsDir: options.runsDir,
      onEvent: options.onRunEvent,
    });
    executionId = run.executionId;
    for (const v of run.verdicts) ran.set(v.testId, v);
  }

  const verdicts = models.map((m) => ran.get(m.id) ?? early.get(m.id)).filter((v): v is TestVerdict => !!v);
  for (const v of verdicts) if (executionId && !ran.has(v.testId)) v.executionId = executionId;
  return { verdicts, workspace, executionId };
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
  if (failed?.error && /^Set [A-Z_]+/.test(failed.error)) return stopped(model, 'BLOCKED', failed.error, `${failed.id} ${failed.raw}`, 'Test Data');
  if (failed?.error && /net::ERR_|ECONNREFUSED|ENOTFOUND/i.test(failed.error)) {
    return stopped(model, 'BLOCKED', 'The application could not be reached.', `${failed.id} ${failed.raw}`, 'Network');
  }
  const why = [
    ...(failed ? [`${failed.id} "${failed.raw}": ${failed.error ?? failed.warnings.at(-1) ?? 'could not be done'}`] : []),
    ...skipped.map((s) => `${s.id} "${s.raw}": ${s.warnings.at(-1) ?? 'skipped'}`),
    ...(result.status === 'aborted' ? ['Exploration was stopped.'] : []),
  ];
  const reason = why.length ? why.join(' ') : (questions[0] ?? 'Exploration did not finish.');
  return stopped(model, 'NEEDS REVIEW', reason, failed ? `${failed.id} ${failed.raw}` : skipped[0] ? `${skipped[0].id} ${skipped[0].raw}` : undefined);
}

function stopped(model: TestModel, status: 'NEEDS REVIEW' | 'BLOCKED', reason: string, failedStep?: string, category?: TestVerdict['category']): TestVerdict {
  return {
    executionId: '',
    testId: model.id,
    title: model.title,
    automationId: automationId(model.id),
    status,
    category,
    failedStep,
    reason,
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
