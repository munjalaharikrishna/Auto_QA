import { createHash, randomBytes } from 'node:crypto';
import type { RawTestCase } from '../model/test-model.js';
import type { Driver, Queryable } from './driver.js';
import { migrate } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';
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
  ) {}

  /** `file` is the database path, or `:memory:` for tests. Pending migrations are applied first (D26). */
  static async open(file: string, options: { backupDir?: string; appVersion?: string } = {}): Promise<Store> {
    const driver = await SqliteDriver.open(file);
    try {
      await migrate(driver, MIGRATIONS, options);
    } catch (e) {
      await driver.close();
      throw e;
    }
    return new Store(driver, driver);
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
    return this.driver.transaction((tx) => fn(new Store(tx)));
  }

  // Projects

  async createProject(p: Omit<Project, 'createdAt'>): Promise<Project> {
    const project = { ...p, createdAt: now() };
    await this.transaction(async (s) => {
      await s.db.run(
        'INSERT INTO projects (id, name, base_url, test_id_attribute, browser, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [project.id, project.name, project.baseUrl, project.testIdAttribute, project.browser, project.workspace, project.createdAt, project.createdAt],
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
    return r && toProject(r);
  }

  async projects(): Promise<Project[]> {
    return (await this.db.all<Row>(`${PROJECT_SELECT} WHERE p.archived_at IS NULL ORDER BY p.created_at`)).map(toProject);
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

  // Uploads

  async createUpload(u: Omit<Upload, 'id' | 'createdAt'>): Promise<Upload> {
    const upload = { ...u, id: newId('UP'), createdAt: now() };
    await this.db.run('INSERT INTO uploads (id, project_id, file, original_name, created_at) VALUES (?, ?, ?, ?, ?)', [
      upload.id,
      upload.projectId,
      upload.file,
      upload.originalName,
      upload.createdAt,
    ]);
    return upload;
  }

  async upload(id: string): Promise<Upload | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM uploads WHERE id = ?', [id]);
    return (
      r && { id: String(r.id), projectId: String(r.project_id), file: String(r.file), originalName: String(r.original_name), createdAt: String(r.created_at) }
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

  // Verdicts

  async saveVerdicts(jobId: string, rows: Array<{ testId: string; row?: number; status: string; verdict: unknown }>): Promise<void> {
    await this.transaction(async (s) => {
      for (const r of rows) {
        await s.db.run(
          `INSERT INTO verdicts (job_id, test_id, row, status, verdict) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (job_id, test_id) DO UPDATE SET row = excluded.row, status = excluded.status, verdict = excluded.verdict`,
          [jobId, r.testId, r.row ?? null, r.status, JSON.stringify(r.verdict)],
        );
      }
    });
  }

  async verdicts(jobId: string): Promise<Array<{ testId: string; row?: number; status: string; verdict: unknown }>> {
    const rows = await this.db.all<Row>('SELECT * FROM verdicts WHERE job_id = ? ORDER BY row, test_id', [jobId]);
    return rows.map((r) => ({
      testId: String(r.test_id),
      row: r.row === null ? undefined : Number(r.row),
      status: String(r.status),
      verdict: JSON.parse(String(r.verdict)),
    }));
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
      `SELECT v.job_id, v.status, v.verdict, j.created_at, j.finished_at, j.execution_id, j.status AS job_status, j.kind
       FROM verdicts v JOIN jobs j ON j.id = v.job_id WHERE j.project_id = ? AND v.test_id = ? ORDER BY j.created_at DESC LIMIT ?`,
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
  /** For `db verify`: empty means healthy. */
  async problems(): Promise<string[]> {
    return problems(this.db);
  }
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

function toProject(r: Row): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    baseUrl: String(r.base_url),
    testIdAttribute: String(r.test_id_attribute),
    browser: 'chromium',
    workspace: String(r.workspace),
    createdAt: String(r.created_at),
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
