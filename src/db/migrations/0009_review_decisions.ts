import type { Migration } from '../migrate.js';

/**
 * The PASS or FAIL a person gave a case the engine could not decide (VD-11, DEC-05). A decision is its own row, with who and when, the
 * verdict it was given on and the evidence the person was shown; it never changes the result it is about. A second decision on the
 * same case supersedes the first and the first stays, so the history of what was decided and by whom is complete. At most one
 * decision for a case is current.
 */
export const reviewDecisions: Migration = {
  version: 9,
  name: 'review_decisions',
  statements: (d) => [
    `CREATE TABLE review_decisions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), job_id TEXT NOT NULL REFERENCES jobs(id),
      test_result_id TEXT NOT NULL REFERENCES test_results(id), execution_id TEXT, ext_id TEXT NOT NULL, card_id TEXT NOT NULL,
      decision TEXT NOT NULL, engine_status TEXT NOT NULL, engine_reason TEXT NOT NULL DEFAULT '',
      reviewer TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', evidence ${d.json} NOT NULL, evidence_sha256 TEXT NOT NULL,
      status TEXT NOT NULL, supersedes TEXT, decided_at ${d.ts} NOT NULL, created_by INTEGER NOT NULL DEFAULT 1)`,
    `CREATE UNIQUE INDEX review_decisions_current ON review_decisions (test_result_id, card_id) WHERE status = 'current'`,
    `CREATE INDEX review_decisions_job ON review_decisions (job_id, ext_id)`,
  ],
};
