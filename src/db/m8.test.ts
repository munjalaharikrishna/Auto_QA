import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { describeFile, isRef, LocalArtifactStore } from './artifacts.js';
import { BundleError, exportBundle, importBundle, NOT_EXPORTED, readBundle, TABLE_ORDER } from './bundle.js';
import { fileProblems } from './files-check.js';
import { MIGRATIONS } from './migrations/index.js';
import { RestoreError, restoreDatabase } from './restore.js';
import { SqliteDriver } from './sqlite-driver.js';
import { Store } from './store.js';

// Made when the file loads: the describe blocks below build their stores from it before any hook runs.
const dir = mkdtempSync(path.join(os.tmpdir(), 'auto-qa-m8-'));
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
const at = (...p: string[]) => path.join(dir, ...p);

const project = (id: string, workspace = at('workspaces', id)) => ({
  id,
  name: id,
  baseUrl: 'http://127.0.0.1:4173/app',
  testIdAttribute: 'data-testid',
  browser: 'chromium' as const,
  workspace,
});

const verdict = (testId: string, executionId: string, over: Record<string, unknown> = {}) => ({
  executionId,
  testId,
  title: `Title of ${testId}`,
  automationId: `AUTO-${testId}`,
  status: 'PASS',
  reason: 'All checks passed',
  expected: 'Dashboard is shown',
  actual: 'Dashboard is shown',
  steps: [
    { id: 'S1', raw: 'Open the login page', result: 'passed', durationMs: 120 },
    { id: 'S2', raw: 'Click Login', result: 'passed', durationMs: 80 },
  ],
  checks: [{ id: 'A1', raw: 'Dashboard is shown', expected: 'Dashboard is shown', actual: 'Dashboard is shown', result: 'passed' }],
  durationMs: 900,
  evidence: { screenshots: [] },
  ...over,
});

/** A project with one finished run on disk and in the database, with a screenshot kept as evidence. */
async function withRun(store: Store, artifacts: LocalArtifactStore, id = 'p') {
  await store.createProject(project(id));
  await store.upsertTestCase(
    id,
    { id: 'TC-1', title: 'Login', preconditions: '', steps: 'Open the login page\nClick Login', testData: '', expected: 'Dashboard is shown' },
    { kind: 'form' },
    'created',
  );
  const job = await store.createJob({ projectId: id, kind: 'single', input: {} });
  const execId = await store.nextExecutionId();
  const shot = at('data', 'projects', id, 'runs', execId, 'evidence', 'S2.png');
  mkdirSync(path.dirname(shot), { recursive: true });
  writeFileSync(shot, 'png-bytes');
  const facts = (await describeFile(artifacts, shot))!;
  await store.saveRun(
    { id: job.id, projectId: id },
    {
      execution: { execId, startedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:00:02.000Z', durationMs: 2000 },
      rows: [{ testId: 'TC-1', status: 'PASS', verdict: verdict('TC-1', execId) }],
      evidence: { 'TC-1': [{ ...facts, kind: 'screenshot', stepId: 'S2' }] },
      snapshot: { 'tests/tc-1.spec.ts': 'a'.repeat(64) },
      recordedAt: '2026-10-01T10:00:02.000Z',
    },
  );
  return { job, execId, shot };
}

describe('storage references (D27, FR-DB-13)', () => {
  const artifacts = new LocalArtifactStore({ local: at('data'), workspace: at('workspaces') });

  it('names a file by its root, never by an absolute path, and finds it again', () => {
    const file = at('data', 'projects', 'p', 'runs', 'EXEC-2026-00001', 'evidence', 'a.png');
    const ref = artifacts.toRef(file);
    assert.equal(ref, 'local:projects/p/runs/EXEC-2026-00001/evidence/a.png');
    assert.equal(artifacts.resolve(ref as string), file);
    assert.equal(artifacts.toRef(at('workspaces', 'demo', 'tests', 'a.spec.ts')), 'workspace:demo/tests/a.spec.ts');
    assert.equal(artifacts.toRef(path.join(os.tmpdir(), 'elsewhere', 'x.png')), undefined, 'a file outside every root has no reference');
  });

  it('refuses a reference that leaves its root, and does not take a drive letter for a scheme', () => {
    assert.throws(() => artifacts.resolve('local:../../etc/passwd'), /leaves its root/);
    assert.throws(() => artifacts.resolve('s3:bucket/key'), /Unknown storage reference/);
    assert.equal(isRef('C:\\Users\\x\\file.png'), false);
    assert.equal(isRef('local:projects/p'), true);
  });

  it('keeps projects and uploads as references in the database and hands back real paths', async () => {
    const target = at('refs.db');
    const store = await Store.open(target, { artifacts });
    await store.createProject(project('refs'));
    const upload = await store.createUpload({ projectId: 'refs', file: at('data', 'projects', 'refs', 'uploads', 'sheet.xlsx'), originalName: 'sheet.xlsx' });
    assert.equal((await store.project('refs'))?.workspace, at('workspaces', 'refs'));
    assert.equal((await store.upload(upload.id))?.file, at('data', 'projects', 'refs', 'uploads', 'sheet.xlsx'));
    await store.close();
    const peek = await SqliteDriver.open(target);
    assert.equal((await peek.get<{ workspace: string }>("SELECT workspace FROM projects WHERE id = 'refs'"))?.workspace, 'workspace:refs');
    assert.equal((await peek.get<{ file: string }>('SELECT file FROM uploads'))?.file, 'local:projects/refs/uploads/sheet.xlsx');
    await peek.close();
  });

  it('converts the absolute paths an older database holds, once, and leaves paths outside every root alone', async () => {
    const target = at('adopt.db');
    const plain = await Store.open(target); // no references: stores what it is given, as before
    await plain.createProject(project('inside'));
    await plain.createProject(project('outside', path.join(os.tmpdir(), 'somewhere-else', 'outside')));
    await plain.close();

    const store = await Store.open(target, { artifacts }); // opening with references adopts them
    assert.equal(await store.adoptPaths(), 0, 'a second pass changes nothing');
    assert.equal((await store.project('inside'))?.workspace, at('workspaces', 'inside'));
    assert.equal((await store.project('outside'))?.workspace, path.join(os.tmpdir(), 'somewhere-else', 'outside'));
    await store.close();
    const peek = await SqliteDriver.open(target);
    const kept = (await peek.all<{ id: string; workspace: string }>('SELECT id, workspace FROM projects ORDER BY id')).map((r) => ({ ...r }));
    assert.deepEqual(kept, [
      { id: 'inside', workspace: 'workspace:inside' },
      { id: 'outside', workspace: path.join(os.tmpdir(), 'somewhere-else', 'outside') },
    ]);
    await peek.close();
  });
});

describe('executions and results (FR-DB-07, FR-DB-11, FR-DB-12)', () => {
  const artifacts = new LocalArtifactStore({ local: at('data'), workspace: at('workspaces') });

  it('writes a finished run together and reads it back exactly: steps, checks, evidence', async () => {
    const store = await Store.open(':memory:', { artifacts });
    const { job, execId } = await withRun(store, artifacts);
    assert.match(execId, /^EXEC-\d{4}-00001$/);

    const x = await store.execution('p', execId);
    assert.deepEqual(x?.totals, { PASS: 1 });
    assert.equal(x?.jobId, job.id);
    assert.equal(x?.durationMs, 2000);
    const r = x?.results[0];
    assert.equal(r?.testId, 'TC-1');
    assert.equal(r?.modelVersion, 1, 'the result says which version of the test case it was for');
    assert.deepEqual(
      r?.steps.map((s) => [s.id, s.result, s.screenshotRef]),
      [
        ['S1', 'passed', undefined],
        ['S2', 'passed', 'local:projects/p/runs/' + execId + '/evidence/S2.png'],
      ],
    );
    assert.deepEqual(
      r?.checks.map((c) => [c.id, c.result]),
      [['A1', 'passed']],
    );
    assert.equal(r?.evidence[0].mime, 'image/png');
    assert.equal(r?.evidence[0].sizeBytes, 'png-bytes'.length);
    assert.match(r?.evidence[0].sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(r?.evidence[0].masked, true);
    assert.deepEqual(await store.generationSnapshot('p', execId), { 'tests/tc-1.spec.ts': 'a'.repeat(64) }, 'the code the run used is known by hash');

    // The list and the old reads still work from the new tables.
    const c = await store.testCase('p', 'TC-1');
    assert.equal(c?.lastStatus, 'PASS');
    assert.equal(c?.lastExecutionId, execId);
    assert.equal(c?.runCount, 1);
    assert.deepEqual(
      (await store.testCaseRuns('p', 'TC-1')).map((run) => [run.jobId, run.status, run.executionId]),
      [[job.id, 'PASS', execId]],
    );
    assert.deepEqual(
      (await store.verdicts(job.id)).map((v) => [v.testId, v.status]),
      [['TC-1', 'PASS']],
    );
    assert.deepEqual(
      (await store.executions('p')).map((e) => e.execId),
      [execId],
    );
    await store.close();
  });

  it('is all or nothing: a failure while writing evidence leaves no execution, result or counter-visible trace', async () => {
    const store = await Store.open(':memory:', { artifacts });
    await store.createProject(project('p'));
    const job = await store.createJob({ projectId: 'p', kind: 'single', input: {} });
    const execId = await store.nextExecutionId();
    await assert.rejects(
      store.saveRun(
        { id: job.id, projectId: 'p' },
        {
          execution: { execId },
          rows: [{ testId: 'T1', status: 'PASS', verdict: verdict('T1', execId) }],
          evidence: { T1: [{ kind: 'screenshot', ref: 'local:x.png', mime: 'image/png', sha256: 'h', sizeBytes: undefined as never }] },
          recordedAt: '2026-10-01T10:00:00.000Z',
        },
      ),
    );
    assert.deepEqual(await store.executions('p'), []);
    assert.deepEqual(await store.verdicts(job.id), []);
    await store.close();
  });

  it('keeps results of a case that stopped before a run: no execution, still a result', async () => {
    const store = await Store.open(':memory:', { artifacts });
    await store.createProject(project('p'));
    const job = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
    await store.saveRun(
      { id: job.id, projectId: 'p' },
      {
        rows: [
          {
            testId: 'TC-9',
            row: 4,
            status: 'NEEDS REVIEW',
            verdict: verdict('TC-9', '', { status: 'NEEDS REVIEW', reason: 'Step S2 is unclear', steps: [], checks: [] }),
          },
        ],
        recordedAt: '2026-10-01T10:00:00.000Z',
      },
    );
    assert.deepEqual(await store.executions('p'), []);
    const [v] = await store.verdicts(job.id);
    assert.equal(v.status, 'NEEDS REVIEW');
    assert.equal(v.row, 4);
    await store.close();
  });

  it('resumes a batch from the newest result of each case, from whichever job made it', async () => {
    const store = await Store.open(':memory:', { artifacts });
    await store.createProject(project('p'));
    const first = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
    await store.saveVerdicts(first.id, [
      { testId: 'A', status: 'NEEDS REVIEW', verdict: { n: 1 } },
      { testId: 'B', status: 'PASS', verdict: { n: 2 } },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.createJob({ projectId: 'p', kind: 'workbook', input: {} });
    await store.saveVerdicts(second.id, [{ testId: 'A', status: 'PASS', verdict: { n: 3 } }]);
    assert.deepEqual(await store.latestVerdicts('p'), { A: { status: 'PASS', verdict: { n: 3 } }, B: { status: 'PASS', verdict: { n: 2 } } });
    await store.close();
  });

  it('numbers runs from a counter that is unique when asked at once and restarts each year', async () => {
    const store = await Store.open(':memory:');
    const ids = await Promise.all(Array.from({ length: 12 }, () => store.nextExecutionId(new Date('2026-06-01T00:00:00Z'))));
    assert.equal(new Set(ids).size, 12);
    assert.ok(ids.every((i) => /^EXEC-2026-\d{5}$/.test(i)));
    assert.equal(await store.nextExecutionId(new Date('2027-06-01T00:00:00Z')), 'EXEC-2027-00001');
    await store.close();
  });
});

describe('moving the old tables (migration 0006)', () => {
  /** The database as it was before M8 step 6: verdicts hold the results, runs are only named on the job. */
  async function before0006(target: string) {
    const db = await SqliteDriver.open(target);
    const { migrate } = await import('./migrate.js');
    await migrate(db, MIGRATIONS.slice(0, 5));
    await db.run(
      "INSERT INTO projects (id, name, base_url, test_id_attribute, browser, workspace, created_at) VALUES ('a', 'A', 'http://x/', 'data-testid', 'chromium', 'C:\\old\\a', '2026-01-01T00:00:00Z')",
    );
    await db.run(
      "INSERT INTO projects (id, name, base_url, test_id_attribute, browser, workspace, created_at) VALUES ('b', 'B', 'http://y/', 'data-testid', 'chromium', 'C:\\old\\b', '2026-01-01T00:00:00Z')",
    );
    await db.run(
      "INSERT INTO environments (id, project_id, name, base_url, is_default, created_at, updated_at) VALUES ('ENV-a', 'a', 'Default', 'http://x/', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    await db.run(
      "INSERT INTO environments (id, project_id, name, base_url, is_default, created_at, updated_at) VALUES ('ENV-b', 'b', 'Default', 'http://y/', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    // Two projects can both hold EXEC-2026-00003: the numbers were only unique within a project's runs folder.
    for (const [job, p, exec] of [
      ['JOB-A', 'a', 'EXEC-2026-00003'],
      ['JOB-B', 'b', 'EXEC-2026-00003'],
      ['JOB-C', 'a', 'EXEC-2026-00007'],
    ] as const) {
      await db.run(
        "INSERT INTO jobs (id, project_id, kind, status, input, execution_id, created_at) VALUES (?, ?, 'workbook', 'done', '{}', ?, '2026-02-01T00:00:00Z')",
        [job, p, exec],
      );
    }
    const v = (t: string, exec: string) =>
      JSON.stringify({ executionId: exec, testId: t, status: 'PASS', reason: 'ok', automationId: `AUTO-${t}`, durationMs: 10 });
    await db.run("INSERT INTO verdicts (job_id, test_id, row, status, verdict) VALUES ('JOB-A', 'T1', 2, 'PASS', ?)", [v('T1', 'EXEC-2026-00003')]);
    await db.run("INSERT INTO verdicts (job_id, test_id, row, status, verdict) VALUES ('JOB-B', 'T1', 2, 'PASS', ?)", [v('T1', 'EXEC-2026-00003')]);
    await db.run("INSERT INTO verdicts (job_id, test_id, row, status, verdict) VALUES ('JOB-C', 'T1', 2, 'PASS', ?)", [v('T1', 'EXEC-2026-00007')]);
    await db.run("INSERT INTO verdicts (job_id, test_id, row, status, verdict) VALUES ('JOB-C', 'row 9', 9, 'NEEDS REVIEW', ?)", [
      JSON.stringify({ problem: 'Row 9 is not a test case', title: '?' }),
    ]);
    await db.close();
  }

  it('copies every verdict into test_results, keeps the old name readable, and never repeats an execution number', async () => {
    const target = at('before-0006.db');
    await before0006(target);
    const store = await Store.open(target);

    assert.deepEqual(
      (await store.verdicts('JOB-C')).map((r) => [r.testId, r.status, r.row]),
      [
        ['T1', 'PASS', 2],
        ['row 9', 'NEEDS REVIEW', 9],
      ],
    );
    assert.deepEqual((await store.executions('a')).map((e) => e.execId).sort(), ['EXEC-2026-00003', 'EXEC-2026-00007']);
    assert.deepEqual(
      (await store.executions('b')).map((e) => e.execId),
      ['EXEC-2026-00003'],
      'the same number in two projects is two executions',
    );
    assert.equal((await store.execution('b', 'EXEC-2026-00003'))?.results[0].testId, 'T1');
    assert.equal((await store.execution('b', 'EXEC-2026-00003'))?.jobId, 'JOB-B');
    assert.equal(await store.nextExecutionId(new Date('2026-12-01T00:00:00Z')), 'EXEC-2026-00008', 'the counter starts above the largest number used');
    assert.deepEqual(await store.problems(), []);

    // The old table is gone from view but its name still answers, as a view (expand and contract, §6.3).
    const peek = await SqliteDriver.open(target);
    assert.equal((await peek.get<{ type: string }>("SELECT type FROM sqlite_master WHERE name = 'verdicts'"))?.type, 'view');
    assert.equal((await peek.get<{ n: number }>('SELECT COUNT(*) AS n FROM verdicts'))?.n, 4);
    assert.equal((await peek.get<{ n: number }>('SELECT COUNT(*) AS n FROM verdicts_legacy'))?.n, 4, 'the original rows are still there for one release');
    await peek.close();
    await store.close();
  });
});

describe('explorations and page routes (FR-DB-08, FR-DB-10)', () => {
  it('records each step of an exploration as a row that can be counted', async () => {
    const store = await Store.open(':memory:');
    await store.createProject(project('p'));
    const item = (id: string, status: string, over = {}) => ({ id, kind: 'step', phase: 'test', raw: `Raw ${id}`, status, warnings: [] as string[], ...over });
    const id = await store.saveExploration('p', {
      extId: 'TC-1',
      status: 'needs-review',
      resultFile: at('data', 'projects', 'p', 'explore', 'TC-1', 'exploration.json'),
      items: [
        item('S1', 'done', { locatorCode: "getByRole('button')", strategy: 'role', score: 0.9, pageName: 'LoginPage' }),
        item('S2', 'skipped'),
        item('S1', 'done', { phase: 'setup' }),
      ],
    });
    assert.match(id, /^EXP-/);
    assert.deepEqual(await store.explorationStats('p'), [
      { status: 'done', count: 2 },
      { status: 'skipped', count: 1 },
    ]);
    await store.close();
  });

  it('moves page URLs from pages.json to the environments on the same origin, without overwriting routes already there', async () => {
    const store = await Store.open(':memory:');
    await store.createProject({ ...project('one'), baseUrl: 'http://127.0.0.1:4173/app' });
    await store.createProject({ ...project('two'), baseUrl: 'http://127.0.0.1:4173/other' });
    await store.createProject({ ...project('else'), baseUrl: 'http://example.test/' });
    await store.savePageRoute('ENV-one', 'Dashboard', '/mine', 'tester');
    const added = await store.importPageUrls({ 'http://127.0.0.1:4173': { Dashboard: '/old', Login: '/login' }, 'http://nowhere': { X: '/x' } });
    assert.equal(added, 3, 'Login for one; Dashboard and Login for two');
    assert.deepEqual(await store.pageRoutes('ENV-one'), { Dashboard: '/mine', Login: '/login' });
    assert.deepEqual(await store.pageRoutes('ENV-two'), { Dashboard: '/old', Login: '/login' });
    assert.deepEqual(await store.pageRoutes('ENV-else'), {});
    assert.equal(await store.importPageUrls({ 'http://127.0.0.1:4173': { Dashboard: '/old', Login: '/login' } }), 0, 'safe to repeat');
    await store.close();
  });
});

describe('bundle, restore, verify (FR-DB-15, FR-DB-16)', () => {
  const artifacts = new LocalArtifactStore({ local: at('data'), workspace: at('workspaces') });

  it('lists every table in the bundle order, so none is left out of an export', async () => {
    const db = await SqliteDriver.open(':memory:');
    const { migrate } = await import('./migrate.js');
    await migrate(db, MIGRATIONS);
    const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((t) => t.name);
    const missing = tables.filter((t) => !(TABLE_ORDER as readonly string[]).includes(t) && !NOT_EXPORTED.includes(t));
    assert.deepEqual(missing, [], 'a new table must be added to TABLE_ORDER (or to NOT_EXPORTED with a reason)');
    await db.close();
  });

  it('exports and imports a project with its history unchanged, ids and EXEC numbers included', async () => {
    const source = await Store.open(at('bundle-src.db'), { artifacts });
    const { execId, job } = await withRun(source, artifacts, 'bp');
    await source.upsertRule('bp', { kind: 'element', pattern: 'username', meaning: 'Login Name', source: 'test' });
    await source.savePageRoute('ENV-bp', 'Dashboard', '/dashboard', 'learned');
    await source.close();

    const peek = await SqliteDriver.open(at('bundle-src.db'));
    const manifest = await exportBundle(peek, MIGRATIONS, at('bundle'));
    await peek.close();
    assert.equal(manifest.schemaVersion, 6);
    assert.ok(manifest.tables.test_results.rows >= 1 && manifest.tables.evidence.rows === 1);
    assert.ok(!readdirSync(at('bundle')).includes('verdicts_legacy.ndjson'), 'the legacy copy is not exported');

    const fresh = await SqliteDriver.open(at('bundle-dst.db'));
    const { migrate } = await import('./migrate.js');
    await migrate(fresh, MIGRATIONS);
    const loaded = await importBundle(fresh, MIGRATIONS, at('bundle'));
    assert.equal(loaded.projects, 1);
    await fresh.close();

    const dst = await Store.open(at('bundle-dst.db'), { artifacts });
    assert.deepEqual(await dst.problems(), []);
    assert.equal((await dst.project('bp'))?.workspace, at('workspaces', 'bp'));
    const x = await dst.execution('bp', execId);
    assert.equal(x?.jobId, job.id);
    assert.equal(x?.results[0].evidence[0].sizeBytes, 'png-bytes'.length);
    assert.deepEqual(
      (await dst.rules('bp')).map((r) => r.pattern),
      ['username'],
    );
    assert.deepEqual(await dst.pageRoutes('ENV-bp'), { Dashboard: '/dashboard' });
    assert.equal(await dst.nextExecutionId(), execId.replace(/\d{5}$/, '00002'), 'numbering continues where it was');
    await dst.close();

    // A second round trip is identical: the bundle of the copy equals the bundle of the original.
    const again = await SqliteDriver.open(at('bundle-dst.db'));
    const second = await exportBundle(again, MIGRATIONS, at('bundle2'));
    await again.close();
    for (const t of ['projects', 'jobs', 'test_results', 'step_results', 'evidence', 'executions']) {
      assert.equal(second.tables[t].sha256, manifest.tables[t].sha256, t);
    }
  });

  it('refuses a bundle that was changed, one from a newer version, and a database that is not empty', async () => {
    const dirty = at('bundle-dirty');
    mkdirSync(dirty, { recursive: true });
    for (const f of readdirSync(at('bundle'))) copyFileSync(at('bundle', f), path.join(dirty, f));
    writeFileSync(path.join(dirty, 'projects.ndjson'), `${readFileSync(path.join(dirty, 'projects.ndjson'), 'utf8')}\n{"id":"sneaky"}\n`);
    assert.throws(
      () => readBundle(dirty, MIGRATIONS),
      (e: Error) => e instanceof BundleError && /was changed/.test(e.message),
    );

    const future = at('bundle-future');
    mkdirSync(future, { recursive: true });
    for (const f of readdirSync(at('bundle'))) copyFileSync(at('bundle', f), path.join(future, f));
    const m = JSON.parse(readFileSync(path.join(future, 'manifest.json'), 'utf8'));
    writeFileSync(path.join(future, 'manifest.json'), JSON.stringify({ ...m, schemaVersion: 99 }));
    assert.throws(() => readBundle(future, MIGRATIONS), /newer Auto QA/);

    const used = await SqliteDriver.open(at('bundle-dst.db'));
    await assert.rejects(importBundle(used, MIGRATIONS, at('bundle')), /already has projects/);
    await used.close();
  });

  it('restores a backup, keeps a copy of what it replaced, and refuses a newer or damaged file', async () => {
    const live = at('live.db');
    const a = await Store.open(live);
    await a.createProject(project('before'));
    await a.close();
    const backupFile = at('good-backup.db');
    const b = await SqliteDriver.open(live);
    await b.backup(backupFile);
    await b.close();
    const c = await Store.open(live);
    await c.createProject(project('after'));
    await c.close();

    const result = await restoreDatabase(live, backupFile, MIGRATIONS, at('restore-backups'));
    assert.equal(result.version, 6);
    assert.match(result.previous ?? '', /before-restore\.db$/);
    const restored = await Store.open(live);
    assert.deepEqual(
      (await restored.projects()).map((p) => p.id),
      ['before'],
    );
    await restored.close();
    const kept = await Store.open(result.previous as string);
    assert.deepEqual(
      (await kept.projects()).map((p) => p.id),
      ['before', 'after'],
      'what was replaced is not lost',
    );
    await kept.close();

    const newer = at('newer.db');
    const n = await SqliteDriver.open(newer);
    const { migrate } = await import('./migrate.js');
    await migrate(n, MIGRATIONS);
    await n.run("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', '2030-01-01T00:00:00Z')");
    await n.close();
    await assert.rejects(
      restoreDatabase(live, newer, MIGRATIONS, at('restore-backups')),
      (e: Error) => e instanceof RestoreError && /newer Auto QA/.test(e.message),
    );

    writeFileSync(at('garbage.db'), 'this is not a database at all, just text that is long enough to look like a file');
    await assert.rejects(restoreDatabase(live, at('garbage.db'), MIGRATIONS, at('restore-backups')), RestoreError);
    await assert.rejects(restoreDatabase(live, at('missing.db'), MIGRATIONS, at('restore-backups')), /There is no file/);
    const still = await Store.open(live);
    assert.deepEqual(
      (await still.projects()).map((p) => p.id),
      ['before'],
      'a refused restore changes nothing',
    );
    await still.close();
  });

  it('finds a file the database names that is gone, a file it does not know, and a counter that fell behind', async () => {
    const store = await Store.open(at('verify.db'), { artifacts });
    const { execId, shot } = await withRun(store, artifacts, 'vp');
    assert.deepEqual(await fileProblems(store, artifacts, at('data')), []);
    assert.deepEqual(await store.problems(), []);

    writeFileSync(path.join(path.dirname(shot), 'stray.png'), 'x');
    assert.deepEqual(await fileProblems(store, artifacts, at('data')), [
      `orphan file local:projects/vp/runs/${execId}/evidence/stray.png: no evidence row names it`,
    ]);

    await rm(shot);
    const found = await fileProblems(store, artifacts, at('data'));
    assert.ok(found.some((f) => f.startsWith('evidence ') && f.endsWith(`projects/vp/runs/${execId}/evidence/S2.png`)));
    assert.ok(found.some((f) => f.startsWith('step_results ')));
    assert.ok(!existsSync(shot));

    const year = execId.split('-')[1];
    const peek = await SqliteDriver.open(at('verify.db'));
    await peek.run("UPDATE counters SET value = 0 WHERE name = 'execution'");
    await peek.close();
    assert.match((await store.problems())[0], new RegExp(`counter for ${year} is 0`));
    await store.close();
  });
});

describe('upgrading a database from a released version (FR-DB-18)', () => {
  const fixtures = path.resolve(import.meta.dirname, '../../fixtures/db');

  for (const name of existsSync(fixtures) ? readdirSync(fixtures).filter((f) => f.endsWith('.db')) : []) {
    it(`migrates ${name} to the latest version with its data intact`, async () => {
      const copy = at(`fixture-${name}`);
      copyFileSync(path.join(fixtures, name), copy);
      const store = await Store.open(copy);
      const p = await store.project('orangehrm');
      assert.equal(p?.name, 'OrangeHRM');
      assert.equal((await store.environments('orangehrm'))[0].baseUrl, 'http://127.0.0.1/orangehrm-2.5.0.2/login.php');
      assert.deepEqual(
        (await store.logs('JOB-1')).map((l) => l.message),
        ['first', 'second', 'third'],
      );
      assert.deepEqual(
        (await store.verdicts('JOB-1')).map((v) => [v.testId, v.status]),
        [['TC-1', 'PASS']],
      );
      assert.equal((await store.execution('orangehrm', 'EXEC-2026-00002'))?.results[0].testId, 'TC-1');
      assert.equal(await store.nextExecutionId(new Date('2026-12-01T00:00:00Z')), 'EXEC-2026-00003');
      assert.deepEqual(await store.problems(), []);
      await store.close();
    });
  }

  it('has a fixture for the first release', () => {
    assert.ok(existsSync(path.join(fixtures, 'v0.1.0.db')), 'fixtures/db/v0.1.0.db is the database as released; add one per release');
  });
});
