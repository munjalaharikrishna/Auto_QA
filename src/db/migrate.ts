import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DIALECTS, type Dialect, type Driver, type Queryable } from './driver.js';

/**
 * Versioned, checksummed, forward-only migrations (D26, DATABASE.md §6).
 * - each migration runs in one transaction: it applies fully or not at all
 * - an existing database is backed up before anything is applied
 * - a database newer than this code, or a changed released migration, stops the app
 */

export interface Migration {
  version: number;
  name: string;
  /** The SQL, one statement per entry, rendered for the dialect. */
  statements(dialect: Dialect): string[];
  /** Data work that SQL alone cannot do. Must be safe to run once, inside the transaction. */
  after?(tx: Queryable): Promise<void>;
}

export interface MigrationStatus {
  current: number;
  latest: number;
  applied: Array<{ version: number; name: string; appliedAt: string }>;
  pending: Array<{ version: number; name: string }>;
}

export class MigrationError extends Error {}

const KEEP_BACKUPS = 5;

/** Covers the migration as written for every dialect, so editing either changes it. */
export function checksum(m: Migration): string {
  const rendered = [m.version, m.name, m.statements(DIALECTS.sqlite), m.statements(DIALECTS.postgres)];
  return createHash('sha256').update(JSON.stringify(rendered)).digest('hex').slice(0, 16);
}

const TABLE_EXISTS = {
  sqlite: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
  postgres: `SELECT tablename AS name FROM pg_tables WHERE tablename = 'schema_migrations'`,
};

export async function migrate(db: Driver, migrations: Migration[], options: { appVersion?: string; backupDir?: string } = {}): Promise<number[]> {
  assertOrdered(migrations);
  const dialect = DIALECTS[db.dialect];
  if (!(await db.get(TABLE_EXISTS[db.dialect]))) {
    await db.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
        applied_at ${dialect.ts} NOT NULL, app_version TEXT, duration_ms INTEGER)`,
    );
  }

  const applied = await db.all<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  const known = new Map(migrations.map((m) => [m.version, m]));
  for (const a of applied) {
    const m = known.get(Number(a.version));
    if (!m) {
      throw new MigrationError(
        `This database was created by a newer Auto QA (it has migration ${a.version} "${a.name}"). Update Auto QA, or restore an older backup. Nothing was changed.`,
      );
    }
    if (checksum(m) !== a.checksum) {
      throw new MigrationError(`Migration ${a.version} "${a.name}" was changed after it was applied. Released migrations must never be edited: add a new one.`);
    }
  }

  const done = new Set(applied.map((a) => Number(a.version)));
  const pending = migrations.filter((m) => !done.has(m.version));
  if (!pending.length) return [];

  // An install that already holds data is copied first, so a bad upgrade can always be undone (FR-DB-03).
  const holdsData = applied.length > 0 || (await hasTables(db));
  if (holdsData && db.file) await backupBefore(db, options.backupDir ?? path.join(path.dirname(db.file), 'backups'), applied.length ? Math.max(...done) : 0);

  for (const m of pending) {
    const started = Date.now();
    await db.transaction(async (tx) => {
      for (const sql of m.statements(dialect)) await tx.exec(sql);
      await m.after?.(tx);
      await tx.run('INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version, duration_ms) VALUES (?, ?, ?, ?, ?, ?)', [
        m.version,
        m.name,
        checksum(m),
        new Date().toISOString(),
        options.appVersion ?? null,
        Date.now() - started,
      ]);
    });
  }
  return pending.map((m) => m.version);
}

export async function status(db: Queryable, migrations: Migration[]): Promise<MigrationStatus> {
  const exists = await db.get(TABLE_EXISTS[db.dialect]);
  const rows = exists
    ? await db.all<{ version: number; name: string; applied_at: string }>('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    : [];
  const done = new Set(rows.map((r) => Number(r.version)));
  return {
    current: rows.length ? Number(rows[rows.length - 1].version) : 0,
    latest: migrations[migrations.length - 1]?.version ?? 0,
    applied: rows.map((r) => ({ version: Number(r.version), name: r.name, appliedAt: r.applied_at })),
    pending: migrations.filter((m) => !done.has(m.version)).map((m) => ({ version: m.version, name: m.name })),
  };
}

function assertOrdered(migrations: Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`Migrations must be numbered 1, 2, 3… without gaps; found ${m.version} at position ${i + 1}.`);
  });
}

async function hasTables(db: Driver): Promise<boolean> {
  const sql =
    db.dialect === 'sqlite'
      ? `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`
      : `SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`;
  return Number((await db.get<{ n: number }>(sql))?.n ?? 0) > 0;
}

async function backupBefore(db: Driver, dir: string, fromVersion: number): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const file = path.join(dir, `auto-qa-${stamp}-v${fromVersion}.db`);
  await db.backup(file);
  pruneBackups(dir);
  return file;
}

/** Keeps the newest few. Names sort by time, so the oldest sort first. */
export function pruneBackups(dir: string, keep = KEEP_BACKUPS): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((f) => /^auto-qa-.*\.db$/.test(f))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(path.join(dir, f), { force: true });
}
