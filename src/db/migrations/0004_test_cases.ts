import type { Migration } from '../migrate.js';

/**
 * Test cases as records of their own (DATABASE.md §5.4): every case a tester writes or imports is kept with
 * its versions, so it can be seen afterwards, edited and run again. Results stay in `verdicts` (one row per
 * job and test); the last one is mirrored on the case for the list.
 */
export const testCases: Migration = {
  version: 4,
  name: 'test_cases',
  statements: (d) => [
    `CREATE TABLE test_cases (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), ext_id TEXT NOT NULL, title TEXT NOT NULL,
      raw ${d.json} NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT, source_row INTEGER,
      current_version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL DEFAULT 1,
      created_at ${d.ts} NOT NULL, updated_at ${d.ts} NOT NULL, deleted_at ${d.ts},
      last_status TEXT, last_job_id TEXT, last_execution_id TEXT, last_run_at ${d.ts}, run_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (project_id, ext_id))`,
    `CREATE TABLE test_case_versions (
      test_case_id TEXT NOT NULL REFERENCES test_cases(id), version INTEGER NOT NULL, raw ${d.json} NOT NULL,
      content_hash TEXT NOT NULL, reason TEXT NOT NULL, created_at ${d.ts} NOT NULL, PRIMARY KEY (test_case_id, version))`,
    `CREATE INDEX test_cases_project ON test_cases (project_id, deleted_at, updated_at)`,
    `CREATE INDEX verdicts_test ON verdicts (test_id)`,
  ],
};
