import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_POLICY, isPolicy, type Policy } from '../model/policy.js';
import type { RawTestCase } from '../model/test-model.js';
import { type ProjectRule, type RuleKind, ruleKey } from '../parser/rules.js';
import { type ArtifactStore, type FileFacts, isRef } from './artifacts.js';
import type { Driver, Queryable } from './driver.js';
import { migrate } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';
import { EXEC_ID, execIdOf, resultColumns, runId } from './results.js';
import { SqliteDriver } from './sqlite-driver.js';
import { problems } from './verify.js';

/**
 * Platform storage (SPEC §3, D20, D24–D28): the one place SQL is written. SQLite on the owner's laptop;
 * PostgreSQL arrives with team mode (V3) behind the same driver interface. Passwords are never stored here:
 * they live only in the project workspace's git-ignored .env (FR-ENV-05).
 */

export interface Project {
  id: string;
  name: string;
  baseUrl: string;
  testIdAttribute: string;
  browser: 'chromium';
  workspace: string;
  createdAt: string;
}

export type JobKind = 'workbook' | 'single';
export type JobStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  /** Workbook: `{ uploadId, mapping, onlyReview }`. Single: `{ case }`. */
  input: Record<string, unknown>;
  /** What the job produced so far: review plan, summary, results file. */
  output: Record<string, unknown>;
  executionId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Question {
  id: number;
  jobId: string;
  kind: 'choose' | 'pageUrl' | 'confirm';
  payload: Record<string, unknown>;
  answer?: unknown;
  createdAt: string;
  answeredAt?: string;
}

export interface Upload {
  id: string;
  projectId: string;
  file: string;
  originalName: string;
  createdAt: string;
}

export interface TestCaseRecord {
  id: string;
  projectId: string;
  /** The id the tester gave it (or we did), e.g. TC-LOGIN-001; unique within the project. */
  extId: string;
  title: string;
  raw: RawTestCase;
  sourceKind: 'form' | 'workbook';
  sourceRef?: string;
  sourceRow?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastStatus?: string;
  lastJobId?: string;
  lastExecutionId?: string;
  lastRunAt?: string;
  runCount: number;
}

export interface TestCaseRun {
  jobId: string;
  executionId?: string;
  kind: JobKind;
  jobStatus: JobStatus;
  /** PASS / FAIL / BLOCKED / NEEDS REVIEW, or the job's status when it never produced a result. */
  status: string;
  at: string;
  finishedAt?: string;
  summary?: string;
  durationMs?: number;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  isProduction: boolean;
  isDefault: boolean;
}

export interface ExecutionRecord {
  /** `EXEC-YYYY-NNNNN`, as shown to testers. */
  execId: string;
  projectId: string;
  jobId?: string;
  status: string;
  /** Tests by result, e.g. `{ PASS: 3, FAIL: 1 }`. */
  totals: Record<string, number>;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface ResultRecord {
  testId: string;
  status: string;
  modelVersion?: number;
  category?: string;
  failedStep?: string;
  reason?: string;
  expected?: string;
  actual?: string;
  durationMs?: number;
  steps: Array<{ id: string; raw: string; result: string; error?: string; screenshotRef?: string }>;
  checks: Array<{ id: string; raw: string; expected?: string; actual?: string; result: string }>;
  evidence: Array<{ kind: string; ref: string; mime: string; sizeBytes: number; sha256: string; stepId?: string; masked: boolean }>;
}

type Row = Record<string, string | number | null>;

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;
/** The default environment of a project has a predictable id (migration 0002 uses the same rule). */
const defaultEnvId = (projectId: string) => `ENV-${projectId}`;

const PROJECT_SELECT = `SELECT p.id, p.name, p.test_id_attribute, p.browser, p.workspace, p.created_at,
  COALESCE(e.base_url, p.base_url) AS base_url
  FROM projects p LEFT JOIN environments e ON e.project_id = p.id AND e.is_default = 1`;

export class Store {
  /** Use `Store.open`. A store made from a transaction (see `transaction`) has no driver of its own. */
  constructor(
    private readonly db: Queryable,
    private readonly driver?: Driver,
    /** Turns files into storage references and back (D27). Without it, paths are stored as given. */
    readonly artifacts?: ArtifactStore,
  ) {}

  /** `file` is the database path, or `:memory:` for tests. Pending migrations are applied first (D26). */
  static async open(file: string, options: { backupDir?: string; appVersion?: string; artifacts?: ArtifactStore } = {}): Promise<Store> {
    const driver = await SqliteDriver.open(file);
    try {
      await migrate(driver, MIGRATIONS, options);
      const store = new Store(driver, driver, options.artifacts);
      await store.adoptPaths();
      return store;
    } catch (e) {
      await driver.close();
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.driver?.close();
  }

  /** The database file, if it has one. */
  get file(): string | undefined {
    return this.driver?.file;
  }

  /** Everything the function writes through the store it is given is committed together, or not at all (FR-DB-07). */
  transaction<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    if (!this.driver) return fn(this);
    return this.driver.transaction((tx) => fn(new Store(tx, undefined, this.artifacts)));
  }

  /** A path as it is kept in a row: a storage reference when the file is inside a root (D27, FR-DB-13). */
  private keep(file: string): string {
    return this.artifacts?.toRef(file) ?? file;
  }

  /** A stored value as a path on this machine. Values that are not references (older rows, files outside every root) are paths already. */
  private open(stored: string): string {
    return isRef(stored) && this.artifacts ? this.artifacts.resolve(stored) : stored;
  }

  /** Rows written before references existed hold absolute paths: convert those inside a root, once and safely to repeat. */
  async adoptPaths(): Promise<number> {
    if (!this.artifacts) return 0;
    let changed = 0;
    for (const [table, column] of [
      ['projects', 'workspace'],
      ['uploads', 'file'],
    ] as const) {
      const rows = await this.db.all<{ id: string; v: string }>(`SELECT id, ${column} AS v FROM ${table}`);
      for (const r of rows) {
        if (isRef(r.v)) continue;
        const ref = this.artifacts.toRef(r.v);
        if (!ref) continue;
        await this.db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [ref, r.id]);
        changed++;
      }
    }
    return changed;
  }

  // Projects

  async createProject(p: Omit<Project, 'createdAt'>): Promise<Project> {
    const project = { ...p, createdAt: now() };
    await this.transaction(async (s) => {
      await s.db.run(
        'INSERT INTO projects (id, name, base_url, test_id_attribute, browser, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          project.id,
          project.name,
          project.baseUrl,
          project.testIdAttribute,
          project.browser,
          this.keep(project.workspace),
          project.createdAt,
          project.createdAt,
        ],
      );
      await s.db.run(
        `INSERT INTO environments (id, project_id, name, base_url, is_production, is_default, created_at, updated_at) VALUES (?, ?, 'Default', ?, 0, 1, ?, ?)`,
        [defaultEnvId(project.id), project.id, project.baseUrl, project.createdAt, project.createdAt],
      );
      await s.audit('project.create', 'project', project.id, project.id, { name: project.name });
    });
    return project;
  }

  async updateProject(id: string, changes: Partial<Pick<Project, 'name' | 'baseUrl' | 'testIdAttribute'>>): Promise<Project | undefined> {
    const current = await this.project(id);
    if (!current) return undefined;
    // A field left out of the update keeps its value.
    const given = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    const next = { ...current, ...given };
    const at = now();
    await this.transaction(async (s) => {
      await s.db.run('UPDATE projects SET name = ?, base_url = ?, test_id_attribute = ?, updated_at = ? WHERE id = ?', [
        next.name,
        next.baseUrl,
        next.testIdAttribute,
        at,
        id,
      ]);
      await s.db.run('UPDATE environments SET base_url = ?, updated_at = ? WHERE project_id = ? AND is_default = 1', [next.baseUrl, at, id]);
      await s.audit('project.update', 'project', id, id, { fields: Object.keys(given) });
    });
    return next;
  }

  async project(id: string): Promise<Project | undefined> {
    const r = await this.db.get<Row>(`${PROJECT_SELECT} WHERE p.id = ?`, [id]);
    return r && this.toProject(r);
  }

  async projects(): Promise<Project[]> {
    return (await this.db.all<Row>(`${PROJECT_SELECT} WHERE p.archived_at IS NULL ORDER BY p.created_at`)).map((r) => this.toProject(r));
  }

  // Environments (V1 has one per project; V2 adds more rows, FR-ENV-02)

  async environments(projectId: string): Promise<Environment[]> {
    const rows = await this.db.all<Row>('SELECT * FROM environments WHERE project_id = ? ORDER BY is_default DESC, name', [projectId]);
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      name: String(r.name),
      baseUrl: String(r.base_url),
      isProduction: Boolean(r.is_production),
      isDefault: Boolean(r.is_default),
    }));
  }

  /** Page name → path for an environment (FR-ENV-03, D19). */
  async pageRoutes(environmentId: string): Promise<Record<string, string>> {
    const rows = await this.db.all<{ page_name: string; path: string }>('SELECT page_name, path FROM page_routes WHERE environment_id = ?', [environmentId]);
    return Object.fromEntries(rows.map((r) => [r.page_name, r.path]));
  }

  async savePageRoute(environmentId: string, pageName: string, path: string, source: 'learned' | 'tester' | 'check'): Promise<void> {
    const at = now();
    await this.db.run(
      `INSERT INTO page_routes (environment_id, page_name, path, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (environment_id, page_name) DO UPDATE SET path = excluded.path, source = excluded.source, updated_at = excluded.updated_at`,
      [environmentId, pageName, path, source, at, at],
    );
  }

  /** The environment a project's runs use until V2 lets the tester pick one (FR-ENV-01). */
  async defaultEnvironmentId(projectId: string): Promise<string | undefined> {
    return (await this.db.get<{ id: string }>('SELECT id FROM environments WHERE project_id = ? AND is_default = 1', [projectId]))?.id;
  }

  /**
   * Moves the page URLs older versions kept in `.auto-qa/pages.json` (by origin) into the page routes of every project whose
   * environment is on that origin. Routes already there win. Returns how many were added; safe to repeat.
   */
  async importPageUrls(all: Record<string, Record<string, string>>): Promise<number> {
    let added = 0;
    for (const env of await this.db.all<{ id: string; base_url: string }>('SELECT id, base_url FROM environments')) {
      let origin: string;
      try {
        origin = new URL(env.base_url).origin;
      } catch {
        continue;
      }
      const have = await this.pageRoutes(env.id);
      for (const [name, route] of Object.entries(all[origin] ?? {})) {
        if (name in have) continue;
        await this.savePageRoute(env.id, name, route, 'learned');
        added++;
      }
    }
    return added;
  }

  // Uploads

  async createUpload(u: Omit<Upload, 'id' | 'createdAt'>): Promise<Upload> {
    const upload = { ...u, id: newId('UP'), createdAt: now() };
    await this.db.run('INSERT INTO uploads (id, project_id, file, original_name, created_at) VALUES (?, ?, ?, ?, ?)', [
      upload.id,
      upload.projectId,
      this.keep(upload.file),
      upload.originalName,
      upload.createdAt,
    ]);
    return upload;
  }

  async upload(id: string): Promise<Upload | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM uploads WHERE id = ?', [id]);
    return (
      r && {
        id: String(r.id),
        projectId: String(r.project_id),
        file: this.open(String(r.file)),
        originalName: String(r.original_name),
        createdAt: String(r.created_at),
      }
    );
  }

  // Jobs

  async createJob(j: Pick<Job, 'projectId' | 'kind' | 'input'>): Promise<Job> {
    const job: Job = { ...j, id: newId('JOB'), status: 'queued', output: {}, createdAt: now() };
    await this.transaction(async (s) => {
      await s.db.run('INSERT INTO jobs (id, project_id, kind, status, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        job.id,
        job.projectId,
        job.kind,
        job.status,
        JSON.stringify(job.input),
        '{}',
        job.createdAt,
      ]);
      await s.audit('job.create', 'job', job.id, job.projectId, { kind: job.kind });
    });
    return job;
  }

  async updateJob(id: string, changes: Partial<Pick<Job, 'status' | 'output' | 'executionId' | 'error' | 'startedAt' | 'finishedAt' | 'input'>>): Promise<Job> {
    const job = await this.job(id);
    if (!job) throw new Error(`No job ${id}`);
    const next = { ...job, ...changes };
    await this.db.run('UPDATE jobs SET status = ?, input = ?, output = ?, execution_id = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?', [
      next.status,
      JSON.stringify(next.input),
      JSON.stringify(next.output),
      next.executionId ?? null,
      next.error ?? null,
      next.startedAt ?? null,
      next.finishedAt ?? null,
      id,
    ]);
    return next;
  }

  async job(id: string): Promise<Job | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM jobs WHERE id = ?', [id]);
    return r && toJob(r);
  }

  async jobs(projectId: string, limit = 50): Promise<Job[]> {
    return (await this.db.all<Row>('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, limit])).map(toJob);
  }

  /** Jobs a restart interrupted: they are marked failed, never silently resumed. */
  async interruptedJobs(): Promise<Job[]> {
    return (await this.db.all<Row>("SELECT * FROM jobs WHERE status IN ('running', 'waiting', 'review', 'queued')")).map(toJob);
  }

  async log(jobId: string, message: string): Promise<void> {
    await this.db.run('INSERT INTO job_logs (job_id, at, message) VALUES (?, ?, ?)', [jobId, now(), message]);
  }

  async logs(jobId: string): Promise<Array<{ at: string; message: string }>> {
    return this.db.all<{ at: string; message: string }>('SELECT at, message FROM job_logs WHERE job_id = ? ORDER BY id', [jobId]);
  }

  // Questions

  async ask(jobId: string, kind: Question['kind'], payload: Record<string, unknown>): Promise<Question> {
    const createdAt = now();
    const r = await this.db.run('INSERT INTO questions (job_id, kind, payload, created_at) VALUES (?, ?, ?, ?)', [
      jobId,
      kind,
      JSON.stringify(payload),
      createdAt,
    ]);
    return { id: r.lastInsertId, jobId, kind, payload, createdAt };
  }

  async answer(id: number, answer: unknown): Promise<Question | undefined> {
    await this.db.run('UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL', [JSON.stringify(answer), now(), id]);
    return this.question(id);
  }

  async question(id: number): Promise<Question | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM questions WHERE id = ?', [id]);
    return r && toQuestion(r);
  }

  async openQuestions(jobId: string): Promise<Question[]> {
    return (await this.db.all<Row>('SELECT * FROM questions WHERE job_id = ? AND answered_at IS NULL ORDER BY id', [jobId])).map(toQuestion);
  }

  // Results (DATABASE.md §5.7). `verdicts` is a read-only view of `test_results` for one release.

  /**
   * One row per test of a job, the whole verdict kept as JSON and its queryable parts as columns. Saving again replaces
   * the row (and what hangs off it). A run's executions, steps, checks and evidence are added by `saveRun`.
   */
  async saveVerdicts(jobId: string, rows: Array<{ testId: string; row?: number; status: string; verdict: unknown }>): Promise<void> {
    await this.transaction(async (s) => {
      const job = await s.db.get<{ project_id: string }>('SELECT project_id FROM jobs WHERE id = ?', [jobId]);
      if (!job) throw new Error(`No job ${jobId}`);
      for (const r of rows) {
        const c = resultColumns(r.verdict);
        const execution = c.executionId ? runId(job.project_id, c.executionId) : undefined;
        const linked = execution && (await s.db.get('SELECT 1 AS x FROM executions WHERE id = ?', [execution])) ? execution : null;
        const testCase = await s.db.get<{ id: string; current_version: number }>(
          'SELECT id, current_version FROM test_cases WHERE project_id = ? AND ext_id = ?',
          [job.project_id, r.testId],
        );
        const existing = await s.db.get<{ id: string }>('SELECT id FROM test_results WHERE job_id = ? AND ext_id = ?', [jobId, r.testId]);
        if (existing) await s.clearResult(existing.id);
        await s.db.run(
          `INSERT INTO test_results (id, job_id, project_id, execution_id, test_case_id, model_version, ext_id, row, automation_id, status, category,
             failed_step, reason, expected, actual, duration_ms, started_at, verdict)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (job_id, ext_id) DO UPDATE SET execution_id = excluded.execution_id, test_case_id = excluded.test_case_id,
             model_version = excluded.model_version, row = excluded.row, automation_id = excluded.automation_id, status = excluded.status,
             category = excluded.category, failed_step = excluded.failed_step, reason = excluded.reason, expected = excluded.expected,
             actual = excluded.actual, duration_ms = excluded.duration_ms, started_at = excluded.started_at, verdict = excluded.verdict`,
          [
            existing?.id ?? newId('TR'),
            jobId,
            job.project_id,
            linked,
            testCase?.id ?? null,
            testCase?.current_version ?? null,
            r.testId,
            r.row ?? null,
            c.automationId,
            r.status,
            c.category,
            c.failedStep,
            c.reason,
            c.expected,
            c.actual,
            c.durationMs,
            c.startedAt,
            JSON.stringify(r.verdict),
          ],
        );
      }
    });
  }

  private async clearResult(testResultId: string): Promise<void> {
    for (const table of ['step_results', 'check_results', 'evidence']) await this.db.run(`DELETE FROM ${table} WHERE test_result_id = ?`, [testResultId]);
  }

  async verdicts(jobId: string): Promise<Array<{ testId: string; row?: number; status: string; verdict: unknown }>> {
    const rows = await this.db.all<Row>('SELECT * FROM test_results WHERE job_id = ? ORDER BY row, ext_id', [jobId]);
    return rows.map((r) => ({
      testId: String(r.ext_id),
      row: r.row === null ? undefined : Number(r.row),
      status: String(r.status),
      verdict: JSON.parse(String(r.verdict)),
    }));
  }

  /**
   * A finished run, written together (FR-DB-07): the execution, every test's result with its steps, checks and evidence,
   * and the case's last result for the list. Either all of it is saved or none.
   */
  async saveRun(
    job: { id: string; projectId: string },
    run: {
      /** The run Playwright made, if one was made. Cases that stopped earlier have results but no execution. */
      execution?: { execId: string; startedAt?: string; finishedAt?: string; durationMs?: number; trigger?: string; browser?: string };
      rows: Array<{ testId: string; row?: number; status: string; verdict: unknown }>;
      /** Files each test left behind, already described (reference, type, size, hash). Keyed by test id. */
      evidence?: Record<string, Array<FileFacts & { kind: string; stepId?: string }>>;
      /** The generated project as it was when the run started: path → sha256 of each file (FR-HI-03, G6). */
      snapshot?: Record<string, string>;
      /** When the results were recorded; also the time of the last result shown on each test case. */
      recordedAt: string;
    },
  ): Promise<void> {
    await this.transaction(async (s) => {
      const env = await s.db.get<{ id: string }>('SELECT id FROM environments WHERE project_id = ? AND is_default = 1', [job.projectId]);
      if (run.execution) {
        const x = run.execution;
        const mine = run.rows.filter((r) => resultColumns(r.verdict).executionId === x.execId);
        const totals: Record<string, number> = {};
        for (const r of mine) totals[r.status] = (totals[r.status] ?? 0) + 1;
        const project = await s.project(job.projectId);
        await s.db.run(
          `INSERT INTO executions (id, exec_id, project_id, environment_id, job_id, trigger, browser, status, totals, started_at, finished_at, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status, totals = excluded.totals, finished_at = excluded.finished_at, duration_ms = excluded.duration_ms`,
          [
            runId(job.projectId, x.execId),
            x.execId,
            job.projectId,
            env?.id ?? null,
            job.id,
            x.trigger ?? 'job',
            x.browser ?? project?.browser ?? null,
            JSON.stringify(totals),
            x.startedAt ?? run.recordedAt,
            x.finishedAt ?? run.recordedAt,
            x.durationMs ?? null,
          ],
        );
      }
      await s.saveVerdicts(job.id, run.rows);
      for (const r of run.rows) {
        const v = (r.verdict ?? {}) as { executionId?: string; steps?: Array<Record<string, unknown>>; checks?: Array<Record<string, unknown>> };
        // Only what this run produced has steps and evidence of its own; a cached result from an earlier run keeps its own rows.
        if (!run.execution || v.executionId !== run.execution.execId) continue;
        const result = await s.db.get<{ id: string }>('SELECT id FROM test_results WHERE job_id = ? AND ext_id = ?', [job.id, r.testId]);
        if (!result) continue;
        const files = run.evidence?.[r.testId] ?? [];
        const screenshotOf = new Map(files.filter((f) => f.stepId).map((f) => [f.stepId as string, f.ref]));
        for (const [i, st] of (v.steps ?? []).entries()) {
          await s.db.run(
            'INSERT INTO step_results (test_result_id, step_id, seq, raw, result, duration_ms, error, screenshot_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              result.id,
              String(st.id),
              i,
              String(st.raw ?? ''),
              String(st.result ?? ''),
              typeof st.durationMs === 'number' ? Math.round(st.durationMs) : null,
              typeof st.error === 'string' ? st.error : null,
              screenshotOf.get(String(st.id)) ?? null,
            ],
          );
        }
        for (const [i, ck] of (v.checks ?? []).entries()) {
          await s.db.run('INSERT INTO check_results (test_result_id, check_id, seq, raw, expected, actual, result) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            result.id,
            String(ck.id),
            i,
            String(ck.raw ?? ''),
            typeof ck.expected === 'string' ? ck.expected : null,
            typeof ck.actual === 'string' ? ck.actual : null,
            String(ck.result ?? ''),
          ]);
        }
        for (const f of files) {
          // Verdicts are masked before they reach here (FR-EV-03), so what the files were made from is too.
          await s.db.run(
            `INSERT INTO evidence (id, test_result_id, step_id, kind, storage_ref, mime, size_bytes, sha256, masked, restricted, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
            [newId('EV'), result.id, f.stepId ?? null, f.kind, f.ref, f.mime, f.sizeBytes, f.sha256, run.recordedAt],
          );
        }
      }
      if (run.execution && run.snapshot && Object.keys(run.snapshot).length) {
        await s.db.run('INSERT INTO generation_snapshots (id, project_id, execution_id, manifest, created_at) VALUES (?, ?, ?, ?, ?)', [
          newId('GEN'),
          job.projectId,
          runId(job.projectId, run.execution.execId),
          JSON.stringify(run.snapshot),
          run.recordedAt,
        ]);
      }
      for (const r of run.rows) {
        await s.recordResult(job.projectId, r.testId, {
          jobId: job.id,
          executionId: resultColumns(r.verdict).executionId ?? run.execution?.execId,
          status: r.status,
          at: run.recordedAt,
        });
      }
    });
  }

  /** The generated code a run used, as file hashes: with the test case version, the run can be explained as it was (G6). */
  async generationSnapshot(projectId: string, execId: string): Promise<Record<string, string> | undefined> {
    const r = await this.db.get<{ manifest: string }>('SELECT manifest FROM generation_snapshots WHERE execution_id = ?', [runId(projectId, execId)]);
    return r && JSON.parse(String(r.manifest));
  }

  /** The newest result of every test in the project, whichever job produced it: what a batch resumes from. */
  async latestVerdicts(projectId: string): Promise<Record<string, { status: string; verdict: unknown }>> {
    const rows = await this.db.all<Row>(
      `SELECT t.ext_id, t.status, t.verdict FROM test_results t JOIN jobs j ON j.id = t.job_id
       WHERE t.project_id = ? AND j.created_at = (
         SELECT MAX(j2.created_at) FROM test_results t2 JOIN jobs j2 ON j2.id = t2.job_id WHERE t2.project_id = t.project_id AND t2.ext_id = t.ext_id)`,
      [projectId],
    );
    return Object.fromEntries(rows.map((r) => [String(r.ext_id), { status: String(r.status), verdict: JSON.parse(String(r.verdict)) }]));
  }

  /** A project's runs, newest first (FR-HI-02). */
  async executions(projectId: string, limit = 50): Promise<ExecutionRecord[]> {
    const rows = await this.db.all<Row>('SELECT * FROM executions WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT ?', [projectId, limit]);
    return rows.map(toExecution);
  }

  /** One run with each test's result, steps, checks and evidence: a past result exactly as it was (FR-DB-11). */
  async execution(projectId: string, execId: string): Promise<(ExecutionRecord & { results: ResultRecord[] }) | undefined> {
    const x = await this.db.get<Row>('SELECT * FROM executions WHERE project_id = ? AND exec_id = ?', [projectId, execId]);
    if (!x) return undefined;
    const results = await this.db.all<Row>('SELECT * FROM test_results WHERE execution_id = ? ORDER BY row, ext_id', [String(x.id)]);
    const out: ResultRecord[] = [];
    for (const r of results) {
      const id = String(r.id);
      out.push({
        testId: String(r.ext_id),
        status: String(r.status),
        modelVersion: r.model_version === null ? undefined : Number(r.model_version),
        category: r.category === null ? undefined : String(r.category),
        failedStep: r.failed_step === null ? undefined : String(r.failed_step),
        reason: r.reason === null ? undefined : String(r.reason),
        expected: r.expected === null ? undefined : String(r.expected),
        actual: r.actual === null ? undefined : String(r.actual),
        durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
        steps: (await this.db.all<Row>('SELECT * FROM step_results WHERE test_result_id = ? ORDER BY seq', [id])).map((st) => ({
          id: String(st.step_id),
          raw: String(st.raw),
          result: String(st.result),
          error: st.error === null ? undefined : String(st.error),
          screenshotRef: st.screenshot_ref === null ? undefined : String(st.screenshot_ref),
        })),
        checks: (await this.db.all<Row>('SELECT * FROM check_results WHERE test_result_id = ? ORDER BY seq', [id])).map((ck) => ({
          id: String(ck.check_id),
          raw: String(ck.raw),
          expected: ck.expected === null ? undefined : String(ck.expected),
          actual: ck.actual === null ? undefined : String(ck.actual),
          result: String(ck.result),
        })),
        evidence: (await this.db.all<Row>('SELECT * FROM evidence WHERE test_result_id = ? ORDER BY created_at, id', [id])).map((e) => ({
          kind: String(e.kind),
          ref: String(e.storage_ref),
          mime: String(e.mime),
          sizeBytes: Number(e.size_bytes),
          sha256: String(e.sha256),
          stepId: e.step_id === null ? undefined : String(e.step_id),
          masked: Boolean(e.masked),
        })),
      });
    }
    return { ...toExecution(x), results: out };
  }

  /** The next `EXEC-YYYY-NNNNN`: from a counter, so two runs at once never share a number (FR-DB-12). */
  async nextExecutionId(date = new Date()): Promise<string> {
    const year = date.getFullYear();
    return execIdOf(year, await this.nextCounter('execution', String(year)));
  }

  // Explorations (DATABASE.md §5.5): the full result stays a file; the steps are rows that can be searched

  async saveExploration(
    projectId: string,
    exploration: {
      extId: string;
      jobId?: string;
      status: string;
      startedAt?: string;
      finishedAt?: string;
      resultFile?: string;
      items: Array<{
        id: string;
        kind: string;
        phase: string;
        raw: string;
        action?: string;
        status: string;
        resolvedBy?: string;
        strategy?: string;
        locatorCode?: string;
        score?: number;
        pageName?: string;
        effect?: string;
        screenshot?: string;
        warnings: string[];
      }>;
    },
  ): Promise<string> {
    const id = newId('EXP');
    await this.transaction(async (s) => {
      const testCase = await s.db.get<{ id: string; current_version: number }>(
        'SELECT id, current_version FROM test_cases WHERE project_id = ? AND ext_id = ?',
        [projectId, exploration.extId],
      );
      const env = await s.db.get<{ id: string }>('SELECT id FROM environments WHERE project_id = ? AND is_default = 1', [projectId]);
      const counts = { steps: exploration.items.length, review: exploration.items.filter((i) => i.status !== 'done').length };
      await s.db.run(
        `INSERT INTO explorations (id, project_id, test_case_id, ext_id, model_version, environment_id, job_id, status, started_at, finished_at, result_ref, counts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          projectId,
          testCase?.id ?? null,
          exploration.extId,
          testCase?.current_version ?? null,
          env?.id ?? null,
          exploration.jobId ?? null,
          exploration.status,
          exploration.startedAt ?? null,
          exploration.finishedAt ?? null,
          exploration.resultFile ? this.keep(exploration.resultFile) : null,
          JSON.stringify(counts),
        ],
      );
      for (const [seq, i] of exploration.items.entries()) {
        await s.db.run(
          `INSERT INTO exploration_items (exploration_id, item_id, seq, kind, phase, raw, action, status, resolved_by, strategy, locator_code, score, page_name, effect, screenshot_ref, warnings)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (exploration_id, item_id) DO NOTHING`,
          [
            id,
            `${i.phase}:${i.id}`,
            seq,
            i.kind,
            i.phase,
            i.raw,
            i.action ?? null,
            i.status,
            i.resolvedBy ?? null,
            i.strategy ?? null,
            i.locatorCode ?? null,
            i.score ?? null,
            i.pageName ?? null,
            i.effect ?? null,
            i.screenshot ? this.keep(i.screenshot) : null,
            JSON.stringify(i.warnings),
          ],
        );
      }
    });
    return id;
  }

  /** How many steps ended in each status, e.g. how often steps need review. */
  async explorationStats(projectId: string): Promise<Array<{ status: string; count: number }>> {
    const rows = await this.db.all<{ status: string; n: number }>(
      `SELECT i.status, COUNT(*) AS n FROM exploration_items i JOIN explorations e ON e.id = i.exploration_id WHERE e.project_id = ? GROUP BY i.status ORDER BY i.status`,
      [projectId],
    );
    return rows.map((r) => ({ status: r.status, count: Number(r.n) }));
  }

  // Test cases (DATABASE.md §5.4): kept after the run, with their versions, so they can be seen and run again

  /** Adds a test case, or a new version of it when its steps, data or expected result changed. */
  async upsertTestCase(
    projectId: string,
    raw: RawTestCase & { id: string },
    source: { kind: 'form' | 'workbook'; ref?: string; row?: number },
    reason: string,
  ): Promise<TestCaseRecord> {
    const { row: _row, ...kept } = raw;
    const hash = createHash('sha256')
      .update(JSON.stringify([kept.title, kept.type, kept.preconditions, kept.steps, kept.testData, kept.expected, kept.requirementId]))
      .digest('hex')
      .slice(0, 16);
    const at = now();
    await this.transaction(async (s) => {
      const found = await s.db.get<Row>('SELECT * FROM test_cases WHERE project_id = ? AND ext_id = ?', [projectId, raw.id]);
      if (!found) {
        const id = newId('TCS');
        await s.db.run(
          `INSERT INTO test_cases (id, project_id, ext_id, title, raw, source_kind, source_ref, source_row, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [id, projectId, raw.id, raw.title, JSON.stringify(kept), source.kind, source.ref ?? null, source.row ?? null, at, at],
        );
        await s.db.run('INSERT INTO test_case_versions (test_case_id, version, raw, content_hash, reason, created_at) VALUES (?, 1, ?, ?, ?, ?)', [
          id,
          JSON.stringify(kept),
          hash,
          reason,
          at,
        ]);
        await s.audit('testcase.create', 'testcase', id, projectId, { ext_id: raw.id, source: source.kind });
        return;
      }
      const last = await s.db.get<Row>('SELECT content_hash FROM test_case_versions WHERE test_case_id = ? AND version = ?', [
        String(found.id),
        Number(found.current_version),
      ]);
      if (last?.content_hash === hash) {
        await s.db.run('UPDATE test_cases SET source_kind = ?, source_ref = ?, source_row = ?, updated_at = ?, deleted_at = NULL WHERE id = ?', [
          source.kind,
          source.ref ?? null,
          source.row ?? null,
          at,
          String(found.id),
        ]);
        return;
      }
      const version = Number(found.current_version) + 1;
      await s.db.run('INSERT INTO test_case_versions (test_case_id, version, raw, content_hash, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        String(found.id),
        version,
        JSON.stringify(kept),
        hash,
        reason,
        at,
      ]);
      await s.db.run(
        'UPDATE test_cases SET title = ?, raw = ?, source_kind = ?, source_ref = ?, source_row = ?, current_version = ?, updated_at = ?, deleted_at = NULL WHERE id = ?',
        [raw.title, JSON.stringify(kept), source.kind, source.ref ?? null, source.row ?? null, version, at, String(found.id)],
      );
      await s.audit('testcase.update', 'testcase', String(found.id), projectId, { ext_id: raw.id, version, reason });
    });
    return (await this.testCase(projectId, raw.id))!;
  }

  /**
   * Test cases the tester edited in the app. They win over the workbook when it is run again, because the workbook
   * is never changed (D23) and would otherwise undo the edit.
   */
  async editedTestCases(projectId: string): Promise<Record<string, RawTestCase>> {
    const rows = await this.db.all<Row>(
      `SELECT c.ext_id, v.raw FROM test_cases c JOIN test_case_versions v ON v.test_case_id = c.id AND v.version = c.current_version
       WHERE c.project_id = ? AND c.deleted_at IS NULL AND v.reason LIKE 'edited%'`,
      [projectId],
    );
    return Object.fromEntries(rows.map((r) => [String(r.ext_id), { ...(JSON.parse(String(r.raw)) as RawTestCase), id: String(r.ext_id) }]));
  }

  async testCases(projectId: string): Promise<TestCaseRecord[]> {
    const rows = await this.db.all<Row>('SELECT * FROM test_cases WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', [projectId]);
    return rows.map(toTestCase);
  }

  async testCase(projectId: string, extId: string): Promise<TestCaseRecord | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM test_cases WHERE project_id = ? AND ext_id = ? AND deleted_at IS NULL', [projectId, extId]);
    return r && toTestCase(r);
  }

  async testCaseVersions(id: string): Promise<Array<{ version: number; reason: string; createdAt: string; raw: RawTestCase }>> {
    const rows = await this.db.all<Row>('SELECT * FROM test_case_versions WHERE test_case_id = ? ORDER BY version DESC', [id]);
    return rows.map((r) => ({ version: Number(r.version), reason: String(r.reason), createdAt: String(r.created_at), raw: JSON.parse(String(r.raw)) }));
  }

  /** Taking a test case out of the list; its results stay. */
  async deleteTestCase(projectId: string, extId: string): Promise<boolean> {
    const r = await this.db.run('UPDATE test_cases SET deleted_at = ? WHERE project_id = ? AND ext_id = ? AND deleted_at IS NULL', [now(), projectId, extId]);
    return r.changes > 0;
  }

  /** The last result of a case, shown in the list. */
  async recordResult(projectId: string, extId: string, result: { jobId: string; executionId?: string; status: string; at: string }): Promise<void> {
    await this.db.run(
      'UPDATE test_cases SET last_status = ?, last_job_id = ?, last_execution_id = ?, last_run_at = ?, run_count = run_count + 1 WHERE project_id = ? AND ext_id = ?',
      [result.status, result.jobId, result.executionId ?? null, result.at, projectId, extId],
    );
  }

  /** Every run of a case, newest first: runs with a result, and single runs that never got one (cancelled, failed). */
  async testCaseRuns(projectId: string, extId: string, limit = 50): Promise<TestCaseRun[]> {
    const withResult = await this.db.all<Row>(
      `SELECT v.job_id, v.status, v.verdict, j.created_at, j.finished_at, COALESCE(x.exec_id, j.execution_id) AS execution_id, j.status AS job_status, j.kind
       FROM test_results v JOIN jobs j ON j.id = v.job_id LEFT JOIN executions x ON x.id = v.execution_id WHERE j.project_id = ? AND v.ext_id = ? ORDER BY j.created_at DESC LIMIT ?`,
      [projectId, extId, limit],
    );
    const runs: TestCaseRun[] = withResult.map((r) => {
      const v = JSON.parse(String(r.verdict)) as { actual?: string; reason?: string; durationMs?: number };
      return {
        jobId: String(r.job_id),
        executionId: r.execution_id === null ? undefined : String(r.execution_id),
        kind: r.kind as JobKind,
        jobStatus: r.job_status as JobStatus,
        status: String(r.status),
        at: String(r.created_at),
        finishedAt: r.finished_at === null ? undefined : String(r.finished_at),
        summary: v.actual ?? v.reason,
        durationMs: v.durationMs,
      };
    });
    const seen = new Set(runs.map((r) => r.jobId));
    const singles = await this.db.all<Row>("SELECT * FROM jobs WHERE project_id = ? AND kind = 'single' ORDER BY created_at DESC LIMIT 200", [projectId]);
    for (const row of singles.map(toJob)) {
      if (seen.has(row.id) || (row.input.case as { id?: string } | undefined)?.id !== extId) continue;
      runs.push({
        jobId: row.id,
        kind: row.kind,
        jobStatus: row.status,
        status: row.status,
        at: row.createdAt,
        finishedAt: row.finishedAt,
        summary: row.error,
      });
    }
    return runs.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  // Project rules (FR-RULE): the answers testers gave in review, kept so the same wording is never asked about again

  async rules(projectId: string): Promise<ProjectRule[]> {
    const rows = await this.db.all<Row>('SELECT * FROM project_rules WHERE project_id = ? ORDER BY kind, created_at', [projectId]);
    return rows.map(toRule);
  }

  /** Adds a rule, or changes what an existing one for the same wording means (and switches it on). */
  async upsertRule(projectId: string, rule: { kind: RuleKind; pattern: string; meaning?: string; source: string }): Promise<ProjectRule> {
    const pattern = ruleKey(rule.pattern);
    const at = now();
    await this.db.run(
      `INSERT INTO project_rules (id, project_id, kind, pattern, meaning, source, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (project_id, kind, pattern) DO UPDATE SET meaning = excluded.meaning, source = excluded.source, enabled = 1, updated_at = excluded.updated_at`,
      [newId('RULE'), projectId, rule.kind, pattern, rule.meaning ?? '', rule.source, at, at],
    );
    await this.audit('rule.save', 'rule', `${rule.kind}:${pattern}`, projectId, { kind: rule.kind, source: rule.source });
    const r = await this.db.get<Row>('SELECT * FROM project_rules WHERE project_id = ? AND kind = ? AND pattern = ?', [projectId, rule.kind, pattern]);
    return toRule(r as Row);
  }

  async updateRule(projectId: string, id: string, changes: { meaning?: string; enabled?: boolean }): Promise<ProjectRule | undefined> {
    const current = await this.db.get<Row>('SELECT * FROM project_rules WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!current) return undefined;
    const meaning = changes.meaning ?? String(current.meaning);
    const enabled = changes.enabled ?? Boolean(current.enabled);
    await this.db.run('UPDATE project_rules SET meaning = ?, enabled = ?, updated_at = ? WHERE id = ?', [meaning, enabled ? 1 : 0, now(), id]);
    await this.audit('rule.update', 'rule', id, projectId, { enabled });
    return toRule((await this.db.get<Row>('SELECT * FROM project_rules WHERE id = ?', [id])) as Row);
  }

  async deleteRule(projectId: string, id: string): Promise<boolean> {
    const r = await this.db.run('DELETE FROM project_rules WHERE id = ? AND project_id = ?', [id, projectId]);
    if (r.changes) await this.audit('rule.delete', 'rule', id, projectId);
    return r.changes > 0;
  }

  // Settings (the small per-project choices)

  async setting(scope: 'global' | 'project' | 'user', scopeId: string, key: string): Promise<unknown> {
    const r = await this.db.get<Row>('SELECT value FROM settings WHERE scope = ? AND scope_id = ? AND key = ?', [scope, scopeId, key]);
    return r ? JSON.parse(String(r.value)) : undefined;
  }

  async setSetting(scope: 'global' | 'project' | 'user', scopeId: string, key: string, value: unknown): Promise<void> {
    await this.db.run(
      `INSERT INTO settings (scope, scope_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [scope, scopeId, key, JSON.stringify(value), now()],
    );
  }

  /** How much the platform may decide without asking for this project (D30). Balanced unless the tester chose otherwise. */
  async projectPolicy(projectId: string): Promise<Policy> {
    const v = await this.setting('project', projectId, 'policy');
    return isPolicy(v) ? v : DEFAULT_POLICY;
  }

  // Counters and audit

  /** The next number of a named sequence, safe when two callers ask at once (FR-DB-12). */
  async nextCounter(name: string, scope: string): Promise<number> {
    return this.transaction(async (s) => {
      await s.db.run('INSERT INTO counters (name, scope, value) VALUES (?, ?, 0) ON CONFLICT (name, scope) DO NOTHING', [name, scope]);
      await s.db.run('UPDATE counters SET value = value + 1 WHERE name = ? AND scope = ?', [name, scope]);
      const r = await s.db.get<{ value: number }>('SELECT value FROM counters WHERE name = ? AND scope = ?', [name, scope]);
      return Number(r?.value);
    });
  }

  /** One row per user-visible change. `detail` must never hold a secret. */
  async audit(action: string, entity: string, entityId: string, projectId?: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.db.run('INSERT INTO audit_log (at, project_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)', [
      now(),
      projectId ?? null,
      action,
      entity,
      entityId,
      JSON.stringify(detail),
    ]);
  }

  async auditLog(projectId: string, limit = 100): Promise<Array<{ at: string; action: string; entity: string; entityId: string; detail: unknown }>> {
    const rows = await this.db.all<Row>('SELECT * FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?', [projectId, limit]);
    return rows.map((r) => ({
      at: String(r.at),
      action: String(r.action),
      entity: String(r.entity),
      entityId: String(r.entity_id),
      detail: JSON.parse(String(r.detail)),
    }));
  }
  private toProject(r: Row): Project {
    return {
      id: String(r.id),
      name: String(r.name),
      baseUrl: String(r.base_url),
      testIdAttribute: String(r.test_id_attribute),
      browser: 'chromium',
      workspace: this.open(String(r.workspace)),
      createdAt: String(r.created_at),
    };
  }

  /** For `db verify`: empty means healthy. */
  async problems(): Promise<string[]> {
    const found = await problems(this.db);
    // A counter below a number already handed out would repeat it (FR-DB-12).
    const counters = await this.db.all<{ scope: string; value: number }>("SELECT scope, value FROM counters WHERE name = 'execution'");
    const have = new Map(counters.map((c) => [c.scope, Number(c.value)]));
    const used = new Map<string, number>();
    for (const x of await this.db.all<{ exec_id: string }>('SELECT exec_id FROM executions')) {
      const m = EXEC_ID.exec(x.exec_id);
      if (m) used.set(m[1], Math.max(used.get(m[1]) ?? 0, Number(m[2])));
    }
    for (const [year, n] of used) {
      if ((have.get(year) ?? 0) < n)
        found.push(`the execution counter for ${year} is ${have.get(year) ?? 0}, but EXEC-${year}-${String(n).padStart(5, '0')} exists`);
    }
    return found;
  }

  /** The files recorded as evidence of one run: what `db verify` compares the run's folder with. */
  async executionEvidenceRefs(projectId: string, execId: string): Promise<Set<string>> {
    const rows = await this.db.all<{ storage_ref: string }>(
      `SELECT e.storage_ref FROM evidence e JOIN test_results t ON t.id = e.test_result_id JOIN executions x ON x.id = t.execution_id
       WHERE x.project_id = ? AND x.exec_id = ?`,
      [projectId, execId],
    );
    return new Set(rows.map((r) => r.storage_ref));
  }

  /** Every storage reference in the database, for `db verify` to check against the files (DATABASE.md §7.6). */
  async storageRefs(): Promise<Array<{ table: string; id: string; ref: string }>> {
    const out: Array<{ table: string; id: string; ref: string }> = [];
    const collect = async (table: string, id: string, column: string) => {
      for (const r of await this.db.all<{ id: string; ref: string }>(`SELECT ${id} AS id, ${column} AS ref FROM ${table} WHERE ${column} IS NOT NULL`)) {
        if (isRef(String(r.ref))) out.push({ table, id: String(r.id), ref: String(r.ref) });
      }
    };
    await collect('uploads', 'id', 'file');
    await collect('evidence', 'id', 'storage_ref');
    await collect('step_results', "test_result_id || '/' || step_id", 'screenshot_ref');
    await collect('explorations', 'id', 'result_ref');
    await collect('exploration_items', "exploration_id || '/' || item_id", 'screenshot_ref');
    return out;
  }
}

function toExecution(r: Row): ExecutionRecord {
  return {
    execId: String(r.exec_id),
    projectId: String(r.project_id),
    jobId: r.job_id === null ? undefined : String(r.job_id),
    status: String(r.status),
    totals: JSON.parse(String(r.totals)),
    startedAt: r.started_at === null ? undefined : String(r.started_at),
    finishedAt: r.finished_at === null ? undefined : String(r.finished_at),
    durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
  };
}

function toRule(r: Row): ProjectRule {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: r.kind as RuleKind,
    pattern: String(r.pattern),
    meaning: String(r.meaning),
    source: String(r.source),
    enabled: Boolean(r.enabled),
    createdAt: String(r.created_at),
  };
}

function toTestCase(r: Row): TestCaseRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    extId: String(r.ext_id),
    title: String(r.title),
    raw: JSON.parse(String(r.raw)),
    sourceKind: r.source_kind as 'form' | 'workbook',
    sourceRef: r.source_ref === null ? undefined : String(r.source_ref),
    sourceRow: r.source_row === null ? undefined : Number(r.source_row),
    version: Number(r.current_version),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastStatus: r.last_status === null ? undefined : String(r.last_status),
    lastJobId: r.last_job_id === null ? undefined : String(r.last_job_id),
    lastExecutionId: r.last_execution_id === null ? undefined : String(r.last_execution_id),
    lastRunAt: r.last_run_at === null ? undefined : String(r.last_run_at),
    runCount: Number(r.run_count),
  };
}

function toJob(r: Row): Job {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: r.kind as JobKind,
    status: r.status as JobStatus,
    input: JSON.parse(String(r.input)),
    output: JSON.parse(String(r.output)),
    executionId: r.execution_id === null ? undefined : String(r.execution_id),
    error: r.error === null ? undefined : String(r.error),
    createdAt: String(r.created_at),
    startedAt: r.started_at === null ? undefined : String(r.started_at),
    finishedAt: r.finished_at === null ? undefined : String(r.finished_at),
  };
}

function toQuestion(r: Row): Question {
  return {
    id: Number(r.id),
    jobId: String(r.job_id),
    kind: r.kind as Question['kind'],
    payload: JSON.parse(String(r.payload)),
    answer: r.answer === null ? undefined : JSON.parse(String(r.answer)),
    createdAt: String(r.created_at),
    answeredAt: r.answered_at === null ? undefined : String(r.answered_at),
  };
}
