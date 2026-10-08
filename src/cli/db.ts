/**
 * Looks after the platform database (DATABASE.md §7).
 *
 *   npm run db -- status                  version, pending migrations, size, backups
 *   npm run db -- backup                  a consistent copy into .auto-qa/backups
 *   npm run db -- verify                  integrity, broken references, missing files, counters (changes nothing)
 *   npm run db -- restore <file>          replace the database with a backup (stop the server first)
 *   npm run db -- export <folder> [--with-files]   a portable bundle: one NDJSON file per table (+ the data folders)
 *   npm run db -- import <folder>         load a bundle into an empty database
 *
 * The server applies pending migrations itself when it starts; `status`, `backup`, `verify` and `export` never do.
 */
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalArtifactStore } from '../db/artifacts.js';
import { BundleError, exportBundle, importBundle } from '../db/bundle.js';
import { fileProblems } from '../db/files-check.js';
import { MigrationError, migrate, status } from '../db/migrate.js';
import { MIGRATIONS } from '../db/migrations/index.js';
import { RestoreError, restoreDatabase } from '../db/restore.js';
import { SqliteDriver } from '../db/sqlite-driver.js';
import { Store } from '../db/store.js';

process.emitWarning = (() => {}) as typeof process.emitWarning; // node:sqlite's "experimental" notice is noise here

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.AUTO_QA_DATA ?? path.join(root, '.auto-qa'));
const workspacesDir = path.resolve(process.env.AUTO_QA_WORKSPACES ?? path.join(root, 'workspaces'));
const file = path.join(dataDir, 'auto-qa.db');
const backups = path.join(dataDir, 'backups');
const [command = 'status', arg] = process.argv.slice(2);
const flags = new Set(process.argv.slice(3).filter((a) => a.startsWith('--')));
const artifacts = new LocalArtifactStore({ local: dataDir, workspace: workspacesDir });

const USAGE = 'Usage: npm run db -- status | backup | verify | restore <file> | export <folder> [--with-files] | import <folder>';

try {
  if (command === 'restore') {
    if (!arg) throw new RestoreError(USAGE);
    const r = await restoreDatabase(file, path.resolve(arg), MIGRATIONS, backups);
    console.log(`Restored ${path.resolve(arg)} (version ${r.version}). ${r.previous ? `The database it replaced is kept at ${r.previous}.` : ''}`);
    console.log('Start Auto QA to apply any newer migrations.');
  } else if (command === 'import') {
    if (!arg) throw new BundleError(USAGE);
    const db = await SqliteDriver.open(file);
    try {
      await migrate(db, MIGRATIONS, { backupDir: backups });
      const loaded = await importBundle(db, MIGRATIONS, path.resolve(arg));
      for (const [table, n] of Object.entries(loaded)) if (n) console.log(`  ${table.padEnd(22)} ${n}`);
      const found = await new Store(db, db, artifacts).problems();
      console.log(found.length ? found.map((f) => `✖ ${f}`).join('\n') : '✔ Imported, and the database is healthy.');
      if (found.length) process.exitCode = 1;
    } finally {
      await db.close();
    }
    const files = path.join(path.resolve(arg), 'files');
    if (existsSync(files)) console.log(`The bundle also holds the data folders: copy ${files} into ${dataDir} (the files the rows point to).`);
  } else if (!existsSync(file)) {
    console.log(`No database yet at ${file}. It is created when the server first starts.`);
  } else {
    const db = await SqliteDriver.open(file);
    try {
      if (command === 'status') {
        const s = await status(db, MIGRATIONS);
        console.log(`Database  ${file} (${(statSync(file).size / 1024).toFixed(0)} KB)`);
        console.log(
          `Version   ${s.current} of ${s.latest}${s.pending.length ? `, ${s.pending.length} pending: ${s.pending.map((p) => p.name).join(', ')} (applied when the server starts)` : ', up to date'}`,
        );
        for (const a of s.applied) console.log(`  ${String(a.version).padStart(4, '0')}  ${a.name.padEnd(20)} ${a.appliedAt}`);
        const kept = existsSync(backups) ? readdirSync(backups).filter((f) => f.endsWith('.db')) : [];
        console.log(`Backups   ${kept.length} in ${backups}`);
      } else if (command === 'backup') {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
        const target = path.join(backups, `auto-qa-${stamp}-manual.db`);
        await db.backup(target);
        console.log(`Backed up to ${target}`);
      } else if (command === 'verify') {
        const store = new Store(db, db, artifacts);
        const found = [...(await store.problems()), ...(await fileProblems(store, artifacts, dataDir))];
        if (found.length) {
          for (const f of found) console.log(`✖ ${f}`);
          process.exitCode = 1;
        } else console.log('✔ The database is healthy, and every file it names is there.');
      } else if (command === 'export') {
        if (!arg) throw new BundleError(USAGE);
        const target = path.resolve(arg);
        const manifest = await exportBundle(db, MIGRATIONS, target);
        for (const [table, t] of Object.entries(manifest.tables)) if (t.rows) console.log(`  ${table.padEnd(22)} ${t.rows}`);
        if (flags.has('--with-files')) {
          for (const sub of ['projects'])
            if (existsSync(path.join(dataDir, sub))) cpSync(path.join(dataDir, sub), path.join(target, 'files', sub), { recursive: true });
          console.log(`Copied the data folders to ${path.join(target, 'files')}`);
        }
        console.log(`Exported schema ${manifest.schemaVersion} to ${target}`);
      } else {
        console.log(USAGE);
        process.exitCode = 2;
      }
    } finally {
      await db.close();
    }
  }
} catch (e) {
  if (e instanceof RestoreError || e instanceof BundleError || e instanceof MigrationError) {
    console.error(e.message);
    process.exitCode = 1;
  } else throw e;
}
