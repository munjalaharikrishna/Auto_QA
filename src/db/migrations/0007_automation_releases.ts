import type { Migration } from '../migrate.js';

/**
 * Approval of test cases, the recorded script of a case, and release tracking.
 *
 * A test case is `draft` until a tester approves it; only approved cases appear in Web Automation. A release keeps its
 * scope, its planned date and its features. Once the scope is locked (`baselined_at`), every change (a feature added or
 * removed, a new date) is a row in `release_changes` with the date before and after, so the slip can be explained.
 */
export const automationReleases: Migration = {
  version: 7,
  name: 'automation_releases',
  statements: (d) => [
    `ALTER TABLE test_cases ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'draft'`,
    `ALTER TABLE test_cases ADD COLUMN approved_at ${d.ts}`,
    `ALTER TABLE test_cases ADD COLUMN recorded_version INTEGER`,
    `ALTER TABLE test_cases ADD COLUMN recorded_at ${d.ts}`,
    `ALTER TABLE test_cases ADD COLUMN recorded_job_id TEXT`,
    `CREATE TABLE releases (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned', team_size INTEGER NOT NULL DEFAULT 1,
      start_date TEXT, baseline_date TEXT NOT NULL, due_date TEXT NOT NULL, baselined_at ${d.ts},
      created_at ${d.ts} NOT NULL, updated_at ${d.ts} NOT NULL, deleted_at ${d.ts})`,
    `CREATE TABLE release_features (
      id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      requirement_id TEXT, effort_days REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'planned',
      added_after_baseline ${d.bool} NOT NULL DEFAULT 0, removed_at ${d.ts}, case_ids ${d.json} NOT NULL DEFAULT '[]', created_at ${d.ts} NOT NULL)`,
    `CREATE TABLE release_changes (
      id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id), at ${d.ts} NOT NULL, kind TEXT NOT NULL,
      feature_id TEXT, summary TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', effort_days REAL NOT NULL DEFAULT 0,
      old_date TEXT, new_date TEXT)`,
    `CREATE INDEX releases_project ON releases (project_id, deleted_at)`,
    `CREATE INDEX release_features_release ON release_features (release_id)`,
    `CREATE INDEX release_changes_release ON release_changes (release_id, at)`,
  ],
};
