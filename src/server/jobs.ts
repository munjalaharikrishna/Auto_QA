import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { ExplorationResult, Resolver } from '../explorer/controller.js';
import type { Field } from '../importer/columns.js';
import { defaultResultsFile } from '../importer/results.js';
import type { RawTestCase, TestModel } from '../model/test-model.js';
import type { ParserConfig } from '../parser/config.js';
import { parseTestCase } from '../parser/index.js';
import { runBatch } from '../pipeline/batch.js';
import { executeCases, type Prepared, prepareCases } from '../pipeline/run-cases.js';
import type { TestVerdict } from '../results/verdict.js';
import { readEnvFile } from './credentials.js';
import type { Job, Project, Question, Store } from './store.js';

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
}

class Cancelled extends Error {}

export class JobRunner extends EventEmitter {
  private readonly queue: string[] = [];
  private busy = false;
  private readonly answers = new Map<number, (answer: unknown) => void>();
  private readonly decisions = new Map<string, (d: Decision) => void>();
  private readonly cancelled = new Set<string>();
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

  async cancel(jobId: string): Promise<void> {
    const job = await this.options.store.job(jobId);
    if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) return;
    this.cancelled.add(jobId);
    const queued = this.queue.indexOf(jobId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      await this.update(jobId, { status: 'cancelled', finishedAt: new Date().toISOString() });
      return;
    }
    this.decide(jobId, { action: 'cancel' });
    for (const q of await this.options.store.openQuestions(jobId)) await this.answer(q.id, q.kind === 'confirm' ? false : 'abort');
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
      else await this.runSingle(job);
    } catch (e) {
      if (e instanceof Cancelled || this.cancelled.has(id)) await this.update(id, { status: 'cancelled', finishedAt: new Date().toISOString() });
      else await this.update(id, { status: 'failed', error: (e as Error).message, finishedAt: new Date().toISOString() });
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
        asked.push(`${r.item} "${r.raw}": ${r.code}: ${r.text}`);
        if (!interactive) return 'skip';
        const candidates = r.candidates
          .slice(0, 9)
          .map((c) => ({ ref: c.node.ref, role: c.node.role, name: c.matchedName || c.node.name, score: c.score, how: c.how, notes: c.notes }));
        const a = await ask('choose', { item: r.item, raw: r.raw, code: r.code, text: r.text, candidates, view: r.view });
        return a === 'skip' || a === 'abort' || typeof a === 'number' || (typeof a === 'object' && a && 'ref' in a) ? (a as never) : 'skip';
      },
      async pageUrl(r) {
        asked.push(`${r.item}: the URL of the "${r.page}" page is not known.`);
        if (!interactive) return 'abort';
        const a = await ask('pageUrl', { item: r.item, page: r.page });
        return typeof a === 'string' && a.trim() ? a.trim() : 'abort';
      },
      async confirm(r) {
        asked.push(`${r.item} ${r.code}: ${r.text}`);
        if (!interactive) return false;
        return (await ask('confirm', { item: r.item, code: r.code, text: r.text })) === true;
      },
    };
  }

  private common(project: Project) {
    return {
      config: this.options.config,
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
    const upload = await this.options.store.upload(String(job.input.uploadId));
    if (!upload) throw new Error('The uploaded workbook is gone. Upload it again.');
    const onlyReview = job.input.onlyReview === true;
    const asked: string[] = [];
    const batch = await runBatch(upload.file, {
      ...this.common(project),
      resolver: this.resolver(job, onlyReview, asked),
      questions: () => asked,
      workspace: project.workspace,
      batchesDir: this.projectDir(project, 'batches'),
      mapping: (job.input.mapping ?? {}) as Partial<Record<Field, string>>,
      onlyReview,
      out: defaultResultsFile(upload.file),
      onProgress: (m) => void this.log(job.id, m),
    });
    await this.options.store.saveVerdicts(
      job.id,
      batch.results.map((r) => ({
        testId: r.verdict?.testId ?? r.id ?? `row ${r.row}`,
        row: r.row,
        status: r.verdict?.status ?? 'NEEDS REVIEW',
        verdict: r.verdict ?? { problem: r.problem, title: r.title },
      })),
    );
    await this.update(job.id, {
      status: 'done',
      executionId: batch.summary.executionId,
      output: { summary: batch.summary, resultsFile: batch.out, originalName: upload.originalName, loginCase: batch.loginCase, workspace: batch.workspace },
      finishedAt: new Date().toISOString(),
    });
  }

  /** One test case from the form: explore and generate, wait in review, then run (FR-RV-01, FR-RV-03). */
  private async runSingle(job: Job): Promise<void> {
    const project = (await this.options.store.project(job.projectId))!;
    let raw = job.input.case as RawTestCase;
    let reexplore = false;
    for (;;) {
      const model = parseTestCase(raw, this.options.config);
      // A single test gets its own project, so it cannot disturb the workbook's suite (merging it in is V2, FR-GE-07).
      const workspace = this.projectDir(project, 'single', model.id, 'workspace');
      const options = {
        ...this.common(project),
        resolver: this.resolver(job, true, []),
        workspace,
        reexplore,
        onProgress: (m: string) => void this.log(job.id, m),
      };
      const prepared = await prepareCases([model], options);
      // A cancel while exploring ends the exploration early; it must not then wait in review.
      if (this.cancelled.has(job.id)) throw new Cancelled();
      await this.update(job.id, { status: 'review', output: { review: reviewOf(model, prepared), workspace } });
      let decision = await this.decision(job.id);
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
      await this.options.store.saveVerdicts(
        job.id,
        result.verdicts.map((v) => ({ testId: v.testId, status: v.status, verdict: v })),
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

/** The plan the tester reviews: each step with its locator, score and screenshot, and the code diff (FR-RV-01, FR-RV-04). */
function reviewOf(model: TestModel, prepared: Prepared) {
  const exploration: ExplorationResult | undefined = prepared.explored[0]?.exploration;
  const early: TestVerdict | undefined = prepared.early.get(model.id);
  return {
    testId: model.id,
    title: model.title,
    warnings: model.warnings,
    blocked: early && { status: early.status, reason: early.reason, category: early.category },
    items: (exploration?.items ?? []).map((i) => ({
      id: i.id,
      phase: i.phase,
      kind: i.kind,
      raw: i.raw,
      action: i.action,
      type: i.type,
      status: i.status,
      locator: i.locator,
      score: i.score,
      resolvedBy: i.resolvedBy,
      page: i.page?.name,
      effect: i.effect,
      screenshot: i.screenshot,
      warnings: i.warnings,
      candidates: i.candidates,
    })),
    changes: prepared.changes
      .filter((c) => /^(tests|pages|locators|data)\//.test(c.path))
      .map((c) => ({
        path: c.path,
        added: c.before === undefined,
        patch: createTwoFilesPatch(c.path, c.path, c.before ?? '', c.after, 'before', 'now', { context: 3 }),
      })),
  };
}
