import type { Migration } from '../migrate.js';

/**
 * Log lines get a real id, so they are ordered the same way on every database (SQLite's hidden rowid
 * does not exist in PostgreSQL). SQLite cannot add a primary key to a table, so the table is rebuilt.
 */
export const jobLogIds: Migration = {
  version: 3,
  name: 'job_log_ids',
  statements: (d) => [
    `CREATE TABLE job_logs_new (
      id ${d.autoId}, job_id TEXT NOT NULL REFERENCES jobs(id), at ${d.ts} NOT NULL, level TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL)`,
    `INSERT INTO job_logs_new (job_id, at, message) SELECT job_id, at, message FROM job_logs${d.name === 'sqlite' ? ' ORDER BY rowid' : ''}`,
    `DROP TABLE job_logs`,
    `ALTER TABLE job_logs_new RENAME TO job_logs`,
    `CREATE INDEX job_logs_job ON job_logs (job_id, id)`,
    `CREATE INDEX jobs_project ON jobs (project_id, created_at)`,
  ],
};
