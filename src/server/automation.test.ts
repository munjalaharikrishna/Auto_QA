import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { LocalArtifactStore } from '../db/artifacts.js';
import { defaultParserConfig } from '../parser/index.js';
import { catalogue } from '../validations/catalogue.js';
import { buildApp } from './app.js';
import { JobRunner } from './jobs.js';
import { Store } from './store.js';

/** Approval, Web Automation, assertions, releases and the dashboard (the left-menu pages), through the API. */

describe('approval, Web Automation, releases, dashboard', () => {
  let dir: string;
  let app: FastifyInstance;
  let runner: JobRunner;
  const json = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object | undefined });
    return { status: res.statusCode, body: res.headers['content-type']?.toString().includes('json') ? res.json() : res.body, res };
  };

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-auto-'));
    const artifacts = new LocalArtifactStore({ local: path.join(dir, 'data'), workspace: path.join(dir, 'workspaces') });
    const store = await Store.open(':memory:', { artifacts });
    runner = new JobRunner({ store, config: defaultParserConfig(), dataDir: path.join(dir, 'data') });
    app = await buildApp({ store, runner, dataDir: path.join(dir, 'data'), workspacesDir: path.join(dir, 'workspaces') });
    await json('POST', '/api/projects', { name: 'Shop', baseUrl: 'http://127.0.0.1:4173' });
    await store.upsertTestCase(
      'shop',
      { id: 'TC-1', title: 'Log in', steps: '1. Open Login page\n2. Click Login', expected: 'User is redirected to Dashboard page.' },
      { kind: 'form' },
      'test',
    );
    await store.upsertTestCase(
      'shop',
      { id: 'TC-2', title: 'Log out', steps: '1. Open Home page', expected: 'Home page is displayed.' },
      { kind: 'form' },
      'test',
    );
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('offers only approved test cases in Web Automation, and refuses to record a draft', async () => {
    assert.deepEqual((await json('GET', '/api/automation')).body, []);
    assert.equal((await json('POST', '/api/projects/shop/test-cases/TC-1/record')).status, 400, 'a draft cannot be recorded');

    const approved = await json('PUT', '/api/projects/shop/test-cases/TC-1/approval', { approval: 'approved' });
    assert.equal(approved.body.approval, 'approved');
    const list = (await json('GET', '/api/automation')).body;
    assert.deepEqual(
      list.map((c: { extId: string; script: string; projectName: string }) => [c.extId, c.script, c.projectName]),
      [['TC-1', 'none', 'Shop']],
    );

    await json('PUT', '/api/projects/shop/test-cases/TC-1/approval', { approval: 'draft' });
    assert.deepEqual((await json('GET', '/api/automation')).body, []);
    assert.equal((await json('PUT', '/api/projects/shop/test-cases/NOPE/approval', { approval: 'approved' })).status, 404);
    assert.equal((await json('PUT', '/api/projects/shop/test-cases/TC-1/approval', { approval: 'maybe' })).status, 400);
  });

  it('lists every validation the platform knows, with sentences to start from', async () => {
    const { body } = await json('GET', '/api/validations');
    assert.equal(body.length, catalogue().length);
    assert.ok(body.length > 60, 'the whole registry, not a short list');
    for (const v of body) assert.ok(v.id && v.title && v.family && Array.isArray(v.examples), `${v.id} has a title and a family`);
    assert.ok(body.some((v: { id: string }) => v.id === 'VAL-A01'));
  });

  it('adds an assertion as a new version, refuses a sentence it cannot read, and refuses a duplicate', async () => {
    const ok = await json('POST', '/api/projects/shop/test-cases/TC-1/assertions', { text: 'Page title is "Swag Labs"' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.version, 2);
    assert.match(ok.body.raw.expected, /Dashboard page\.\nPage title is "Swag Labs"$/);
    // The versions list says what changed since the version before (IN-23).
    const versions = (await json('GET', '/api/projects/shop/test-cases/TC-1')).body.versions;
    assert.deepEqual(
      versions.map((v: { version: number; changes: Array<{ text: string }> }) => [v.version, v.changes.map((c) => c.text)]),
      [
        [2, ['Expected 2 added: "Page title is "Swag Labs""']],
        [1, []],
      ],
    );

    const again = await json('POST', '/api/projects/shop/test-cases/TC-1/assertions', { text: 'Page title is "Swag Labs"' });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already/);

    const bad = await json('POST', '/api/projects/shop/test-cases/TC-1/assertions', { text: 'Flibbertigibbet wobbles sideways' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not understood/);
    assert.equal((await json('GET', '/api/projects/shop/test-cases/TC-1')).body.version, 2, 'a refused sentence changes nothing');
  });

  it('downloads the recorded script as a zip, without the .env or node_modules', async () => {
    assert.equal((await json('GET', '/api/projects/shop/test-cases/TC-1/script')).status, 404, 'nothing recorded yet');
    const workspace = runner.projectDir({ id: 'shop' } as never, 'single', 'TC-1', 'workspace');
    await mkdir(path.join(workspace, 'tests'), { recursive: true });
    await mkdir(path.join(workspace, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(workspace, 'tests', 'tc-1.spec.ts'), "test('login', async () => {});\n");
    await writeFile(path.join(workspace, 'package.json'), '{}');
    await writeFile(path.join(workspace, '.env'), 'TEST_PASSWORD=secret');
    await writeFile(path.join(workspace, 'node_modules', 'x', 'index.js'), 'x');

    const res = await json('GET', '/api/projects/shop/test-cases/TC-1/script');
    assert.equal(res.status, 200);
    assert.match(String(res.res.headers['content-disposition']), /TC-1-playwright\.zip/);
    const zip = res.res.rawPayload;
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'starts like a zip');
    assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2, 'holds the test and package.json only');
    assert.ok(zip.includes(Buffer.from('tests/tc-1.spec.ts')));
    assert.ok(!zip.includes(Buffer.from('.env')) && !zip.includes(Buffer.from('node_modules')));

    const preview = (await json('GET', '/api/projects/shop/test-cases/TC-1/script/preview')).body;
    assert.equal(preview.files[0].name, 'tc-1.spec.ts');
    assert.match(preview.files[0].content, /login/);
  });

  describe('releases', () => {
    let releaseId: string;
    const base = '/api/projects/shop/releases';

    it('keeps scope, date and features, and rejects bad input', async () => {
      assert.equal((await json('POST', base, { name: 'R1', plannedDate: '31/10/2026' })).status, 400);
      assert.equal((await json('POST', base, { name: 'R1', plannedDate: '2026-10-30', startDate: '2026-11-01' })).status, 400, 'ends before it starts');
      assert.equal(
        (await json('POST', base, { name: 'R1', plannedDate: '2026-10-30', features: [{ title: 'Login', caseIds: ['TC-404'] }] })).status,
        400,
        'a feature cannot point at a test case that does not exist',
      );

      const created = await json('POST', base, {
        name: 'Release 1',
        version: '1.0.0',
        scope: 'Sign-in and profile',
        teamSize: 2,
        startDate: '2026-10-12',
        plannedDate: '2026-10-30',
        features: [
          { title: 'Login', effortDays: 6, caseIds: ['TC-1'] },
          { title: 'Profile', effortDays: 4 },
        ],
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      releaseId = created.body.id;
      assert.equal(created.body.summary.baselineFeatures, 2);
      assert.equal(created.body.summary.coveragePercent, 50);
      assert.equal(created.body.baselineDate, '2026-10-30');
      assert.equal(created.body.changes.length, 0, 'before the lock there is nothing to explain');
    });

    it('records an added requirement with its reason, moves the date and shows the effect', async () => {
      const url = `${base}/${releaseId}`;
      const unlocked = await json('POST', `${url}/features`, { title: 'Extra', effortDays: 1 });
      assert.equal(unlocked.status, 201, 'before the lock a feature is just part of the plan');
      assert.equal(unlocked.body.feature.addedAfterBaseline, false);
      await json('DELETE', `${url}/features/${unlocked.body.feature.id}`, {});

      const locked = await json('POST', `${url}/lock`);
      assert.equal(locked.body.baselinedAt !== undefined, true);
      assert.equal(locked.body.changes[0].kind, 'scope-locked');

      const refused = await json('POST', `${url}/features`, { title: 'Export to PDF', effortDays: 8 });
      assert.equal(refused.status, 400, 'a locked release needs a reason');

      // 8 days of work shared by 2 people: 4 working days after Fri 30 Oct 2026 is Wed 4 Nov.
      const impact = (await json('POST', `${url}/impact`, { effortDays: 8 })).body;
      assert.equal(impact.suggestedDate, '2026-11-05');
      assert.equal(impact.extraCalendarDays, 6);
      assert.equal(impact.scopeGrowthPercentAfter, 80);

      const added = await json('POST', `${url}/features`, {
        title: 'Export to PDF',
        effortDays: 8,
        reason: 'Customer asked for it in the review',
        newDate: impact.suggestedDate,
        caseIds: ['TC-2'],
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      const r = added.body.release;
      assert.equal(r.dueDate, '2026-11-05');
      assert.equal(r.baselineDate, '2026-10-30', 'the baseline never moves');
      assert.equal(r.summary.slipDays, 6);
      assert.equal(r.summary.addedFeatures, 1);
      assert.equal(r.summary.baselineEffortDays, 10);
      assert.equal(r.summary.currentEffortDays, 18);
      assert.equal(r.summary.scopeGrowthPercent, 80);
      assert.equal(r.summary.coveragePercent, 67);
      const change = r.changes.at(-1);
      assert.deepEqual(
        [change.kind, change.reason, change.oldDate, change.newDate, change.effortDays],
        ['feature-added', 'Customer asked for it in the review', '2026-10-30', '2026-11-05', 8],
      );
    });

    it('records a removal and a date change, each with a reason', async () => {
      const url = `${base}/${releaseId}`;
      const before = (await json('GET', url)).body;
      const profile = before.features.find((f: { title: string }) => f.title === 'Profile');
      assert.equal((await json('DELETE', `${url}/features/${profile.id}`, {})).status, 400, 'needs a reason once locked');
      const removed = await json('DELETE', `${url}/features/${profile.id}`, { reason: 'Moved to the next release', newDate: '2026-11-03' });
      assert.equal(removed.body.dueDate, '2026-11-03');
      assert.equal(removed.body.summary.removedFeatures, 1);
      assert.equal(removed.body.summary.slipDays, 4);

      assert.equal((await json('POST', `${url}/date`, { newDate: '2026-11-10' })).status, 400);
      const moved = await json('POST', `${url}/date`, { newDate: '2026-11-10', reason: 'Environment was down' });
      assert.equal(moved.body.summary.slipDays, 11);
      assert.deepEqual(
        moved.body.changes.map((c: { kind: string }) => c.kind),
        ['scope-locked', 'feature-added', 'feature-removed', 'date-changed'],
      );
    });

    it('is listed with its health for the dashboard and the Releases page', async () => {
      const all = (await json('GET', '/api/releases')).body;
      assert.equal(all.length, 1);
      assert.equal(all[0].projectName, 'Shop');
      assert.ok(['ok', 'watch', 'late'].includes(all[0].summary.health.level));

      await json('PUT', '/api/projects/shop/test-cases/TC-1/approval', { approval: 'approved' });
      const dash = (await json('GET', '/api/dashboard')).body;
      assert.deepEqual([dash.totals.projects, dash.totals.cases, dash.totals.approved, dash.totals.notRun], [1, 2, 1, 2]);
      assert.equal(dash.projects[0].releases[0].id, releaseId);

      await json('PATCH', `${base}/${releaseId}`, { status: 'released' });
      assert.deepEqual((await json('GET', '/api/dashboard')).body.projects[0].releases, [], 'a released release leaves the dashboard');
      assert.equal((await json('DELETE', `${base}/${releaseId}`)).status, 200);
      assert.equal((await json('GET', `${base}/${releaseId}`)).status, 404);
    });
  });
});
