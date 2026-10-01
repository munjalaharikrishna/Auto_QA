import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildDemoWorkbook } from '../../examples/demo-app/make-workbook.js';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import { defaultParserConfig } from '../parser/index.js';
import { buildApp } from './app.js';
import { readEnvFile } from './credentials.js';
import { JobRunner } from './jobs.js';
import { Store } from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A multipart body for one file, as a browser's upload sends it. */
function multipart(file: string, name = path.basename(file)) {
  const boundary = '----autoqa';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    readFileSync(file),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function server(dir: string, headless = true) {
  const store = await Store.open(':memory:');
  const runner = new JobRunner({ store, config: defaultParserConfig(), dataDir: path.join(dir, 'data'), headless });
  const app = await buildApp({ store, runner, dataDir: path.join(dir, 'data'), workspacesDir: path.join(dir, 'workspaces') });
  return { store, runner, app };
}

describe('API (M7a)', () => {
  let dir: string;
  let app: FastifyInstance;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-api-'));
    ({ app } = await server(dir));
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps credentials in the workspace .env and never returns a secret (FR-ENV-05)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Demo App', baseUrl: 'http://127.0.0.1:4173', username: 'demo', password: 's3cret #1', variables: { TEST_WRONG_PASSWORD: 'nope' } },
    });
    assert.equal(res.statusCode, 201);
    assert.ok(!res.body.includes('s3cret') && !res.body.includes('nope'));
    const p = res.json();
    assert.equal(p.id, 'demo-app');
    assert.deepEqual(p.env, {
      username: 'demo',
      hasPassword: true,
      variables: [
        { name: 'BASE_URL', secret: false, value: 'http://127.0.0.1:4173' },
        { name: 'TEST_PASSWORD', secret: true },
        { name: 'TEST_USERNAME', secret: false, value: 'demo' },
        { name: 'TEST_WRONG_PASSWORD', secret: true },
      ],
    });
    // Quoted because of the space and #, and read back exactly.
    assert.match(readFileSync(path.join(p.workspace, '.env'), 'utf8'), /^TEST_PASSWORD="s3cret #1"$/m);
    assert.equal(readEnvFile(p.workspace).TEST_PASSWORD, 's3cret #1');
    assert.match(readFileSync(path.join(p.workspace, '.gitignore'), 'utf8'), /^\.env$/m);

    // A blank password in an update keeps the one that is set.
    const patched = await app.inject({ method: 'PATCH', url: '/api/projects/demo-app', payload: { password: '', username: 'demo2' } });
    assert.equal(patched.json().env.username, 'demo2');
    // Settings that were not sent keep their values.
    await app.inject({ method: 'PATCH', url: '/api/projects/demo-app', payload: { testIdAttribute: 'data-test' } });
    const kept = await app.inject({ method: 'PATCH', url: '/api/projects/demo-app', payload: { name: 'Demo' } });
    assert.deepEqual([kept.json().name, kept.json().testIdAttribute, kept.json().baseUrl], ['Demo', 'data-test', 'http://127.0.0.1:4173']);
    assert.equal(readEnvFile(p.workspace).TEST_PASSWORD, 's3cret #1');
  });

  it('refuses bad input with a reason', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x', baseUrl: 'not a url' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /baseUrl/);
    assert.equal((await app.inject({ url: '/api/projects/nope' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/jobs/nope' })).statusCode, 404);
    const answer = await app.inject({ method: 'POST', url: '/api/questions/999/answer', payload: { answer: 0 } });
    assert.equal(answer.statusCode, 400);
  });

  it('previews an uploaded workbook for column mapping (FR-IN-02)', async () => {
    const file = path.join(dir, 'Regression suite.xlsx');
    await buildDemoWorkbook(file, 12);
    const res = await app.inject({ method: 'POST', url: '/api/projects/demo-app/uploads', ...multipart(file) });
    assert.equal(res.statusCode, 201);
    const p = res.json();
    assert.deepEqual([p.ok, p.sheet, p.headerRow, p.total], [true, 'Regression', 2, 12]);
    assert.deepEqual(p.columns, { id: 2, title: 3, preconditions: 4, steps: 5, testData: 6, expected: 7 });
    assert.equal(p.sample.length, 5);
    // A mapping that names a column that is not there is refused before anything runs.
    const bad = await app.inject({ method: 'POST', url: `/api/uploads/${p.uploadId}/preview`, payload: { mapping: { steps: 'Nope' } } });
    assert.equal(bad.json().ok, false);
    assert.match(bad.json().error, /no such column/);
    // The mapping a run used is offered again for the next upload (FR-IN-02).
    const wb = new (await import('exceljs')).default.Workbook();
    wb.addWorksheet('S').addRow(['Scenario', 'What to do', 'Outcome']);
    wb.getWorksheet('S')!.addRow(['Login', '1. Open Login page', 'User is redirected to Dashboard page']);
    const custom = path.join(dir, 'custom.xlsx');
    await wb.xlsx.writeFile(custom);
    const first = (await app.inject({ method: 'POST', url: '/api/projects/demo-app/uploads', ...multipart(custom) })).json();
    assert.equal(first.ok, false, 'no Steps column without a mapping');
    const mapping = { steps: 'What to do', expected: 'Outcome' };
    const started = await app.inject({ method: 'POST', url: `/api/uploads/${first.uploadId}/run`, payload: { mapping } });
    assert.equal(started.statusCode, 202);
    // Only the saved mapping matters here; the run itself is not wanted.
    await app.inject({ method: 'POST', url: `/api/jobs/${started.json().id}/cancel` });
    const second = (await app.inject({ method: 'POST', url: '/api/projects/demo-app/uploads', ...multipart(custom) })).json();
    assert.deepEqual([second.ok, second.mapping, second.total], [true, mapping, 1]);
    const txt = path.join(dir, 'notes.txt');
    await (await import('node:fs/promises')).writeFile(txt, 'x');
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/demo-app/uploads', ...multipart(txt) })).statusCode, 400);
  });

  it('serves files only from its own folders', async () => {
    const outside = await app.inject({ url: `/api/files?path=${encodeURIComponent(path.join(root, 'package.json'))}` });
    assert.equal(outside.statusCode, 403);
    const sneaky = await app.inject({ url: `/api/files?path=${encodeURIComponent(path.join(dir, 'data', '..', '..', 'x'))}` });
    assert.equal(sneaky.statusCode, 403);
  });
});

describe('jobs end to end (M7a)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER, concurrency: false }, () => {
  let dir: string;
  let demo: Awaited<ReturnType<typeof startDemoApp>>;
  let s: Awaited<ReturnType<typeof server>>;
  const get = async (url: string) => (await s.app.inject({ url })).json();
  const post = async (url: string, payload: unknown = {}) => (await s.app.inject({ method: 'POST', url, payload: payload as object })).json();
  const until = async (id: string, statuses: string[]) => {
    for (let i = 0; i < 600; i++) {
      const j = await get(`/api/jobs/${id}`);
      if (statuses.includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`job ${id} never reached ${statuses.join('/')}`);
  };

  before(async () => {
    // Inside the repo, so generated projects find @playwright/test the usual way; NODE_PATH covers the rest.
    dir = await mkdtemp(path.join(root, '.auto-qa', 'test-server-'));
    demo = await startDemoApp();
    s = await server(dir);
    await post('/api/projects', {
      name: 'Demo',
      baseUrl: demo.url,
      username: DEMO_USER.username,
      password: DEMO_USER.password,
      variables: { TEST_WRONG_PASSWORD: 'nope' },
    });
  });
  after(async () => {
    await s.app.close();
    await demo.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('asks, waits in review, and runs after approval (FR-RV-01…03)', async () => {
    const job = await post('/api/projects/demo/cases', {
      title: 'Security details open',
      steps: '1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login\n5. Click Details',
      expected: 'Message "Security details" is shown',
    });
    let j = await until(job.id, ['waiting']);
    const q = j.questions[0];
    assert.equal(q.payload.code, 'AMBIGUOUS');
    const second = q.payload.view.elements.filter((e: { name: string }) => e.name === 'Details')[1];
    await post(`/api/questions/${q.id}/answer`, { answer: { ref: second.ref } });
    j = await until(job.id, ['review']);
    const s5 = j.output.review.items.find((i: { id: string }) => i.id === 'S5');
    assert.equal(s5.resolvedBy, 'tester');
    assert.ok(j.output.review.changes.some((c: { path: string; patch: string }) => c.path.startsWith('tests/') && c.patch.includes('+')));
    await post(`/api/jobs/${job.id}/approve`);
    j = await until(job.id, ['done', 'failed']);
    assert.equal(j.status, 'done', j.error);
    assert.equal(j.verdicts[0].status, 'PASS');
    const caseId = j.input.case.id as string;

    // Item 1: the test case is still there after the run, with its result.
    const list = await get('/api/projects/demo/test-cases');
    const saved = list.find((c: { extId: string }) => c.extId === caseId);
    assert.ok(saved, 'the case is in the list');
    assert.equal(saved.title, 'Security details open');
    assert.equal(saved.lastStatus, 'PASS');
    assert.equal(saved.lastJobId, job.id);

    // Item 2 and 4: every step has its time and a screenshot, and the run has a video.
    const v = j.verdicts[0].verdict;
    assert.ok(
      v.steps.every((x: { screenshot?: string; durationMs?: number }) => x.screenshot && x.durationMs !== undefined),
      'a screenshot and a time for each step',
    );
    assert.ok(v.evidence.video?.endsWith('.webm'), 'a video');
    for (const file of [v.steps[0].screenshot, v.evidence.video]) {
      const served = await s.app.inject({ url: `/api/files?path=${encodeURIComponent(file)}` });
      assert.equal(served.statusCode, 200, file);
    }

    // Item 3: run it again. It was approved before, so it runs straight away without asking.
    const rerun = await post(`/api/projects/demo/test-cases/${caseId}/run`);
    j = await until(rerun.id, ['review', 'done', 'failed', 'waiting']);
    assert.equal(j.status, 'done', `a saved test runs again without review (${j.status} ${j.error ?? ''})`);
    assert.equal(j.verdicts[0].status, 'PASS');
    const detail = await get(`/api/projects/demo/test-cases/${caseId}`);
    assert.equal(detail.runCount, 2);
    assert.deepEqual(
      detail.runs.map((r: { jobId: string }) => r.jobId),
      [rerun.id, job.id],
      'both runs are in its history, newest first',
    );
  });

  it('runs a workbook and offers the results copy (FR-IN-08, FR-HI-06)', async () => {
    const file = path.join(dir, 'suite.xlsx');
    await buildDemoWorkbook(file, 12);
    const up = (await s.app.inject({ method: 'POST', url: '/api/projects/demo/uploads', ...multipart(file) })).json();
    const job = await post(`/api/uploads/${up.uploadId}/run`);
    const j = await until(job.id, ['done', 'failed']);
    assert.equal(j.status, 'done', j.error);
    assert.deepEqual(j.output.summary.totals, { PASS: 8, FAIL: 2, BLOCKED: 0, 'NEEDS REVIEW': 3 });
    assert.equal(j.verdicts.length, 13);
    // Item 1: every case of the sheet is kept.
    const cases = await get('/api/projects/demo/test-cases');
    assert.ok(cases.length >= 13, `${cases.length} cases kept`);
    assert.ok(cases.some((c: { sourceKind: string }) => c.sourceKind === 'workbook'));
    const results = await s.app.inject({ url: `/api/jobs/${job.id}/results` });
    assert.equal(results.statusCode, 200);
    assert.match(String(results.headers['content-disposition']), /suite\.results\.xlsx/);
  });

  it('cancels a job that is waiting for an answer, and the next job still runs', async () => {
    const waiting = await post('/api/projects/demo/cases', {
      title: 'Ambiguous',
      steps: `1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login\n5. Click Details`,
      expected: 'User stays on the same page',
    });
    const nextJob = await post('/api/projects/demo/cases', {
      title: 'Login',
      steps: '1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login',
      expected: 'User is redirected to Dashboard page',
    });
    await until(waiting.id, ['waiting']);
    await post(`/api/jobs/${waiting.id}/cancel`);
    const stopped = await until(waiting.id, ['cancelled', 'failed', 'review']);
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.output.cancelledFrom, 'waiting', 'says where it was stopped (item 7)');
    assert.equal((await until(nextJob.id, ['review', 'failed'])).status, 'review', 'the queue moved on');
    await post(`/api/jobs/${nextJob.id}/cancel`);
    assert.equal((await until(nextJob.id, ['cancelled'])).status, 'cancelled');
  });
});
