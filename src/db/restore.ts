import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { type Migration, pruneBackups } from './migrate.js';
import { SqliteDriver } from './sqlite-driver.js';
import { problems } from './verify.js';

/**
 * `db restore <file>` (DATABASE.md §7.7): puts a backup in place of the current database. It refuses a file that is
 * damaged, is not an Auto QA database, or was made by a newer version, and it keeps a copy of what it replaces.
 */

export class RestoreError extends Error {}

export interface Restored {
  /** The version the restored database was at (0 for one older than migrations). */
  version: number;
  /** A copy of the database that was replaced, if there was one. */
  previous?: string;
}

export async function restoreDatabase(target: string, source: string, migrations: Migration[], backupDir: string): Promise<Restored> {
  if (!existsSync(source)) throw new RestoreError(`There is no file ${source}.`);
  // Work on a copy, so looking at the source never changes it (opening a SQLite file can create -wal files next to it).
  mkdirSync(backupDir, { recursive: true });
  const inspect = path.join(backupDir, `.restore-check-${process.pid}.db`);
  copyFileSync(source, inspect);
  let version = 0;
  const staged = path.join(path.dirname(target), `.restore-${process.pid}.db`);
  try {
    const db = await SqliteDriver.open(inspect).catch(() => {
      throw new RestoreError(`${source} is not a database.`);
    });
    try {
      let tables: Array<{ name: string }>;
      try {
        tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
      } catch {
        throw new RestoreError(`${source} is not a database.`);
      }
      const names = new Set(tables.map((t) => t.name));
      if (!names.has('projects')) throw new RestoreError(`${source} is not an Auto QA database: it has no projects table.`);
      if (names.has('schema_migrations')) {
        const known = new Set(migrations.map((m) => m.version));
        const rows = await db.all<{ version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version');
        for (const r of rows) {
          if (!known.has(Number(r.version))) {
            throw new RestoreError(
              `${source} was made by a newer Auto QA (it has migration ${r.version} "${r.name}"). Update Auto QA, or choose an older backup. Nothing was changed.`,
            );
          }
        }
        version = rows.length ? Number(rows[rows.length - 1].version) : 0;
      }
      const found = await problems(db);
      if (found.length) throw new RestoreError(`${source} is damaged (${found[0]}). Nothing was changed.`);
      await db.backup(staged); // one clean file, whatever journal mode the source was in
    } finally {
      await db.close();
    }

    let previous: string | undefined;
    if (existsSync(target)) {
      const current = await SqliteDriver.open(target);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
      previous = path.join(backupDir, `auto-qa-${stamp}-before-restore.db`);
      try {
        await current.backup(previous);
      } finally {
        await current.close();
      }
      pruneBackups(backupDir);
    }
    try {
      for (const f of [target, `${target}-wal`, `${target}-shm`]) rmSync(f, { force: true });
      renameSync(staged, target);
    } catch (e) {
      throw new RestoreError(`The database could not be replaced (${(e as Error).message}). Stop Auto QA first; its own copy is in ${previous ?? 'place'}.`);
    }
    return { version, previous };
  } finally {
    for (const f of [inspect, `${inspect}-wal`, `${inspect}-shm`, staged, `${staged}-wal`, `${staged}-shm`]) rmSync(f, { force: true });
  }
}
