/**
 * Moves the project rules of migration 0005 into learned entries (GV-01, migration 0008), and undoes it.
 *
 *   npm run rules -- inventory             every rule, with what the checks say of it (changes nothing)
 *   npm run rules -- migrate               what the migration would do (a dry run: changes nothing)
 *   npm run rules -- migrate --apply       writes the entries. A backup is taken first. Safe to run again.
 *   npm run rules -- rollback              switches off the entries the migration made and nobody has changed since
 *   npm run rules -- activate <id> <why>   switches on a pending entry, after a person has looked at it
 *
 * The project rules are never changed. A run reads only active entries, so nothing the rules said has any effect until it is migrated
 * and found sound; the rules that fail their checks (a rewrite that judges nothing, one that turns a sentence into "not shown") are
 * quarantined with the reason.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalArtifactStore } from '../db/artifacts.js';
import { SqliteDriver } from '../db/sqlite-driver.js';
import { Store } from '../db/store.js';
import { LearningService } from '../learning/service.js';

process.emitWarning = (() => {}) as typeof process.emitWarning; // node:sqlite's "experimental" notice is noise here

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.AUTO_QA_DATA ?? path.join(root, '.auto-qa'));
const workspacesDir = path.resolve(process.env.AUTO_QA_WORKSPACES ?? path.join(root, 'workspaces'));
const file = path.join(dataDir, 'auto-qa.db');
const [command = 'inventory', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));

const USAGE = 'Usage: npm run rules -- inventory | migrate [--apply] | rollback | activate <entry id> <reason>';

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

const store = await Store.open(file, { artifacts: new LocalArtifactStore({ local: dataDir, workspace: workspacesDir }) });
const service = new LearningService(store, { exploreDir: path.join(dataDir, 'explore') });
try {
  if (command === 'inventory' || (command === 'migrate' && !flags.has('--apply'))) {
    const { summary } = await service.planMigration();
    console.log(`${summary.total} rule(s): ${JSON.stringify(summary.byStatus)}`);
    console.log(`by kind: ${JSON.stringify(summary.byKind)}`);
    for (const n of summary.notActive)
      console.log(`  ${n.status.toUpperCase().padEnd(11)} ${n.kind.padEnd(8)} ${n.projectId}: ${n.key.slice(0, 80)}\n      ${n.reason}`);
    if (command === 'migrate') console.log('\nThis was a dry run. Add --apply to write the entries (a backup is taken first).');
  } else if (command === 'migrate') {
    const backup = path.join(dataDir, 'backups', `pre-rule-migration-${stamp()}.db`);
    const live = await SqliteDriver.open(file);
    await live.backup(backup);
    await live.close();
    console.log(`Backup: ${backup}`);
    const r = await service.applyMigration();
    console.log(`Wrote ${r.written} entr${r.written === 1 ? 'y' : 'ies'}, left ${r.skipped} that existed. ${JSON.stringify(r.summary.byStatus)}`);
    console.log('Pending entries wait for a person: `npm run rules -- activate <id> <reason>`.');
  } else if (command === 'rollback') {
    const r = await service.rollbackMigration();
    console.log(`Switched off ${r.disabled} entr${r.disabled === 1 ? 'y' : 'ies'}; kept ${r.kept} that a person had changed or that were off already.`);
  } else if (command === 'activate') {
    const [id, ...why] = args;
    if (!id || why.length === 0) throw new Error(USAGE);
    const entry =
      (await findEntry(id)) ??
      (() => {
        throw new Error(`No entry ${id}.`);
      })();
    const done = await service.activate(entry.projectId, id, 'cli', why.join(' '));
    console.log(`${done.id} is ${done.status}.`);
  } else {
    throw new Error(USAGE);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await store.close();
}

async function findEntry(id: string) {
  for (const p of await store.projects()) {
    const e = await store.learnedEntry(p.id, id);
    if (e) return e;
  }
  return undefined;
}
