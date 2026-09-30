import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Platform storage (SPEC §3, D20): SQLite on the owner's laptop. PostgreSQL arrives with team mode (V3),
 * so the tables carry an owner from day one. Passwords are never stored here: they live only in the
 * project workspace's git-ignored .env (FR-ENV-05).
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

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  /** `file` is the database path, or `:memory:` for tests. */
  static async open(file: string): Promise<Store> {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const store = new Store(db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
      INSERT OR IGNORE INTO users (id, name, role) VALUES (1, 'Owner', 'admin');
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id),
        name TEXT NOT NULL, base_url TEXT NOT NULL, test_id_attribute TEXT NOT NULL, browser TEXT NOT NULL,
        workspace TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), file TEXT NOT NULL,
        original_name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_id INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL DEFAULT '{}',
        execution_id TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS job_logs (job_id TEXT NOT NULL REFERENCES jobs(id), at TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL,
        payload TEXT NOT NULL, answer TEXT, created_at TEXT NOT NULL, answered_at TEXT);
      CREATE TABLE IF NOT EXISTS verdicts (
        job_id TEXT NOT NULL REFERENCES jobs(id), test_id TEXT NOT NULL, row INTEGER, status TEXT NOT NULL,
        verdict TEXT NOT NULL, PRIMARY KEY (job_id, test_id));
    `);
  }

  close(): void {
    this.db.close();
  }

  // Projects

  createProject(p: Omit<Project, 'createdAt'>): Project {
    const project = { ...p, createdAt: now() };
    this.db
      .prepare('INSERT INTO projects (id, name, base_url, test_id_attribute, browser, workspace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.baseUrl, project.testIdAttribute, project.browser, project.workspace, project.createdAt);
    return project;
  }

  updateProject(id: string, changes: Partial<Pick<Project, 'name' | 'baseUrl' | 'testIdAttribute'>>): Project | undefined {
    const current = this.project(id);
    if (!current) return undefined;
    // A field left out of the update keeps its value.
    const given = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    const next = { ...current, ...given };
    this.db.prepare('UPDATE projects SET name = ?, base_url = ?, test_id_attribute = ? WHERE id = ?').run(next.name, next.baseUrl, next.testIdAttribute, id);
    return next;
  }

  project(id: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, string> | undefined;
    return r && toProject(r);
  }

  projects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Array<Record<string, string>>).map(toProject);
  }

  // Uploads

  createUpload(u: Omit<Upload, 'id' | 'createdAt'>): Upload {
    const upload = { ...u, id: newId('UP'), createdAt: now() };
    this.db
      .prepare('INSERT INTO uploads (id, project_id, file, original_name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(upload.id, upload.projectId, upload.file, upload.originalName, upload.createdAt);
    return upload;
  }

  upload(id: string): Upload | undefined {
    const r = this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as Record<string, string> | undefined;
    return r && { id: r.id, projectId: r.project_id, file: r.file, originalName: r.original_name, createdAt: r.created_at };
  }

  // Jobs

  createJob(j: Pick<Job, 'projectId' | 'kind' | 'input'>): Job {
    const job: Job = { ...j, id: newId('JOB'), status: 'queued', output: {}, createdAt: now() };
    this.db
      .prepare('INSERT INTO jobs (id, project_id, kind, status, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(job.id, job.projectId, job.kind, job.status, JSON.stringify(job.input), '{}', job.createdAt);
    return job;
  }

  updateJob(id: string, changes: Partial<Pick<Job, 'status' | 'output' | 'executionId' | 'error' | 'startedAt' | 'finishedAt' | 'input'>>): Job {
    const job = this.job(id);
    if (!job) throw new Error(`No job ${id}`);
    const next = { ...job, ...changes };
    this.db
      .prepare('UPDATE jobs SET status = ?, input = ?, output = ?, execution_id = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?')
      .run(
        next.status,
        JSON.stringify(next.input),
        JSON.stringify(next.output),
        next.executionId ?? null,
        next.error ?? null,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        id,
      );
    return next;
  }

  job(id: string): Job | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, string | null> | undefined;
    return r && toJob(r);
  }

  jobs(projectId: string, limit = 50): Job[] {
    return (
      this.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as Array<Record<string, string | null>>
    ).map(toJob);
  }

  /** Jobs a restart interrupted: they are marked failed, never silently resumed. */
  interruptedJobs(): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE status IN ('running', 'waiting', 'review', 'queued')").all() as Array<Record<string, string | null>>).map(
      toJob,
    );
  }

  log(jobId: string, message: string): void {
    this.db.prepare('INSERT INTO job_logs (job_id, at, message) VALUES (?, ?, ?)').run(jobId, now(), message);
  }

  logs(jobId: string): Array<{ at: string; message: string }> {
    return this.db.prepare('SELECT at, message FROM job_logs WHERE job_id = ? ORDER BY rowid').all(jobId) as Array<{ at: string; message: string }>;
  }

  // Questions

  ask(jobId: string, kind: Question['kind'], payload: Record<string, unknown>): Question {
    const createdAt = now();
    const r = this.db
      .prepare('INSERT INTO questions (job_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(jobId, kind, JSON.stringify(payload), createdAt);
    return { id: Number(r.lastInsertRowid), jobId, kind, payload, createdAt };
  }

  answer(id: number, answer: unknown): Question | undefined {
    this.db.prepare('UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL').run(JSON.stringify(answer), now(), id);
    return this.question(id);
  }

  question(id: number): Question | undefined {
    const r = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    return r && toQuestion(r);
  }

  openQuestions(jobId: string): Question[] {
    return (
      this.db.prepare('SELECT * FROM questions WHERE job_id = ? AND answered_at IS NULL ORDER BY id').all(jobId) as Array<
        Record<string, string | number | null>
      >
    ).map(toQuestion);
  }

  // Verdicts

  saveVerdicts(jobId: string, rows: Array<{ testId: string; row?: number; status: string; verdict: unknown }>): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO verdicts (job_id, test_id, row, status, verdict) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) stmt.run(jobId, r.testId, r.row ?? null, r.status, JSON.stringify(r.verdict));
  }

  verdicts(jobId: string): Array<{ testId: string; row?: number; status: string; verdict: unknown }> {
    const rows = this.db.prepare('SELECT * FROM verdicts WHERE job_id = ? ORDER BY row, test_id').all(jobId) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      testId: String(r.test_id),
      row: r.row === null ? undefined : Number(r.row),
      status: String(r.status),
      verdict: JSON.parse(String(r.verdict)),
    }));
  }
}

function toProject(r: Record<string, string>): Project {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    testIdAttribute: r.test_id_attribute,
    browser: 'chromium',
    workspace: r.workspace,
    createdAt: r.created_at,
  };
}

function toJob(r: Record<string, string | null>): Job {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: r.kind as JobKind,
    status: r.status as JobStatus,
    input: JSON.parse(String(r.input)),
    output: JSON.parse(String(r.output)),
    executionId: r.execution_id ?? undefined,
    error: r.error ?? undefined,
    createdAt: String(r.created_at),
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
  };
}

function toQuestion(r: Record<string, string | number | null>): Question {
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
