import type { Queryable } from './driver.js';

/** `db verify` (DATABASE.md §7.6): a corrupt file or a row pointing at a missing parent. Empty means healthy. */
export async function problems(db: Queryable): Promise<string[]> {
  const found: string[] = [];
  for (const r of await db.all<Record<string, unknown>>('PRAGMA integrity_check')) {
    const message = String(Object.values(r)[0]);
    if (message !== 'ok') found.push(`integrity: ${message}`);
  }
  for (const r of await db.all<Record<string, unknown>>('PRAGMA foreign_key_check')) {
    found.push(`${r.table} row ${r.rowid} points to a missing ${r.parent}`);
  }
  return found;
}
