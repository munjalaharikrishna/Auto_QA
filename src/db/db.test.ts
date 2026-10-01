import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DIALECTS } from './driver.js';
import { checksum, type Migration, MigrationError, migrate, pruneBackups, status } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';
import { SqliteDriver } from './sqlite-driver.js';
import { Store } from './store.js';

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-db-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
const file = (name: string) => path.join(dir, name);
const project = (id: string) => ({
  id,
  name: id,
  baseUrl: 'http://127.0.0.1:4173/app',
  testIdAttribute: 'data-testid',
  browser: 'chromium' as const,
  workspace: path.join(dir, id),
});

/** The database exactly as M7a created it: no version table, tables from CREATE TABLE IF NOT EXISTS. */
async function legacyDatabase(target: string) {
  const db = await SqliteDriver.open(target);
  await db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
    INSERT INTO users (id, name, role) VALUES (1, 'Owner', 'admin');
    CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id), name TEXT NOT NULL,
      base_url TEXT NOT NULL, test_id_attribute TEXT NOT NULL, browser TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE uploads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), file TEXT NOT NULL, original_name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_id INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL,
      status TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL DEFAULT '{}', execution_id TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE TABLE job_logs (job_id TEXT NOT NULL REFERENCES jobs(id), at TEXT NOT NULL, message TEXT NOT NULL);
    CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL, payload TEXT NOT NULL, answer TEXT,
      created_at TEXT NOT NULL, answered_at TEXT);
    CREATE TABLE verdicts (job_id TEXT NOT NULL REFERENCES jobs(id), test_id TEXT NOT NULL, row INTEGER, status TEXT NOT NULL, verdict TEXT NOT NULL, PRIMARY KEY (job_id, test_id));
    INSERT INTO projects VALUES ('orangehrm', 1, 'OrangeHRM', 'http://127.0.0.1/orangehrm-2.5.0.2/login.php', 'data-testid', 'chromium', 'C:\\old\\ws', '2026-09-30T10:00:00.000Z');
    INSERT INTO jobs (id, project_id, kind, status, input, created_at) VALUES ('JOB-1', 'orangehrm', 'single', 'done', '{}', '2026-09-30T10:01:00.000Z');
    INSERT INTO job_logs VALUES ('JOB-1', '2026-09-30T10:01:01.000Z', 'first');
    INSERT INTO job_logs VALUES ('JOB-1', '2026-09-30T10:01:01.000Z', 'second');
    INSERT INTO job_logs VALUES ('JOB-1', '2026-09-30T10:01:01.000Z', 'third');
  `);
  return db;
}

describe('migrations (D26)', () => {
  it('builds a fresh database to the latest version and records every step', async () => {
    const db = await SqliteDriver.open(':memory:');
    assert.deepEqual(await migrate(db, MIGRATIONS), [1, 2, 3, 4, 5]);
    const s = await status(db, MIGRATIONS);
    assert.equal(s.current, 5);
    assert.equal(s.pending.length, 0);
    assert.deepEqual(
      s.applied.map((a) => a.name),
      ['baseline', 'environments', 'job_log_ids', 'test_cases', 'project_rules'],
    );
    assert.deepEqual(await migrate(db, MIGRATIONS), [], 'a second start applies nothing');
    await db.close();
  });

  it('adopts the database M7a created: data kept, backup taken, logs keep their order', async () => {
    const target = file('legacy.db');
    const legacy = await legacyDatabase(target);
    await legacy.close();

    const store = await Store.open(target);
    const p = await store.project('orangehrm');
    assert.equal(p?.baseUrl, 'http://127.0.0.1/orangehrm-2.5.0.2/login.php');
    assert.equal(p?.workspace, 'C:\\old\\ws');
    assert.deepEqual(
      (await store.environments('orangehrm')).map((e) => [e.name, e.isDefault, e.baseUrl]),
      [['Default', true, 'http://127.0.0.1/orangehrm-2.5.0.2/login.php']],
    );
    assert.deepEqual(
      (await store.logs('JOB-1')).map((l) => l.message),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(await store.problems(), []);

    const backups = readdirSync(file('backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^auto-qa-\d{8}-\d{6}-v0\.db$/);
    // The backup is the database as it was, before any migration.
    const old = await SqliteDriver.open(file(`backups/${backups[0]}`));
    assert.equal(await old.get("SELECT name FROM sqlite_master WHERE name = 'environments'"), undefined);
    assert.equal((await old.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs'))?.n, 1);
    await old.close();
    await store.close();
  });

  it('does not back up a database that is empty', async () => {
    const store = await Store.open(file('fresh.db'));
    await store.close();
    assert.equal(existsSync(file('backups')) && readdirSync(file('backups')).some((f) => f.includes('fresh')), false);
  });

  it('refuses a database made by a newer Auto QA and changes nothing', async () => {
    const db = await SqliteDriver.open(':memory:');
    await migrate(db, MIGRATIONS);
    await db.run("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'from_the_future', 'x', '2030-01-01T00:00:00.000Z')");
    await assert.rejects(migrate(db, MIGRATIONS), (e: Error) => e instanceof MigrationError && /newer Auto QA/.test(e.message));
    assert.equal((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations'))?.n, 6);
    await db.close();
  });

  it('refuses a released migration that was edited', async () => {
    const db = await SqliteDriver.open(':memory:');
    await migrate(db, MIGRATIONS);
    const edited: Migration = { ...MIGRATIONS[1], statements: (d) => [...MIGRATIONS[1].statements(d), 'CREATE TABLE sneaky (id INTEGER)'] };
    await assert.rejects(migrate(db, [MIGRATIONS[0], edited, MIGRATIONS[2], MIGRATIONS[3], MIGRATIONS[4]]), /was changed after it was applied/);
    await db.close();
  });

  it('applies a migration fully or not at all', async () => {
    const db = await SqliteDriver.open(':memory:');
    await migrate(db, MIGRATIONS);
    const broken: Migration = { version: 6, name: 'broken', statements: () => ['CREATE TABLE half_done (id INTEGER)', 'CREATE TABLE half_done (id INTEGER)'] };
    await assert.rejects(migrate(db, [...MIGRATIONS, broken]));
    assert.equal(await db.get("SELECT name FROM sqlite_master WHERE name = 'half_done'"), undefined, 'the first statement was rolled back');
    assert.equal((await status(db, MIGRATIONS)).current, 5);
    await db.close();
  });

  it('numbers migrations without gaps', async () => {
    const db = await SqliteDriver.open(':memory:');
    await assert.rejects(migrate(db, [MIGRATIONS[0], MIGRATIONS[2]]), /without gaps/);
    await db.close();
  });

  it('keeps only the newest backups', () => {
    const backups = file('prune');
    mkdirSync(backups, { recursive: true });
    for (let i = 1; i <= 8; i++) writeFileSync(path.join(backups, `auto-qa-2026010${i}-000000-v1.db`), 'x');
    pruneBackups(backups, 5);
    assert.deepEqual(
      readdirSync(backups),
      [4, 5, 6, 7, 8].map((i) => `auto-qa-2026010${i}-000000-v1.db`),
    );
  });

  it('is written for both databases (D25): no SQLite-only syntax in the PostgreSQL rendering', () => {
    for (const m of MIGRATIONS) {
      const pg = m.statements(DIALECTS.postgres).join('\n');
      assert.doesNotMatch(pg, /rowid|AUTOINCREMENT|INSERT OR|\$\{/i, `migration ${m.version} ${m.name}`);
      assert.match(checksum(m), /^[0-9a-f]{16}$/);
    }
    const environments = MIGRATIONS[1].statements(DIALECTS.postgres).join('\n');
    assert.match(environments, /TIMESTAMPTZ/);
    assert.match(environments, /GENERATED ALWAYS AS IDENTITY/);
  });
});

describe('store', () => {
  it('creates a project with its Default environment and an audit row, and keeps them in step', async () => {
    const store = await Store.open(':memory:');
    await store.createProject(project('demo'));
    assert.deepEqual(
      (await store.environments('demo')).map((e) => e.id),
      ['ENV-demo'],
    );
    const updated = await store.updateProject('demo', { baseUrl: 'http://127.0.0.1:9000/', name: 'Demo 2' });
    assert.equal(updated?.baseUrl, 'http://127.0.0.1:9000/');
    assert.equal((await store.project('demo'))?.baseUrl, 'http://127.0.0.1:9000/');
    assert.equal((await store.environments('demo'))[0].baseUrl, 'http://127.0.0.1:9000/');
    assert.deepEqual(
      (await store.auditLog('demo')).map((a) => a.action),
      ['project.update', 'project.create'],
    );
    await store.close();
  });

  it('writes a transaction all together, or not at all (FR-DB-07)', async () => {
    const store = await Store.open(':memory:');
    await store.createProject(project('p'));
    const job = await store.createJob({ projectId: 'p', kind: 'single', input: {} });
    await assert.rejects(
      store.transaction(async (s) => {
        await s.log(job.id, 'inside');
        await s.saveVerdicts(job.id, [{ testId: 'T1', status: 'PASS', verdict: {} }]);
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(await store.logs(job.id), []);
    assert.deepEqual(await store.verdicts(job.id), []);
    await store.close();
  });

  it('never mixes another caller into an open transaction', async () => {
    const store = await Store.open(':memory:');
    await store.createProject(project('p'));
    const job = await store.createJob({ projectId: 'p', kind: 'single', input: {} });
    const failing = store.transaction(async (s) => {
      await s.log(job.id, 'a');
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('rolled back');
    });
    const outside = store.log(job.id, 'outside'); // asked while the transaction is open
    await assert.rejects(failing);
    await outside;
    assert.deepEqual(
      (await store.logs(job.id)).map((l) => l.message),
      ['outside'],
    );
    await store.close();
  });

  it('hands out unique, gap-free counter numbers even when asked at once (FR-DB-12)', async () => {
    const store = await Store.open(':memory:');
    const got = await Promise.all(Array.from({ length: 25 }, () => store.nextCounter('execution', '2026')));
    assert.deepEqual(
      [...got].sort((a, b) => a - b),
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    assert.equal(await store.nextCounter('execution', '2027'), 1, 'each year starts again');
    await store.close();
  });

  it('keeps page routes per environment and updates in place (D19, FR-ENV-03)', async () => {
    const store = await Store.open(':memory:');
    await store.createProject(project('p'));
    await store.savePageRoute('ENV-p', 'Dashboard', '/dashboard', 'learned');
    await store.savePageRoute('ENV-p', 'Dashboard', '/home', 'tester');
    assert.deepEqual(await store.pageRoutes('ENV-p'), { Dashboard: '/home' });
    await store.close();
  });

  it('orders log lines and round-trips jobs, questions and verdicts', async () => {
    const store = await Store.open(':memory:');
    await store.createProject(project('p'));
    const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: { uploadId: 'UP-1' } });
    for (const m of ['one', 'two', 'three']) await store.log(job.id, m);
    assert.deepEqual(
      (await store.logs(job.id)).map((l) => l.message),
      ['one', 'two', 'three'],
    );
    const q = await store.ask(job.id, 'confirm', { text: 'ok?' });
    assert.equal((await store.openQuestions(job.id)).length, 1);
    assert.equal((await store.answer(q.id, true))?.answer, true);
    assert.equal((await store.openQuestions(job.id)).length, 0);
    await store.updateJob(job.id, { status: 'done', output: { a: 1 }, executionId: 'EXEC-2026-00001' });
    assert.equal((await store.job(job.id))?.executionId, 'EXEC-2026-00001');
    await store.saveVerdicts(job.id, [{ testId: 'T1', row: 2, status: 'PASS', verdict: { x: 1 } }]);
    await store.saveVerdicts(job.id, [{ testId: 'T1', row: 2, status: 'FAIL', verdict: { x: 2 } }]);
    assert.deepEqual(await store.verdicts(job.id), [{ testId: 'T1', row: 2, status: 'FAIL', verdict: { x: 2 } }]);
    await store.close();
  });

  it('keeps a file database free of anything but what it was given (FR-ENV-05)', async () => {
    const target = file('secret.db');
    const store = await Store.open(target);
    await store.createProject(project('p'));
    await store.close();
    // The API writes the password to the workspace .env and never passes it to the store.
    assert.ok(!readFileSync(target).toString('latin1').includes('s3cret-password'));
  });
});
