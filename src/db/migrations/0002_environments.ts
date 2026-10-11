import type { Migration } from '../migrate.js';

/**
 * Environments from day one (DATABASE.md §5.3): V1 has one "Default" environment per project, so V2's
 * Dev/QA/UAT are new rows, not a new table. Also the small shared tables: settings, counters, audit.
 * `projects.base_url` stays as a mirror for one release (expand now, contract later, §6.3).
 */
export const environments: Migration = {
  version: 2,
  name: 'environments',
  statements: (d) => [
    `ALTER TABLE projects ADD COLUMN updated_at ${d.ts}`,
    `ALTER TABLE projects ADD COLUMN archived_at ${d.ts}`,
    `CREATE TABLE environments (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, base_url TEXT NOT NULL,
      is_production ${d.bool} NOT NULL DEFAULT 0, is_default ${d.bool} NOT NULL DEFAULT 0,
      created_at ${d.ts} NOT NULL, updated_at ${d.ts} NOT NULL, UNIQUE (project_id, name))`,
    `INSERT INTO environments (id, project_id, name, base_url, is_production, is_default, created_at, updated_at)
      SELECT 'ENV-' || id, id, 'Default', base_url, 0, 1, created_at, created_at FROM projects`,
    `CREATE TABLE page_routes (
      id ${d.autoId}, environment_id TEXT NOT NULL REFERENCES environments(id), page_name TEXT NOT NULL, path TEXT NOT NULL,
      source TEXT NOT NULL, created_at ${d.ts} NOT NULL, updated_at ${d.ts} NOT NULL, UNIQUE (environment_id, page_name))`,
    `CREATE TABLE settings (
      scope TEXT NOT NULL, scope_id TEXT NOT NULL, key TEXT NOT NULL, value ${d.json} NOT NULL, updated_at ${d.ts} NOT NULL,
      PRIMARY KEY (scope, scope_id, key))`,
    `CREATE TABLE counters (name TEXT NOT NULL, scope TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (name, scope))`,
    `CREATE TABLE audit_log (
      id ${d.autoId}, at ${d.ts} NOT NULL, user_id INTEGER NOT NULL DEFAULT 1, project_id TEXT, action TEXT NOT NULL,
      entity TEXT NOT NULL, entity_id TEXT NOT NULL, detail ${d.json} NOT NULL DEFAULT '{}')`,
    `CREATE INDEX audit_log_project ON audit_log (project_id, id)`,
  ],
};
