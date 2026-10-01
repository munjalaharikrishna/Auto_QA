/**
 * Looks after the platform database (DATABASE.md §7).
 *
 *   npm run db -- status     version, pending migrations, size, backups
 *   npm run db -- backup     a consistent copy into .auto-qa/backups
 *   npm run db -- verify     integrity and broken references (changes nothing)
 *
 * The server applies pending migrations itself when it starts; these commands never do.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { status } from '../db/migrate.js';
import { MIGRATIONS } from '../db/migrations/index.js';
import { SqliteDriver } from '../db/sqlite-driver.js';
import { problems } from '../db/verify.js';

process.emitWarning = (() => {}) as typeof process.emitWarning; // node:sqlite's "experimental" notice is noise here

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.AUTO_QA_DATA ?? path.join(root, '.auto-qa'));
const file = path.join(dataDir, 'auto-qa.db');
const backups = path.join(dataDir, 'backups');
const command = process.argv[2] ?? 'status';

if (!existsSync(file)) {
  console.log(`No database yet at ${file}. It is created when the server first starts.`);
  process.exit(0);
}

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
    const found = await problems(db);
    if (found.length) {
      for (const f of found) console.log(`✖ ${f}`);
      process.exitCode = 1;
    } else console.log('✔ The database is healthy.');
  } else {
    console.log('Usage: npm run db -- status | backup | verify');
    process.exitCode = 2;
  }
} finally {
  await db.close();
}
