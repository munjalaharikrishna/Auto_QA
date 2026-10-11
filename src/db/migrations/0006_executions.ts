import type { Queryable } from '../driver.js';
import type { Migration } from '../migrate.js';
import { EXEC_ID, resultColumns, runId } from '../results.js';

/**
 * Executions, results, explorations and evidence (DATABASE.md §5.5, §5.7).
 *
 * `verdicts` (one JSON blob per job and test) becomes `test_results` with the queryable parts as columns, and stays
 * readable under its old name as a view for one release (expand, then contract, §6.3). The old rows are copied in `after`.
 * The `EXEC-…` counter starts above every number already used, so no id is handed out twice.
 */
export const executions: Migration = {
  version: 6,
  name: 'executions',
  statements: (d) => [
    `ALTER TABLE verdicts RENAME TO verdicts_legacy`,
    `CREATE TABLE executions (
      id TEXT PRIMARY KEY, exec_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
      environment_id TEXT REFERENCES environments(id), job_id TEXT REFERENCES jobs(id),
      trigger TEXT NOT NULL DEFAULT 'job', browser TEXT, status TEXT NOT NULL, totals ${d.json} NOT NULL DEFAULT '{}',
      started_at ${d.ts}, finished_at ${d.ts}, duration_ms INTEGER, created_by INTEGER NOT NULL DEFAULT 1,
      UNIQUE (project_id, exec_id))`,
    `CREATE TABLE test_results (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), project_id TEXT NOT NULL REFERENCES projects(id),
      execution_id TEXT REFERENCES executions(id), test_case_id TEXT REFERENCES test_cases(id), model_version INTEGER,
      ext_id TEXT NOT NULL, row INTEGER, automation_id TEXT, status TEXT NOT NULL, category TEXT, failed_step TEXT,
      reason TEXT, expected TEXT, actual TEXT, duration_ms INTEGER, started_at ${d.ts}, verdict ${d.json} NOT NULL,
      UNIQUE (job_id, ext_id))`,
    `CREATE TABLE step_results (
      test_result_id TEXT NOT NULL REFERENCES test_results(id), step_id TEXT NOT NULL, seq INTEGER NOT NULL, raw TEXT NOT NULL,
      result TEXT NOT NULL, duration_ms INTEGER, error TEXT, screenshot_ref TEXT, PRIMARY KEY (test_result_id, step_id))`,
    `CREATE TABLE check_results (
      test_result_id TEXT NOT NULL REFERENCES test_results(id), check_id TEXT NOT NULL, seq INTEGER NOT NULL, raw TEXT NOT NULL,
      expected TEXT, actual TEXT, result TEXT NOT NULL, PRIMARY KEY (test_result_id, check_id))`,
    `CREATE TABLE evidence (
      id TEXT PRIMARY KEY, test_result_id TEXT NOT NULL REFERENCES test_results(id), step_id TEXT, kind TEXT NOT NULL,
      storage_ref TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
      masked ${d.bool} NOT NULL DEFAULT 1, restricted ${d.bool} NOT NULL DEFAULT 0, created_at ${d.ts} NOT NULL, expires_at ${d.ts})`,
    `CREATE TABLE explorations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), test_case_id TEXT REFERENCES test_cases(id),
      ext_id TEXT NOT NULL, model_version INTEGER, environment_id TEXT REFERENCES environments(id),
      job_id TEXT REFERENCES jobs(id), status TEXT NOT NULL, started_at ${d.ts}, finished_at ${d.ts},
      result_ref TEXT, counts ${d.json} NOT NULL DEFAULT '{}')`,
    `CREATE TABLE exploration_items (
      exploration_id TEXT NOT NULL REFERENCES explorations(id), item_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
      phase TEXT NOT NULL, raw TEXT NOT NULL, action TEXT, status TEXT NOT NULL, resolved_by TEXT, strategy TEXT, locator_code TEXT,
      score REAL, page_name TEXT, effect TEXT, screenshot_ref TEXT, warnings ${d.json} NOT NULL DEFAULT '[]',
      PRIMARY KEY (exploration_id, item_id))`,
    `CREATE TABLE generation_snapshots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), execution_id TEXT REFERENCES executions(id),
      manifest ${d.json} NOT NULL, created_at ${d.ts} NOT NULL)`,
    `CREATE INDEX executions_project ON executions (project_id, started_at)`,
    `CREATE INDEX test_results_case ON test_results (project_id, ext_id)`,
    `CREATE INDEX test_results_execution ON test_results (execution_id)`,
    `CREATE INDEX test_results_status ON test_results (status)`,
    `CREATE INDEX evidence_result ON evidence (test_result_id)`,
    `CREATE INDEX evidence_expires ON evidence (expires_at)`,
    `CREATE INDEX explorations_case ON explorations (project_id, ext_id, started_at)`,
    `CREATE INDEX exploration_items_status ON exploration_items (status)`,
    `CREATE INDEX exploration_items_locator ON exploration_items (locator_code)`,
    `CREATE VIEW verdicts AS SELECT job_id, ext_id AS test_id, row, status, verdict FROM test_results`,
  ],

  /** Copies what the old tables held. Paged, so a large history is never loaded at once. */
  async after(tx: Queryable) {
    const PAGE = 500;

    // Every run a job recorded gets an execution row, so results can point at it.
    const known = new Set<string>();
    let largest: Record<string, number> = {};
    const note = (execId: string) => {
      const m = EXEC_ID.exec(execId);
      if (m) largest = { ...largest, [m[1]]: Math.max(largest[m[1]] ?? 0, Number(m[2])) };
    };
    for (let offset = 0; ; offset += PAGE) {
      const jobs = await tx.all<{
        id: string;
        project_id: string;
        execution_id: string;
        status: string;
        created_at: string;
        started_at: string | null;
        finished_at: string | null;
      }>(
        'SELECT id, project_id, execution_id, status, created_at, started_at, finished_at FROM jobs WHERE execution_id IS NOT NULL ORDER BY id LIMIT ? OFFSET ?',
        [PAGE, offset],
      );
      if (!jobs.length) break;
      for (const j of jobs) {
        const id = runId(j.project_id, j.execution_id);
        note(j.execution_id);
        if (known.has(id)) continue;
        known.add(id);
        await tx.run(
          `INSERT INTO executions (id, exec_id, project_id, environment_id, job_id, trigger, status, totals, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, 'job', ?, '{}', ?, ?)`,
          [id, j.execution_id, j.project_id, `ENV-${j.project_id}`, j.id, j.status === 'done' ? 'done' : j.status, j.started_at ?? j.created_at, j.finished_at],
        );
      }
    }

    for (let offset = 0; ; offset += PAGE) {
      const rows = await tx.all<{ job_id: string; test_id: string; row: number | null; status: string; verdict: string; project_id: string }>(
        `SELECT v.job_id, v.test_id, v.row, v.status, v.verdict, j.project_id
         FROM verdicts_legacy v JOIN jobs j ON j.id = v.job_id ORDER BY v.job_id, v.test_id LIMIT ? OFFSET ?`,
        [PAGE, offset],
      );
      if (!rows.length) break;
      for (const r of rows) {
        const parsed: unknown = JSON.parse(r.verdict);
        const c = resultColumns(parsed);
        if (c.executionId) note(c.executionId);
        const execution = c.executionId && known.has(runId(r.project_id, c.executionId)) ? runId(r.project_id, c.executionId) : null;
        const testCase = await tx.get<{ id: string; current_version: number }>(
          'SELECT id, current_version FROM test_cases WHERE project_id = ? AND ext_id = ?',
          [r.project_id, r.test_id],
        );
        await tx.run(
          `INSERT INTO test_results (id, job_id, project_id, execution_id, test_case_id, model_version, ext_id, row, automation_id, status, category,
             failed_step, reason, expected, actual, duration_ms, started_at, verdict)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `TR-${r.job_id}-${r.test_id}`,
            r.job_id,
            r.project_id,
            execution,
            testCase?.id ?? null,
            testCase?.current_version ?? null,
            r.test_id,
            r.row,
            c.automationId,
            r.status,
            c.category,
            c.failedStep,
            c.reason,
            c.expected,
            c.actual,
            c.durationMs,
            c.startedAt,
            r.verdict,
          ],
        );
      }
    }

    // New numbers start above every one already used (FR-DB-12).
    for (const [year, n] of Object.entries(largest)) {
      await tx.run('INSERT INTO counters (name, scope, value) VALUES (?, ?, ?) ON CONFLICT (name, scope) DO UPDATE SET value = excluded.value', [
        'execution',
        year,
        n,
      ]);
    }
  },
};
