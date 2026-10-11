import type { Migration } from '../migrate.js';

/**
 * The database as M7a created it. Written so that running it on a database that already has these
 * tables changes nothing: that is how an existing install is adopted (DATABASE.md §6.2, FR-DB-05).
 */
export const baseline: Migration = {
  version: 1,
  name: 'baseline',
  statements: (d) => [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL)`,
    `INSERT INTO users (id, name, role) SELECT 1, 'Owner', 'admin' WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 1)`,
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id),
      name TEXT NOT NULL, base_url TEXT NOT NULL, test_id_attribute TEXT NOT NULL, browser TEXT NOT NULL,
      workspace TEXT NOT NULL, created_at ${d.ts} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), file TEXT NOT NULL,
      original_name TEXT NOT NULL, created_at ${d.ts} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_id INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL, status TEXT NOT NULL, input ${d.json} NOT NULL, output ${d.json} NOT NULL DEFAULT '{}',
      execution_id TEXT, error TEXT, created_at ${d.ts} NOT NULL, started_at ${d.ts}, finished_at ${d.ts})`,
    `CREATE TABLE IF NOT EXISTS job_logs (job_id TEXT NOT NULL REFERENCES jobs(id), at ${d.ts} NOT NULL, message TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS questions (
      id ${d.autoId}, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL,
      payload ${d.json} NOT NULL, answer ${d.json}, created_at ${d.ts} NOT NULL, answered_at ${d.ts})`,
    `CREATE TABLE IF NOT EXISTS verdicts (
      job_id TEXT NOT NULL REFERENCES jobs(id), test_id TEXT NOT NULL, row INTEGER, status TEXT NOT NULL,
      verdict ${d.json} NOT NULL, PRIMARY KEY (job_id, test_id))`,
  ],
};
