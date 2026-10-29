import type { Migration } from '../migrate.js';

/**
 * What the engine has learned from people (GV-01): the single place where a tester's answer is kept so it is not asked again, and
 * the only source the runs read it from. It replaces the project rules of migration 0005 as the thing a run reads; that table is kept,
 * unread, until a later release drops it (expand, then contract: D26).
 *
 * An entry is a label ("Employee ID" means the field "Code"), a reading (a sentence that is read as another sentence), an approval
 * (a person accepted an assumption the platform made), a pick (the element chosen on the screen) or a decision (PASS or FAIL for an
 * expectation). Only an `active` entry changes a run. An entry that failed its checks is `quarantined`, one that passed the format
 * checks but could not be shown true is `pending` until a person accepts it, and one switched off is `disabled`. Nothing is
 * deleted: every change is a row in the history, with who and why.
 */
export const learnedEntries: Migration = {
  version: 8,
  name: 'learned_entries',
  statements: (d) => [
    `CREATE TABLE learned_entries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, status TEXT NOT NULL,
      entry_key TEXT NOT NULL, payload ${d.json} NOT NULL, source TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'system',
      legacy_rule_id TEXT, validation ${d.json} NOT NULL DEFAULT '{}', validated_at ${d.ts},
      created_at ${d.ts} NOT NULL, updated_at ${d.ts} NOT NULL, UNIQUE (project_id, kind, entry_key))`,
    `CREATE INDEX learned_entries_project ON learned_entries (project_id, kind, status)`,
    `CREATE TABLE learned_entry_history (
      id ${d.autoId}, entry_id TEXT NOT NULL REFERENCES learned_entries(id), at ${d.ts} NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, status_before TEXT, status_after TEXT, detail ${d.json} NOT NULL DEFAULT '{}')`,
    `CREATE INDEX learned_entry_history_entry ON learned_entry_history (entry_id, id)`,
  ],
};
