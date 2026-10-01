import type { Migration } from '../migrate.js';

/**
 * Project rules (REAL-WORLD-TEST-CASES.md M3, FR-RULE): the answers testers gave in review, kept per project so the same
 * wording is never asked about again. They can be edited, switched off, exported and imported.
 */
export const projectRules: Migration = {
  version: 5,
  name: 'project_rules',
  statements: (d) => [
    `CREATE TABLE project_rules (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, pattern TEXT NOT NULL,
      meaning TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, enabled ${d.bool} NOT NULL DEFAULT 1,
      created_at ${d.ts} NOT NULL, updated_at ${d.ts} NOT NULL, UNIQUE (project_id, kind, pattern))`,
    `CREATE INDEX project_rules_project ON project_rules (project_id, kind)`,
  ],
};
