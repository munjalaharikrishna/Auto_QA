import type { Migration } from '../migrate.js';

/**
 * E0.19 step 7, the holding area for flaky cases: a case that passes only on a second try is held by a person, who owns it until a set
 * day. A held case still runs and its result is still shown; it is counted apart from the questions of a run, and when its day passes
 * it comes back by itself and says it is overdue. A hold is its own row with who, why and until when; releasing it keeps the row.
 */
export const heldCases: Migration = {
  version: 10,
  name: 'held_cases',
  statements: (d) => [
    `CREATE TABLE held_cases (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), ext_id TEXT NOT NULL,
      owner TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', until_at ${d.ts} NOT NULL,
      status TEXT NOT NULL, held_by TEXT NOT NULL, held_at ${d.ts} NOT NULL,
      released_by TEXT, released_at ${d.ts}, release_note TEXT NOT NULL DEFAULT '')`,
    `CREATE UNIQUE INDEX held_cases_current ON held_cases (project_id, ext_id) WHERE status = 'held'`,
  ],
};
