import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { describeFile, type FileFacts } from '../db/artifacts.js';
import { compileCase, engineFrom, executePlan, keepScreens, openExecutionSession, planActions, type StepHook, type StepRecord } from '../engine/index.js';
import { knowledgeFromRuns } from '../engine/knowledge/from-runs.js';
import { labelKey } from '../engine/knowledge/labels.js';
import type { ExplorationResult, Resolver } from '../explorer/controller.js';
import { explain, sentence } from '../explorer/explain.js';
import type { PageStore } from '../explorer/page-store.js';
import { workspaceName } from '../generator/index.js';
import type { Field } from '../importer/columns.js';
import { defaultResultsFile } from '../importer/results.js';
import { learnedForRun } from '../learning/adapter.js';
import { LearningService } from '../learning/service.js';
import type { Policy } from '../model/policy.js';
import type { RawTestCase, TestModel } from '../model/test-model.js';
import { type ParserConfig, withRules } from '../parser/config.js';
import { parseTestCase } from '../parser/index.js';
import { runBatch } from '../pipeline/batch.js';
import { executeCases, type Prepared, prepareCases } from '../pipeline/run-cases.js';
import type { TestVerdict } from '../results/verdict.js';
import { readEnvFile } from './credentials.js';
import { type RecordedEvent, Recorder } from './recorder.js';
import type { Job, Project, Question, Store } from './store.js';
import { type PanelState, WalkPanel } from './walk-panel.js';
import { addCheck, changesData, editStep, finalCase, type Pending, readsBack, recordedSentence, tryOnScreen, type WalkCheck } from './walkthrough.js';

/**
 * Job runner (M7a): the command line flows as background jobs, one at a time because each drives a
 * real browser. Questions wait for the tester's answer from the UI with the browser open (D6);
 * a workbook job never waits (D22) unless it is answering its review queue.
 */

export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'log'; jobId: string; at: string; message: string }
  | { type: 'question'; question: Question }
  | { type: 'answered'; jobId: string; questionId: number };

export type Decision = { action: 'approve' } | { action: 'regenerate' } | { action: 'edit'; case: RawTestCase } | { action: 'cancel' };

export interface RunnerOptions {
  store: Store;
  config: ParserConfig;
  /** Root for per-project data: explorations, runs, uploads. */
  dataDir: string;
  headless?: boolean;
  /**
   * The walkthrough's browser: shown, so the person can use it and what they do is recorded (E0.14c). It is hidden unless this says
   * otherwise, so a test or a server without a screen still works.
   */
  walkthroughHeadless?: boolean;
}

class Cancelled extends Error {}
/** A change to the list of what a walkthrough will save: add one recorded step, add every one waiting, or remove one item. */
export type WalkEdit = { add: number } | { addAll: true } | { remove: number };
/** Nobody answered a walkthrough for too long (E0.14b): its browser is closed. */
class Idle extends Error {}
const IDLE = Symbol('idle');
/** A walkthrough left without an answer this long is closed (E0.14b, PD-13). */
export const WALKTHROUGH_IDLE_MS = 15 * 60 * 1000;

/** What the walkthrough window shows of the step a person is on: the screen after it, with a box for each element on it. */
function stepView(rec: StepRecord, size: { width: number; height: number } | null) {
  const page = rec.after;
  return {
    step: rec.step,
    original: rec.original,
    status: rec.status,
    ...(rec.reason ? { reason: rec.reason } : {}),
    changes: rec.changes.slice(0, 20),
    ...(rec.located?.picked ? { picked: true } : {}),
    view: {
      ...(rec.screenshots?.after ? { screenshot: rec.screenshots.after } : {}),
      width: size?.width ?? 1280,
      height: size?.height ?? 720,
      elements: (page?.elements ?? []).flatMap((e) =>
        e.box && e.box.width > 0 && e.box.height > 0 ? [{ ref: e.identity, role: e.role, name: e.name, box: e.box }] : [],
      ),
    },
    ...(page ? { screen: page.screen, url: page.contentUrl ?? page.url } : {}),
  };
}

const pendingView = (p: Pending) =>
  p.kind === 'check'
    ? { kind: 'check', sentence: p.sentence, afterStep: p.check.afterStep ?? 'end' }
    : p.kind === 'edit'
      ? { kind: 'edit', step: p.step, text: p.text }
      : {
          kind: 'recorded',
          sentence: p.sentence,
          ...(p.replaces ? { replaces: p.replaces } : { afterStep: p.afterStep }),
          added: !!p.confirmed,
        };

/** A pending change in the words of the version note. */
const pendingNote = (p: Pending): string =>
  p.kind === 'check' ? `+ ${p.sentence}` : p.kind === 'edit' ? `${p.step} reworded` : `${p.replaces ? `${p.replaces} done as` : '+'} ${p.sentence}`;

export class JobRunner extends EventEmitter {
  private readonly queue: string[] = [];
  private busy = false;
  private readonly answers = new Map<number, (answer: unknown) => void>();
  private readonly decisions = new Map<string, (d: Decision) => void>();
  private readonly cancelled = new Set<string>();
  /** The browser of each walkthrough that is open, where a person acts (E0.14c). */
  private readonly walkBrowsers = new Map<string, import('playwright').BrowserContext>();
  /** Adds or removes a recorded step of an open walkthrough (E0.14c): what the person does is a step only once they say so. */
  private readonly walkEdits = new Map<string, (edit: WalkEdit) => Promise<string>>();
  /** Resolves once jobs a restart interrupted are marked failed; nothing starts before then. */
  private readonly ready: Promise<void>;

  constructor(private readonly options: RunnerOptions) {
    super();
    this.ready = this.recover();
  }

  /** A restart loses the browser a job was using: say so instead of pretending it continues. */
  private async recover(): Promise<void> {
    for (const job of await this.options.store.interruptedJobs()) {
      await this.options.store.updateJob(job.id, {
        status: 'failed',
        error: 'The server stopped while this job was running. Start it again.',
        finishedAt: new Date().toISOString(),
      });
    }
  }

  /** The tabs of an open walkthrough's browser, as the person sees them; none once it is closed. For tests that act as the person. */
  walkthroughPages(jobId: string): import('playwright').Page[] {
    return this.walkBrowsers.get(jobId)?.pages() ?? [];
  }

  /** Per-project folders under the data directory. */
  projectDir(project: Project, ...parts: string[]): string {
    return path.join(this.options.dataDir, 'projects', project.id, ...parts);
  }

  enqueue(job: Job): void {
    this.queue.push(job.id);
    void this.next();
  }

  /** The tester's answer to an open question. Returns false if nothing is waiting for it. */
  async answer(questionId: number, answer: unknown): Promise<boolean> {
    const resolve = this.answers.get(questionId);
    if (!resolve) return false;
    this.answers.delete(questionId);
    const q = await this.options.store.answer(questionId, answer);
    if (q) this.emit('event', { type: 'answered', jobId: q.jobId, questionId } satisfies ServerEvent);
    resolve(answer);
    return true;
  }

  /** Approve & Execute, Edit or Regenerate for a job in review (FR-RV-03). */
  decide(jobId: string, decision: Decision): boolean {
    const resolve = this.decisions.get(jobId);
    if (!resolve) return false;
    this.decisions.delete(jobId);
    resolve(decision);
    return true;
  }

  /** Adds a recorded step, all of them, or removes one, while the walkthrough is open. Returns what was done, or throws why not. */
  async editWalkthrough(jobId: string, edit: WalkEdit): Promise<string> {
    const apply = this.walkEdits.get(jobId);
    if (!apply) throw new Error('This walkthrough is not open.');
    return apply(edit);
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.options.store.job(jobId);
    if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) return;
    this.cancelled.add(jobId);
    const queued = this.queue.indexOf(jobId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      await this.update(jobId, { status: 'cancelled', output: { ...job.output, cancelledFrom: job.status }, finishedAt: new Date().toISOString() });
      return;
    }
    this.decide(jobId, { action: 'cancel' });
    for (const q of await this.options.store.openQuestions(jobId)) await this.answer(q.id, q.kind === 'confirm' ? false : 'abort');
  }

  private async evidenceFor(verdicts: TestVerdict[], executionId?: string): Promise<Evidence> {
    const artifacts = this.options.store.artifacts;
    const out: Evidence = {};
    if (!artifacts || !executionId) return out;
    for (const v of verdicts) {
      if (v.executionId !== executionId) continue;
      const wanted: Array<{ kind: string; file: string; stepId?: string }> = [
        ...v.evidence.screenshots.map((file) => ({ kind: 'screenshot', file })),
        ...(v.evidence.trace ? [{ kind: 'trace', file: v.evidence.trace }] : []),
        ...(v.evidence.video ? [{ kind: 'video', file: v.evidence.video }] : []),
        ...(v.evidence.audit ? [{ kind: 'audit', file: v.evidence.audit }] : []),
        ...v.steps.flatMap((s) => (s.screenshot ? [{ kind: 'screenshot', file: s.screenshot, stepId: s.id }] : [])),
      ];
      for (const w of wanted) {
        const facts = await describeFile(artifacts, w.file);
        if (facts) (out[v.testId] ??= []).push({ ...facts, kind: w.kind, stepId: w.stepId });
      }
    }
    return out;
  }

  private async update(jobId: string, changes: Parameters<Store['updateJob']>[1]): Promise<Job> {
    const job = await this.options.store.updateJob(jobId, changes);
    this.emit('event', { type: 'job', job } satisfies ServerEvent);
    return job;
  }

  /** Progress lines are written in the order given; a write that fails must not stop the job. */
  private async log(jobId: string, message: string): Promise<void> {
    try {
      await this.options.store.log(jobId, message);
    } catch (e) {
      console.error(`Could not save a log line for ${jobId}: ${(e as Error).message}`);
    }
    this.emit('event', { type: 'log', jobId, at: new Date().toISOString(), message } satisfies ServerEvent);
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    await this.ready;
    const id = this.queue.shift();
    if (!id) {
      this.busy = false;
      return;
    }
    try {
      const job = await this.options.store.job(id);
      if (!job) return;
      await this.update(id, { status: 'running', startedAt: new Date().toISOString() });
      if (job.kind === 'workbook') await this.runWorkbook(job);
      else if (job.kind === 'walkthrough') await this.runWalkthrough(job);
      else await this.runSingle(job);
    } catch (e) {
      if (e instanceof Cancelled || this.cancelled.has(id)) {
        // Remember where it was stopped, so the list can say "cancelled while waiting for your review".
        const at = await this.options.store.job(id);
        await this.update(id, { status: 'cancelled', output: { ...at?.output, cancelledFrom: at?.status }, finishedAt: new Date().toISOString() });
      } else await this.update(id, { status: 'failed', error: (e as Error).message, finishedAt: new Date().toISOString() });
    } finally {
      this.cancelled.delete(id);
      this.busy = false;
      void this.next();
    }
  }

  /** Waits for Approve & Execute, Edit, Regenerate or Cancel. A job cancelled already gets Cancel at once. */
  private decision(jobId: string): Promise<Decision> {
    if (this.cancelled.has(jobId)) return Promise.resolve({ action: 'cancel' });
    return new Promise<Decision>((resolve) => this.decisions.set(jobId, resolve));
  }

  /** A resolver that asks through the UI and waits (interactive), or never waits (unattended, D22). */
  private resolver(job: Job, interactive: boolean, asked: string[]): Resolver {
    const ask = async (kind: Question['kind'], payload: Record<string, unknown>): Promise<unknown> => {
      if (this.cancelled.has(job.id)) throw new Cancelled();
      const q = await this.options.store.ask(job.id, kind, payload);
      await this.update(job.id, { status: 'waiting' });
      this.emit('event', { type: 'question', question: q } satisfies ServerEvent);
      const answer = await new Promise<unknown>((resolve) => this.answers.set(q.id, resolve));
      if (this.cancelled.has(job.id)) throw new Cancelled();
      await this.update(job.id, { status: 'running' });
      return answer;
    };
    return {
      async choose(r) {
        const why = explain({
          code: r.code,
          raw: r.raw,
          label: r.target,
          text: r.text,
          candidates: r.candidates.map((c) => ({ role: c.node.role, name: c.matchedName || c.node.name, score: c.score })),
        });
        asked.push(`${r.item} "${r.raw}": ${sentence(why)}`);
        if (!interactive) return 'skip';
        const candidates = r.candidates
          .slice(0, 9)
          .map((c) => ({ ref: c.node.ref, role: c.node.role, name: c.matchedName || c.node.name, score: c.score, how: c.how, notes: c.notes }));
        const a = await ask('choose', { item: r.item, raw: r.raw, code: r.code, text: r.text, explain: why, candidates, view: r.view });
        return a === 'skip' || a === 'abort' || typeof a === 'number' || (typeof a === 'object' && a && 'ref' in a) ? (a as never) : 'skip';
      },
      async pageUrl(r) {
        const why = explain({ code: 'PAGE_URL', page: r.page });
        asked.push(`${r.item}: ${sentence(why)}`);
        if (!interactive) return 'abort';
        const a = await ask('pageUrl', { item: r.item, page: r.page, explain: why });
        return typeof a === 'string' && a.trim() ? a.trim() : 'abort';
      },
      async confirm(r) {
        const why = explain({ code: r.code, text: r.text, raw: r.raw, page: r.page });
        asked.push(`${r.item}: ${sentence(why)}`);
        if (!interactive) return false;
        return (await ask('confirm', { item: r.item, code: r.code, text: r.text, explain: why })) === true;
      },
    };
  }

  /** The parser's vocabulary with this project's rules added (FR-RULE-01). */
  private async configFor(project: Project) {
    return withRules(this.options.config, (await learnedForRun(this.options.store, project.id)).rules);
  }

  /** Learned page URLs are the default environment's page routes (D19, FR-DB-08). */
  private async pagesFor(project: Project): Promise<PageStore> {
    const { store } = this.options;
    const env = await store.defaultEnvironmentId(project.id);
    return {
      load: async () => (env ? store.pageRoutes(env) : {}),
      save: async (learned) => {
        if (env) for (const [name, route] of Object.entries(learned)) await store.savePageRoute(env, name, route, 'learned');
      },
    };
  }

  private async common(project: Project, job: Job, policy: Policy, config: ParserConfig) {
    const { store } = this.options;
    return {
      policy,
      config,
      engine: engineFrom(await store.setting('project', project.id, 'engine')),
      pages: await this.pagesFor(project),
      nextExecutionId: () => store.nextExecutionId(),
      approvedAssumptions: (await learnedForRun(store, project.id)).approvedAssumptions,
      screenWords: (await learnedForRun(store, project.id)).screenLabels,
      // Each new exploration's steps become rows, with the file kept as the full record (FR-DB-10). A failed write must not stop the job.
      onExplored: async (model: TestModel, result: ExplorationResult, file: string) => {
        try {
          await store.saveExploration(project.id, {
            extId: model.id,
            jobId: job.id,
            status: result.status,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt || undefined,
            resultFile: file,
            items: result.items.map((i) => ({
              id: i.id,
              kind: i.kind,
              phase: i.phase,
              raw: i.raw,
              action: i.action,
              status: i.status,
              resolvedBy: i.resolvedBy,
              strategy: i.locator?.strategy,
              locatorCode: i.locator?.code,
              score: i.score,
              pageName: i.page?.name,
              effect: i.effect,
              screenshot: i.screenshot,
              warnings: i.warnings,
            })),
          });
        } catch (e) {
          console.error(`Could not record the exploration of ${model.id}: ${(e as Error).message}`);
        }
      },
      // A word the tester names an element for in review is remembered for the project (FR-RULE-01).
      onRule: (rule: { kind: 'element'; pattern: string; meaning: string }) =>
        void new LearningService(this.options.store)
          .saveLabel(project.id, { label: rule.pattern, means: rule.meaning }, 'picked on the screenshot', 'tester', { seenOnScreen: true })
          .catch(() => undefined),
      baseUrl: project.baseUrl,
      env: { ...process.env, ...readEnvFile(project.workspace) },
      testIdAttribute: project.testIdAttribute,
      headless: this.options.headless ?? true,
      exploreDir: this.projectDir(project, 'explore'),
      runsDir: this.projectDir(project, 'runs'),
    };
  }

  private async runWorkbook(job: Job): Promise<void> {
    const project = (await this.options.store.project(job.projectId))!;
    const config = await this.configFor(project);
    const upload = await this.options.store.upload(String(job.input.uploadId));
    if (!upload) throw new Error('The uploaded workbook is gone. Upload it again.');
    const onlyReview = job.input.onlyReview === true;
    const asked: string[] = [];
    const batch = await runBatch(upload.file, {
      ...(await this.common(project, job, await this.options.store.projectPolicy(project.id), config)),
      resolver: this.resolver(job, onlyReview, asked),
      questions: () => asked,
      workspace: project.workspace,
      progress: {
        latest: async () =>
          Object.fromEntries(Object.entries(await this.options.store.latestVerdicts(project.id)).map(([id, r]) => [id, r.verdict as TestVerdict])),
      },
      mapping: (job.input.mapping ?? {}) as Partial<Record<Field, string>>,
      onlyReview,
      overrides: await this.options.store.editedTestCases(project.id),
      onImported: async (cases) => {
        // Every case of the sheet is kept, so it can be seen in the test case list and run again.
        for (const c of cases) {
          const id = c.raw.id ?? `ROW-${c.row}`;
          await this.options.store.upsertTestCase(
            project.id,
            { ...c.raw, id },
            { kind: 'workbook', ref: upload.id, row: c.row },
            `imported from ${upload.originalName}`,
          );
        }
      },
      out: defaultResultsFile(upload.file),
      onProgress: (m) => void this.log(job.id, m),
    });
    const rows = batch.results.map((r) => ({
      testId: r.verdict?.testId ?? r.id ?? `row ${r.row}`,
      row: r.row,
      status: r.verdict?.status ?? 'NEEDS REVIEW',
      verdict: r.verdict ?? { problem: r.problem, title: r.title },
    }));
    const doneAt = new Date().toISOString();
    await this.options.store.saveRun(
      { id: job.id, projectId: project.id },
      {
        execution: batch.summary.executionId
          ? { execId: batch.summary.executionId, startedAt: job.startedAt, finishedAt: doneAt, durationMs: Date.now() - Date.parse(job.startedAt ?? doneAt) }
          : undefined,
        rows,
        evidence: await this.evidenceFor(
          batch.results.flatMap((r) => (r.verdict ? [r.verdict] : [])),
          batch.summary.executionId,
        ),
        snapshot: batch.workspace ? await manifestOf(batch.workspace) : undefined,
        recordedAt: doneAt,
      },
    );
    await this.update(job.id, {
      status: 'done',
      executionId: batch.summary.executionId,
      output: { summary: batch.summary, resultsFile: batch.out, originalName: upload.originalName, loginCase: batch.loginCase, workspace: batch.workspace },
      finishedAt: new Date().toISOString(),
    });
  }

  /**
   * Asks the person and waits (D6), at most `idleMs`: a walkthrough holds a browser open, so one left alone is closed (E0.14b). The
   * question is then answered as `timeout`, so the list of questions does not show it as still open.
   */
  private async waitFor(
    job: Job,
    kind: Question['kind'],
    payload: Record<string, unknown>,
    idleMs: number,
    onAsked?: (q: Question) => Promise<void>,
  ): Promise<unknown> {
    if (this.cancelled.has(job.id)) throw new Cancelled();
    const q = await this.options.store.ask(job.id, kind, payload);
    await this.update(job.id, { status: 'waiting' });
    this.emit('event', { type: 'question', question: q } satisfies ServerEvent);
    const answered = new Promise<unknown>((resolve) => this.answers.set(q.id, resolve));
    await onAsked?.(q);
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      answered,
      new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (answer === IDLE) {
      await this.answer(q.id, 'timeout');
      throw new Idle();
    }
    if (this.cancelled.has(job.id)) throw new Cancelled();
    await this.update(job.id, { status: 'running' });
    return answer;
  }

  /**
   * A guided walkthrough of one saved test case (E0.14b, PD-13). The new engine runs the steps in a browser, one at a time: after
   * each step the person sees the screen and goes on, adds a check, changes the step's words, or stops. A step that cannot find its
   * element asks for a pick on the screenshot, and the pick can be remembered for that screen. Before a step that changes data the
   * person is asked; on a production environment such a step is refused unless the project allows it. What the person added is saved
   * as a new version of the test case only when they say so, and only when every check reads back as itself. The screens reached are
   * kept as the person's, for the next compile.
   */
  private async runWalkthrough(job: Job): Promise<void> {
    const { store } = this.options;
    const project = await store.project(job.projectId);
    if (!project) throw new Error('The project is gone.');
    const caseId = String(job.input.caseId ?? '');
    const record = await store.testCase(project.id, caseId);
    if (!record) throw new Error(`There is no test case ${caseId} in this project.`);
    const started = Date.now();
    const who = typeof job.input.who === 'string' && job.input.who.trim() ? job.input.who.trim() : await store.currentUserName();
    const idleMs = typeof job.input.idleMs === 'number' && job.input.idleMs > 0 ? job.input.idleMs : WALKTHROUGH_IDLE_MS;
    const learned = await learnedForRun(store, project.id);
    const exploreDir = this.projectDir(project, 'explore');
    const env = { ...process.env, ...readEnvFile(project.workspace) };
    const knowledge = await knowledgeFromRuns(workspaceName(project.baseUrl), project.baseUrl, exploreDir, [...learned.labels, ...learned.screenLabels], {
      cache: false,
    });
    const compileOptions = {
      config: await this.configFor(project),
      pageRoutes: await (await this.pagesFor(project)).load(),
      env,
      ...(knowledge ? { knowledge } : {}),
    };
    const compiled = await compileCase(record.raw, compileOptions);
    if (!compiled.ir || !compiled.plan) {
      const why = compiled.issues.find((i) => i.severity === 'blocking');
      throw new Error(`The test case cannot be walked through yet: ${why ? `${why.where}: ${why.message}` : compiled.status}. Edit it first.`);
    }
    const environment = (await store.environments(project.id)).find((e) => e.isDefault);
    const production = !!environment?.isProduction;
    const allowed = (await store.setting('project', project.id, 'walkthroughOnProduction')) === 'allow';
    const plan = planActions(compiled.ir, compiled.plan);
    const origin = new URL(project.baseUrl).origin;
    const pages = Object.fromEntries(Object.entries(compiled.pages ?? {}).map(([k, v]) => [k, v?.startsWith('/') ? `${origin}${v}` : v]));
    const shots = this.projectDir(project, 'walkthroughs', job.id);
    const steps = plan.chains.map((c) => ({ step: c.step, original: c.original, status: 'to do' as string }));
    const pending: Pending[] = [];
    const headless = this.options.walkthroughHeadless ?? this.options.headless ?? true;
    /** What the recorder last could not keep, said in the window (E0.14c). */
    let recorderNote: string | undefined;
    /** The person closed the walkthrough's browser window: what was recorded before is kept, and saving is asked on the Auto QA page. */
    let browserGone = false;
    /** The person pressed Finish: the steps left are not run, and what was recorded is offered to save. */
    let finishing = false;
    const walk = () => ({
      caseId,
      version: record.version,
      who,
      steps,
      pending: pending.map(pendingView),
      production,
      recording: !headless,
      ...(recorderNote ? { recorderNote } : {}),
      ...(browserGone ? { browserClosed: true } : {}),
    });
    await this.update(job.id, { status: 'running', output: { walk: walk() } });
    await this.log(job.id, `Walkthrough of ${caseId} (version ${record.version}) by ${who}`);

    const session = await openExecutionSession({ headless, testIdAttribute: project.testIdAttribute });
    let trace: Awaited<ReturnType<typeof executePlan>> | undefined;
    let ended: 'finished' | 'stopped' | 'idle' | 'closed' = 'finished';
    let saved: number | undefined;
    /** We close the browser ourselves at the end: that is not the person closing it. */
    let closing = false;
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    this.walkBrowsers.set(job.id, session.context);
    const gone = (): void => {
      if (closing || browserGone) return;
      browserGone = true;
      markClosed();
      void (async () => {
        await this.log(job.id, `The browser window was closed. What was recorded before that is kept (${pending.length} change(s) to save).`);
        // What the walkthrough waits on in the window ends; the save question stays, on the Auto QA page.
        for (const q of await store.openQuestions(job.id)) if (q.payload.code !== 'SAVE_WALKTHROUGH') await this.answer(q.id, 'closed');
        await this.update(job.id, { output: { walk: walk() } });
      })();
    };
    session.context.on('close', gone);
    const watchClose = (p: import('playwright').Page): void => {
      p.on('close', () => {
        if (!session.context.pages().length) gone();
      });
    };
    for (const p of session.context.pages()) watchClose(p);
    session.context.on('page', watchClose);
    // The browser starts with an empty tab, and the browser tool opens its own for the application. The empty one is closed the first
    // time the walkthrough waits for the person, so they see one window. Not sooner: during its first step the engine still holds it.
    const starter = session.page;
    const closeStarter = async (): Promise<void> => {
      if (starter.isClosed() || starter.url() !== 'about:blank') return;
      if (session.context.pages().some((p) => p !== starter && !p.isClosed())) await starter.close().catch(() => undefined);
    };

    /** The question the walkthrough waits on now, shown in the window's panel too. */
    let asking: Question | undefined;
    let endWord: PanelState['ended'];
    const panelOn = job.input.panel === true || (job.input.panel !== false && !headless);
    const panel = panelOn
      ? await WalkPanel.attach(
          session.context,
          async (questionId, answer) => {
            if (asking?.id === questionId) await this.answer(questionId, answer);
          },
          (edit) => editPending(edit).then(() => undefined),
        )
      : undefined;
    const panelState = (): PanelState => {
      const p = (asking?.payload ?? {}) as Record<string, unknown>;
      const text = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
      return {
        caseId,
        steps,
        recorded: pending.flatMap((x, index) => (x.kind === 'recorded' ? [{ sentence: x.sentence, index, added: !!x.confirmed }] : [])),
        ...(recorderNote ? { note: recorderNote } : {}),
        ...(asking
          ? {
              question: {
                id: asking.id,
                kind: asking.kind,
                code: text('code'),
                text: text('text'),
                step: text('step') ?? text('item'),
                original: text('original') ?? text('raw'),
                ...(Array.isArray(p.notRun) ? { notRun: p.notRun as string[] } : {}),
                ...(typeof p.recorded === 'number' ? { recorded: p.recorded } : {}),
              },
            }
          : {}),
        ...(endWord ? { ended: endWord } : {}),
      };
    };
    const showPanel = async (): Promise<void> => {
      if (panel && !browserGone) await panel.show(panelState());
    };
    /** Adds a recorded step (or every one waiting), or removes an item, from the window's panel or the Auto QA page (E0.14c). */
    const editPending = async (edit: WalkEdit & { sentence?: string }): Promise<string> => {
      let said: string;
      if ('addAll' in edit) {
        let n = 0;
        for (const p of pending)
          if (p.kind === 'recorded' && !p.confirmed) {
            p.confirmed = true;
            n++;
          }
        said = `+ added ${n} recorded step(s)`;
      } else {
        const i = 'add' in edit ? edit.add : edit.remove;
        const p = Number.isInteger(i) ? pending[i] : undefined;
        if (!p) throw new Error('There is nothing there.');
        // The list may have changed since the person saw it: the words say which item they meant.
        if (edit.sentence !== undefined && (p.kind === 'edit' ? p.text : p.sentence) !== edit.sentence)
          throw new Error('The list changed meanwhile: look again and try once more.');
        if ('add' in edit) {
          if (p.kind !== 'recorded') throw new Error('Only a recorded step is added.');
          p.confirmed = true;
          said = `+ added: ${p.sentence}`;
        } else {
          pending.splice(i, 1);
          said = `- removed: ${pendingNote(p)}`;
        }
      }
      await this.log(job.id, said);
      await this.update(job.id, { output: { walk: walk() } });
      await showPanel();
      return said;
    };
    this.walkEdits.set(job.id, editPending);
    /**
     * Asks the person, in the Auto QA page and in the window's panel. The panel is hidden again before the walkthrough goes on, so it is
     * never in the engine's way. With the browser closed, a question about the window is answered `closed` at once.
     */
    const ask = async (kind: Question['kind'], payload: Record<string, unknown>, opts: { window?: boolean } = { window: true }): Promise<unknown> => {
      if (opts.window && browserGone) return 'closed';
      try {
        return await this.waitFor(job, kind, payload, idleMs, async (q) => {
          asking = q;
          if (opts.window && browserGone) await this.answer(q.id, 'closed');
          else {
            await closeStarter();
            await showPanel();
          }
        });
      } finally {
        asking = undefined;
        await showPanel();
      }
    };

    try {
      try {
        // What the person does in the browser while the walkthrough waits is recorded as steps of the test case (E0.14c).
        const recorder = await Recorder.attach(session.context, {
          testIdAttribute: project.testIdAttribute,
          onError: (e) => void this.log(job.id, `The recorder missed an action: ${(e as Error).message}`),
        });
        const login = { username: env.TEST_USERNAME, password: env.TEST_PASSWORD };
        /** The elements recorded in place of each step done by hand, to remember for the words of that step. */
        const byHand = new Map<string, RecordedEvent[]>();
        const keep = (where: { afterStep: string } | { replaces: string }) => async (event: RecordedEvent) => {
          const made = recordedSentence(event, login);
          const problem = 'why' in made ? made.why : await readsBack(made.sentence, event, compileOptions);
          if ('why' in made || problem) {
            recorderNote = `Not recorded: ${problem}`;
            await this.log(job.id, recorderNote);
          } else {
            recorderNote = made.note ? `Recorded "${made.sentence}": ${made.note}.` : undefined;
            // A step only once the person says so: a click that was not meant as one is not saved (E0.14c).
            pending.push({ kind: 'recorded', sentence: made.sentence, ...where, confirmed: false });
            if ('replaces' in where) byHand.set(where.replaces, [...(byHand.get(where.replaces) ?? []), event]);
            await this.log(
              job.id,
              `● recorded ${'replaces' in where ? `for ${where.replaces}` : `after ${where.afterStep}`}, waiting for your OK: ${made.sentence}`,
            );
          }
          await this.update(job.id, { output: { walk: walk() } });
          await showPanel();
        };
        /** Waits for the person, recording what they do in the browser meanwhile. */
        const recording = async <T>(where: { afterStep: string } | { replaces: string }, wait: () => Promise<T>): Promise<T> => {
          await recorder.listen(keep(where));
          try {
            return await wait();
          } finally {
            recorder.stop();
            await recorder.idle();
          }
        };

        // A case that starts logged in is logged in first by the login case of the workbook it came from, without stopping (E7).
        if (compiled.ir.preconditions.some((p) => p.type === 'LOGGED_IN')) await this.loginFirst(job, project, compileOptions, session, pages);
        const hook: StepHook = {
          before: async (chain, i) => {
            if (finishing || browserGone) return 'stop';
            steps[i] = { ...(steps[i] as (typeof steps)[number]), status: 'running' };
            if (!changesData(chain)) return 'go';
            if (production && !allowed) {
              await this.log(
                job.id,
                `■ ${chain.step} "${chain.original}" would change data on a production environment: not run (the project does not allow it)`,
              );
              return 'stop';
            }
            const yes = await ask('confirm', {
              walkthrough: true,
              item: chain.step,
              raw: chain.original,
              code: 'CHANGES_DATA',
              text: `This step will change data: "${chain.original}". Continue?`,
            });
            return yes === true ? 'go' : 'stop';
          },
          after: async (rec, i) => {
            steps[i] = { ...(steps[i] as (typeof steps)[number]), status: rec.status };
            let last: Record<string, unknown> | undefined;
            for (;;) {
              await this.update(job.id, { output: { walk: walk() } });
              const a = await recording({ afterStep: rec.step }, () =>
                ask('step', {
                  walkthrough: true,
                  ...stepView(rec, session.page.viewportSize()),
                  steps,
                  pending: pending.map(pendingView),
                  ...(last ? { last } : {}),
                }),
              );
              if (a === 'next') return 'go';
              if (a === 'finish') {
                finishing = true;
                await this.log(job.id, `Finished after ${rec.step}: the steps left are not run`);
                return 'stop';
              }
              if (a === 'stop' || a === 'abort' || a === 'closed') return 'stop';
              const asked = (a ?? {}) as { check?: WalkCheck; edit?: { text?: unknown }; drop?: unknown };
              if (typeof asked.drop === 'number') {
                const [dropped] = Number.isInteger(asked.drop) ? pending.splice(asked.drop, 1) : [];
                last = dropped ? { ok: true, message: `Removed: ${pendingNote(dropped)}` } : { ok: false, message: 'There is nothing there to remove.' };
                if (dropped) await this.log(job.id, `− removed: ${pendingNote(dropped)}`);
                continue;
              }
              if (asked.check) {
                const check: WalkCheck = { ...asked.check, ...(asked.check.afterStep === 'end' ? { afterStep: undefined } : { afterStep: rec.step }) };
                const placed = await addCheck(record.raw, check, compileOptions);
                if (!placed.ok) {
                  last = { ok: false, sentence: placed.sentence, message: placed.why };
                  continue;
                }
                pending.push({ kind: 'check', check, sentence: placed.sentence });
                const tried = check.afterStep ? tryOnScreen(placed.expectation, rec) : undefined;
                last = {
                  ok: true,
                  sentence: placed.sentence,
                  ...(tried ? { result: tried.result, message: tried.why } : { message: 'It is judged after the last step.' }),
                };
                await this.log(
                  job.id,
                  `+ check after ${check.afterStep ?? 'the last step'}: ${placed.sentence}${tried ? ` (on this screen now: ${tried.result})` : ''}`,
                );
                continue;
              }
              if (asked.edit && typeof asked.edit.text === 'string') {
                try {
                  editStep(record.raw, rec.step, asked.edit.text);
                  pending.push({ kind: 'edit', step: rec.step, text: asked.edit.text });
                  last = {
                    ok: true,
                    message: `${rec.step} will read "${asked.edit.text.trim()}" once saved. This walkthrough goes on with the step as it was.`,
                  };
                } catch (e) {
                  last = { ok: false, message: (e as Error).message };
                }
                continue;
              }
              last = { ok: false, message: 'That answer is not understood.' };
            }
          },
          pick: async (request) => {
            const a = await recording({ replaces: request.step }, () =>
              ask('choose', { walkthrough: true, item: request.step, raw: request.original, code: request.code, text: request.reason, view: request.view }),
            );
            const done = byHand.get(request.step) ?? [];
            if (a === 'finish' || a === 'closed') {
              // Ended here: what was done by hand for this step is kept in its place.
              if (a === 'finish') {
                finishing = true;
                await this.log(job.id, `Finished at ${request.step}: the steps left are not run`);
              }
              return undefined;
            }
            if (a === 'manual') {
              // "I did this step myself" is the OK for what was recorded for it.
              for (const p of pending) if (p.kind === 'recorded' && p.replaces === request.step) p.confirmed = true;
              // The step was done by hand: what was recorded takes its place, and an element used alone is what its words mean on that screen.
              const used = done.length === 1 ? done[0]?.element : undefined;
              if (used?.name && labelKey(used.name) !== labelKey(request.name))
                await new LearningService(store, { exploreDir })
                  .saveLabel(project.id, { label: request.name, means: used.name, screen: used.screen, element: used.ref }, `walkthrough ${job.id}`, who, {
                    seenOnScreen: true,
                  })
                  .then(() => this.log(job.id, `Remembered: on ${used.screen} "${request.name}" is "${used.name}"`))
                  .catch((e) => this.log(job.id, `Not remembered: ${(e as Error).message}`));
              await this.log(
                job.id,
                done.length ? `${request.step} was done by hand` : `${request.step} was done by hand, and nothing was recorded for it: it keeps its words`,
              );
              return { manual: true };
            }
            // Not done by hand: what was done in the browser meanwhile does not take the step's place.
            if (done.length) {
              for (let i = pending.length - 1; i >= 0; i--) {
                const p = pending[i];
                if (p?.kind === 'recorded' && p.replaces === request.step) pending.splice(i, 1);
              }
              await this.log(job.id, `What was done in the browser at ${request.step} is not kept: the step was not done by hand`);
            }
            if (!a || typeof a !== 'object' || !('ref' in a)) return undefined;
            const { ref, remember } = a as { ref: string; remember?: boolean };
            const element = request.view.elements.find((e) => e.ref === ref);
            if (!element) return undefined;
            if (remember && element.name)
              await new LearningService(store, { exploreDir })
                .saveLabel(project.id, { label: request.name, means: element.name, screen: request.screen, element: ref }, `walkthrough ${job.id}`, who, {
                  seenOnScreen: true,
                })
                .then(() => this.log(job.id, `Remembered: on this screen "${request.name}" is "${element.name}"`))
                .catch((e) => this.log(job.id, `Not remembered: ${(e as Error).message}`));
            return { ref };
          },
        };
        trace = await executePlan(
          { plan, values: compiled.values, pages },
          {
            mcp: session.port,
            page: session.page,
            baseUrl: project.baseUrl,
            testIdAttribute: project.testIdAttribute,
            screenshotDir: shots,
            ...(knowledge ? { knowledge } : {}),
            hook,
          },
        );
        if (browserGone) ended = 'closed';
        else if (finishing || trace.stoppedAt?.code === 'STOPPED') ended = 'stopped';
        for (const [i, s] of trace.steps.entries()) steps[i] = { ...(steps[i] as (typeof steps)[number]), status: s.status };
      } catch (e) {
        if (e instanceof Idle) {
          ended = 'idle';
          await this.log(job.id, `The walkthrough was closed after ${Math.round(idleMs / 60000)} minutes without an answer.`);
        } else if (browserGone) {
          // The engine was working in the window when it was closed: what was recorded before is still offered to save.
          ended = 'closed';
        } else throw e;
      }
      if (trace) {
        // The screens reached are kept as the person's (E0.14a, b): they go into the next compile's knowledge.
        const kept = await keepScreens(path.join(exploreDir, caseId), trace, { source: 'walkthrough' }).catch(() => undefined);
        for (const c of kept?.changes ?? []) await this.log(job.id, `~ on ${c.screen}, ${c.change}: ${c.what}`);
      }

      if (pending.length && ended !== 'idle') {
        // Steps never run can be replaced by what the person recorded, so a flow done by hand is not followed by the old steps again.
        const notRun = steps.flatMap((s) => (s.status === 'to do' || s.status === 'skipped' ? [s.step] : []));
        const recorded = pending.filter((p) => p.kind === 'recorded').length;
        await this.update(job.id, { output: { walk: walk() } });
        await this.log(job.id, 'Waiting to save: recorded steps can still be added or removed.');
        const save = await ask(
          'confirm',
          {
            walkthrough: true,
            item: caseId,
            code: 'SAVE_WALKTHROUGH',
            text: `${browserGone ? 'The browser window was closed. ' : ''}Save what you added as a new version of ${caseId}? Recorded steps you did not add are left out. The workbook itself is not changed.`,
            pending: pending.map(pendingView),
            ...(notRun.length && recorded ? { notRun, recorded } : {}),
          },
          { window: false },
        ).catch((e) => {
          if (e instanceof Idle) return false;
          throw e;
        });
        // Only what the person added is saved; recorded steps still waiting for an OK are left out.
        const kept = pending.filter((p) => p.kind !== 'recorded' || p.confirmed);
        const left = pending.length - kept.length;
        if (left) await this.log(job.id, `${left} recorded step(s) you did not add are left out.`);
        const addedRecorded = kept.some((p) => p.kind === 'recorded');
        if ((save === true || save === 'replace') && !kept.length) {
          await this.log(job.id, 'Nothing was added, so nothing was saved.');
          endWord = { ok: false, message: 'Nothing was added, so nothing was saved.' };
        } else if (save === true || save === 'replace') {
          // Steps not run are replaced only by recorded steps that were added.
          const drop = save === 'replace' && addedRecorded ? notRun : [];
          const final = await finalCase(record.raw, kept, compileOptions, drop);
          if (!final.ok) {
            await this.log(job.id, `Not saved: ${final.why}`);
            endWord = { ok: false, message: `Not saved: ${final.why}` };
          } else {
            // The reason starts with "edited", so this version wins when the workbook is run again (D23).
            const next = await store.upsertTestCase(
              project.id,
              { ...final.raw, id: caseId },
              { kind: record.sourceKind, ref: record.sourceRef, row: record.sourceRow },
              `edited in a walkthrough by ${who}: ${[...kept.map(pendingNote), ...drop.map((d) => `${d} replaced by the recorded steps`)].join('; ')}`,
            );
            saved = next.version;
            await this.log(
              job.id,
              `Saved as version ${next.version} of ${caseId}${drop.length ? ` (${drop.join(', ')} replaced by the recorded steps)` : ''}. Run it again to see the result.`,
            );
            endWord = { ok: true, message: `Saved as version ${next.version} of ${caseId}. Run it again from Auto QA to see the result.` };
          }
        } else {
          await this.log(job.id, 'The changes were not saved.');
          endWord = { ok: false, message: 'The changes were not saved.' };
        }
      } else if (ended !== 'idle') endWord = { ok: false, message: 'Nothing was recorded or changed, so nothing was saved.' };

      // The last word is shown in the window for a moment, unless the person closes it first.
      if (endWord && panel && !browserGone) {
        endWord = { ...endWord, message: `${endWord.message} This window closes in a few seconds.` };
        await showPanel();
        await Promise.race([closed, new Promise((r) => setTimeout(r, 6000))]);
      }
    } finally {
      closing = true;
      this.walkBrowsers.delete(job.id);
      this.walkEdits.delete(job.id);
      await session.close();
    }
    await this.update(job.id, {
      status: ended === 'idle' ? 'cancelled' : 'done',
      output: { walk: { ...walk(), ended, ...(saved ? { savedVersion: saved } : {}), durationMs: Date.now() - started } },
      finishedAt: new Date().toISOString(),
    });
  }

  /** Logs in with the login case of the workbook the walkthrough came from, before its first step, without asking anything. */
  private async loginFirst(
    job: Job,
    project: Project,
    compileOptions: Parameters<typeof compileCase>[1],
    session: Awaited<ReturnType<typeof openExecutionSession>>,
    pages: Record<string, string | null>,
  ): Promise<void> {
    const from = typeof job.input.fromJob === 'string' ? await this.options.store.job(job.input.fromJob) : undefined;
    const loginId =
      typeof job.input.loginCase === 'string' ? job.input.loginCase : typeof from?.output.loginCase === 'string' ? from.output.loginCase : undefined;
    const login = loginId ? await this.options.store.testCase(project.id, loginId) : undefined;
    if (!login) {
      await this.log(job.id, 'This test case starts logged in, and no login case is known for it: its own steps are run as they are.');
      return;
    }
    const c = await compileCase(login.raw, compileOptions);
    if (!c.ir || !c.plan) {
      await this.log(job.id, `The login case ${login.extId} could not be read; the steps are run without it.`);
      return;
    }
    const t = await executePlan(
      { plan: planActions(c.ir, c.plan), values: c.values, pages: { ...pages, ...c.pages } },
      { mcp: session.port, page: session.page, baseUrl: project.baseUrl },
    );
    await this.log(
      job.id,
      t.status === 'completed'
        ? `Logged in first with ${login.extId}`
        : `The login case ${login.extId} stopped at ${t.stoppedAt?.step}: ${t.stoppedAt?.reason}`,
    );
  }

  /** One test case from the form: explore and generate, wait in review, then run (FR-RV-01, FR-RV-03). */
  private async runSingle(job: Job): Promise<void> {
    const project = (await this.options.store.project(job.projectId))!;
    const config = await this.configFor(project);
    let raw = job.input.case as RawTestCase;
    let reexplore = false;
    for (;;) {
      const model = parseTestCase(raw, config);
      // A single test gets its own project, so it cannot disturb the workbook's suite (merging it in is V2, FR-GE-07).
      const workspace = this.projectDir(project, 'single', model.id, 'workspace');
      const options = {
        ...(await this.common(project, job, await this.options.store.projectPolicy(project.id), config)),
        resolver: this.resolver(job, true, []),
        workspace,
        reexplore,
        onProgress: (m: string) => void this.log(job.id, m),
      };
      const prepared = await prepareCases([model], options);
      // A cancel while exploring ends the exploration early; it must not then wait in review.
      if (this.cancelled.has(job.id)) throw new Cancelled();
      // A saved test that is run again was approved before: when it can be generated as it is, it runs straight away.
      const again = job.input.rerun === true && prepared.explored.length > 0 && prepared.early.size === 0;
      const early = prepared.early.get(model.id);
      if (early) await this.options.store.recordResult(project.id, model.id, { jobId: job.id, status: early.status, at: new Date().toISOString() });
      // Web Automation "Record": explore and generate the script, keep it, and stop. Nothing runs, so there is nothing to approve here.
      if (job.input.record === true && prepared.explored.length && !prepared.early.size) {
        const saved = await this.options.store.testCase(project.id, model.id);
        if (saved) await this.options.store.markRecorded(project.id, model.id, saved.version, job.id);
        await this.log(job.id, 'Script recorded');
        await this.update(job.id, {
          status: 'done',
          output: { review: reviewOf(model, prepared), workspace, recorded: true },
          finishedAt: new Date().toISOString(),
        });
        return;
      }
      await this.update(job.id, { status: again ? 'running' : 'review', output: { review: reviewOf(model, prepared), workspace } });
      let decision: Decision = again ? { action: 'approve' } : await this.decision(job.id);
      if (again) await this.log(job.id, 'Running the saved test again');
      // Approving a test that could not be generated changes nothing: it stays in review, with the reason.
      while (decision.action === 'approve' && !prepared.explored.length) {
        await this.log(job.id, 'Nothing to run yet: the test case could not be generated. Edit it or regenerate.');
        decision = await this.decision(job.id);
      }
      if (decision.action === 'cancel' || this.cancelled.has(job.id)) throw new Cancelled();
      if (decision.action === 'regenerate') {
        reexplore = true;
        await this.log(job.id, 'Regenerating: exploring again');
        continue;
      }
      if (decision.action === 'edit') {
        // FR-RV-05: the edit goes into the test case, which is parsed and explored again.
        raw = { ...decision.case, id: model.id };
        await this.options.store.upsertTestCase(project.id, { ...raw, id: model.id }, { kind: 'form' }, 'edited during review');
        reexplore = false;
        await this.update(job.id, { status: 'running', input: { ...job.input, case: raw } });
        await this.log(job.id, 'Edited: exploring the changed test case');
        continue;
      }
      await this.update(job.id, { status: 'running' });
      await this.log(job.id, 'Approved: running');
      const result = await executeCases([model], prepared, {
        ...options,
        onRunEvent: (e) => e.event === 'step-end' && void this.log(job.id, `${e.status === 'passed' ? '✔' : '✖'} ${e.step}`),
      });
      const recordedAt = new Date().toISOString();
      if (prepared.explored.length) {
        const saved = await this.options.store.testCase(project.id, model.id);
        if (saved) await this.options.store.markRecorded(project.id, model.id, saved.version, job.id);
      }
      await this.options.store.saveRun(
        { id: job.id, projectId: project.id },
        {
          execution: result.executionId
            ? { execId: result.executionId, startedAt: job.startedAt, finishedAt: recordedAt, durationMs: Date.now() - Date.parse(job.startedAt ?? recordedAt) }
            : undefined,
          rows: result.verdicts.map((v) => ({ testId: v.testId, status: v.status, verdict: v })),
          evidence: await this.evidenceFor(result.verdicts, result.executionId),
          snapshot: result.workspace ? await manifestOf(result.workspace) : undefined,
          recordedAt,
        },
      );
      await this.update(job.id, {
        status: 'done',
        executionId: result.executionId,
        output: { ...(await this.options.store.job(job.id))?.output, verdicts: result.verdicts },
        finishedAt: new Date().toISOString(),
      });
      return;
    }
  }
}

/** The generated project's files by hash: the code a run used, without keeping a copy of it (DATABASE.md §5.5). */
async function manifestOf(workspace: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(path.join(workspace, dir), { withFileTypes: true }).catch(() => [])) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else
        out[rel] = createHash('sha256')
          .update(await readFile(path.join(workspace, rel)))
          .digest('hex');
    }
  };
  for (const dir of ['tests', 'pages', 'locators', 'data']) await walk(dir);
  for (const file of ['auto-qa.json', 'playwright.config.ts']) {
    const content = await readFile(path.join(workspace, file)).catch(() => undefined);
    if (content) out[file] = createHash('sha256').update(content).digest('hex');
  }
  return out;
}

/** The kinds of file a run leaves, with a reference, size and hash for each (FR-DB-14). Only this run's own files: cached results keep theirs. */
type Evidence = Record<string, Array<FileFacts & { kind: string; stepId?: string }>>;

/** The plan the tester reviews: each step with its locator, score and screenshot, and the code diff (FR-RV-01, FR-RV-04). */
function reviewOf(model: TestModel, prepared: Prepared) {
  const exploration: ExplorationResult | undefined = prepared.explored[0]?.exploration;
  const early: TestVerdict | undefined = prepared.early.get(model.id);
  const reasonOf = (id: string) => early?.review?.find((r) => r.id === id);
  const explored = (exploration?.items ?? []).map((i) => {
    const r = reasonOf(i.id);
    return {
      id: i.id,
      phase: i.phase,
      kind: i.kind,
      raw: i.raw,
      action: i.action,
      type: i.type,
      status: i.status as 'done' | 'skipped' | 'failed' | 'not-run',
      locator: i.locator,
      score: i.score,
      resolvedBy: i.resolvedBy,
      page: i.page?.name,
      effect: i.effect,
      screenshot: i.screenshot,
      warnings: i.warnings,
      candidates: i.candidates,
      error: i.error,
      review: i.review ?? (r && { headline: r.headline, why: r.why, todo: r.todo }),
      noScreenshot: i.screenshot ? undefined : 'No picture was taken for this step.',
    };
  });
  // Steps and checks exploration never got to (it stopped earlier, or nothing was opened because the case must be rewritten first).
  const seen = new Set(explored.filter((i) => i.phase === 'test').map((i) => i.id));
  const never = [...model.steps, ...model.assertions]
    .filter((x) => !seen.has(x.id))
    .map((x) => {
      const r = reasonOf(x.id);
      return {
        id: x.id,
        phase: 'test' as const,
        kind: ('source' in x ? 'check' : 'step') as 'step' | 'check',
        raw: x.raw,
        status: (x.status === 'unparsed' ? 'skipped' : 'not-run') as 'skipped' | 'not-run',
        warnings: [] as string[],
        review: r && { headline: r.headline, why: r.why, todo: r.todo },
        noScreenshot:
          x.status === 'unparsed'
            ? 'No picture: nothing was opened, because this has to be rewritten first.'
            : 'No picture: exploration stopped before it got here.',
      };
    });
  return {
    testId: model.id,
    title: model.title,
    warnings: model.warnings,
    blocked: early && { status: early.status, reason: early.reason, category: early.category, review: early.review },
    items: [...explored, ...never],
    changes: prepared.changes
      .filter((c) => /^(tests|pages|locators|data)\//.test(c.path))
      .map((c) => ({
        path: c.path,
        added: c.before === undefined,
        patch: createTwoFilesPatch(c.path, c.path, c.before ?? '', c.after, 'before', 'now', { context: 3 }),
      })),
  };
}
