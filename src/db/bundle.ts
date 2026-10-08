import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Driver, Queryable } from './driver.js';
import { type Migration, status } from './migrate.js';

/**
 * The portable bundle (DATABASE.md §7.7, §8.3): one NDJSON file per table plus a manifest with the schema version and a
 * hash of every file. It is how a laptop's data moves to another database, and it holds only what the tables hold, so
 * it never contains a secret that the tables do not (FR-DB-17).
 */

/** Parents before the tables that point at them: the order rows are loaded in. A test fails if a table is missing here. */
export const TABLE_ORDER = [
  'users',
  'projects',
  'environments',
  'page_routes',
  'settings',
  'counters',
  'audit_log',
  'uploads',
  'jobs',
  'job_logs',
  'questions',
  'test_cases',
  'test_case_versions',
  'project_rules',
  'executions',
  'test_results',
  'step_results',
  'check_results',
  'evidence',
  'explorations',
  'exploration_items',
  'generation_snapshots',
] as const;

/** Tables that are not data: the migration log, and the old copy of `verdicts` kept for one release. */
export const NOT_EXPORTED = ['schema_migrations', 'verdicts_legacy'];

const PAGE = 1000;
const FORMAT = 1;

export interface Manifest {
  format: number;
  createdAt: string;
  /** The newest migration the data was written under. A bundle is only loaded by a version that has it. */
  schemaVersion: number;
  tables: Record<string, { rows: number; sha256: string }>;
}

const fileOf = (dir: string, table: string) => path.join(dir, `${table}.ndjson`);

export async function exportBundle(db: Queryable, migrations: Migration[], dir: string): Promise<Manifest> {
  mkdirSync(dir, { recursive: true });
  const tables: Manifest['tables'] = {};
  for (const table of TABLE_ORDER) {
    const hash = createHash('sha256');
    let rows = 0;
    const lines: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${await orderBy(db, table)} LIMIT ? OFFSET ?`, [PAGE, offset]);
      if (!page.length) break;
      for (const r of page) {
        for (const v of Object.values(r))
          if (v instanceof Uint8Array) throw new Error(`${table} holds binary data, which the bundle format does not carry yet.`);
        lines.push(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
        rows++;
      }
    }
    const text = lines.length ? `${lines.join('\n')}\n` : '';
    hash.update(text);
    writeFileSync(fileOf(dir, table), text);
    tables[table] = { rows, sha256: hash.digest('hex') };
  }
  const manifest: Manifest = { format: FORMAT, createdAt: new Date().toISOString(), schemaVersion: (await status(db, migrations)).current, tables };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** A stable order for paging: the primary key columns, which every table has. SQLite's catalogue; the PostgreSQL driver will need its own. */
async function orderBy(db: Queryable, table: string): Promise<string> {
  const cols = await db.all<{ name: string; pk: number }>(`SELECT name, pk FROM pragma_table_info('${table}')`);
  const keys = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  return (keys.length ? keys : cols.slice(0, 1)).map((c) => c.name).join(', ');
}

export class BundleError extends Error {}

/** Reads and checks a bundle without loading anything: the version and every file's hash. */
export function readBundle(dir: string, migrations: Migration[]): Manifest {
  const manifestFile = path.join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) throw new BundleError(`${dir} is not a bundle: it has no manifest.json.`);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest;
  if (manifest.format !== FORMAT) throw new BundleError(`This bundle has format ${manifest.format}; this Auto QA reads format ${FORMAT}.`);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (manifest.schemaVersion > latest) {
    throw new BundleError(
      `This bundle was made by a newer Auto QA (schema ${manifest.schemaVersion}, this one has ${latest}). Update Auto QA first. Nothing was loaded.`,
    );
  }
  for (const table of TABLE_ORDER) {
    const entry = manifest.tables[table];
    if (!entry) continue; // an older bundle that predates this table
    const file = fileOf(dir, table);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (text === undefined || createHash('sha256').update(text).digest('hex') !== entry.sha256) {
      throw new BundleError(`${path.basename(file)} is missing or was changed since the bundle was made. Nothing was loaded.`);
    }
  }
  return manifest;
}

/**
 * Loads a bundle into a database that is migrated and holds no projects, in one transaction: all of it or none.
 * Ids, `EXEC-…` numbers and history stay as they were, so links and sheets that mention them stay valid.
 */
export async function importBundle(db: Driver, migrations: Migration[], dir: string): Promise<Record<string, number>> {
  const manifest = readBundle(dir, migrations);
  const s = await status(db, migrations);
  if (s.pending.length) throw new BundleError('The database has migrations that are not applied yet. Start Auto QA once, or migrate it, then import.');
  const used = await db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM jobs) AS n');
  if (Number(used?.n) > 0) throw new BundleError('This database already has projects. A bundle is loaded into an empty database, so nothing is overwritten.');

  const loaded: Record<string, number> = {};
  await db.transaction(async (tx) => {
    for (const table of TABLE_ORDER) {
      if (!manifest.tables[table]) continue;
      const file = fileOf(dir, table);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      let count = 0;
      for (const line of text.split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line) as Record<string, unknown>;
        const columns = Object.keys(row);
        const values = columns.map((c) => {
          const v = row[c];
          return (v !== null && typeof v === 'object' ? JSON.stringify(v) : v) as string | number | null;
        });
        // A fresh database already has the Owner; the bundle's copy of that row replaces nothing and adds nothing.
        const conflict = table === 'users' ? ' ON CONFLICT DO NOTHING' : '';
        await tx.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})${conflict}`, values);
        count++;
      }
      loaded[table] = count;
    }
  });
  return loaded;
}
