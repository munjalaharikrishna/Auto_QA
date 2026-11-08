import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { defaultParserConfig } from '../parser/index.js';
import type { TestVerdict } from '../results/verdict.js';
import { buildApp, probeAddress } from './app.js';
import { JobRunner } from './jobs.js';
import { Store } from './store.js';

/**
 * U1 step 2, what the start page reads: a tile colour per project, a live check of an address, what waits for a person on the dashboard
 * (needs you, blocked), and the review summary (the open questions of each project's latest run, the biggest one, answers remembered).
 */

describe('the start page data (U1 step 2)', { concurrency: false }, () => {
  let dir: string;
  let app: FastifyInstance;
  let store: Store;
  let demo: Awaited<ReturnType<typeof startDemoApp>>;
  const json = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object | undefined });
    return { status: res.statusCode, body: res.json() };
  };

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aq-home-'));
    store = await Store.open(':memory:');
    const runner = new JobRunner({ store, config: defaultParserConfig(), dataDir: path.join(dir, 'data') });
    app = await buildApp({ store, runner, dataDir: path.join(dir, 'data'), workspacesDir: path.join(dir, 'workspaces') });
    demo = await startDemoApp();
  });
  after(async () => {
    await app?.close();
    await demo?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('a project keeps the tile colour it was given, lavender by default, and only a known colour', async () => {
    const made = await json('POST', '/api/projects', { name: 'Shop', baseUrl: demo.url, tile: 'mint' });
    assert.equal(made.status, 201);
    assert.equal(made.body.tile, 'mint');
    assert.equal((await json('POST', '/api/projects', { name: 'Plain', baseUrl: demo.url })).body.tile, 'lavender');
    assert.equal((await json('PATCH', '/api/projects/shop', { tile: 'rose' })).body.tile, 'rose');
    assert.equal((await json('PATCH', '/api/projects/shop', { tile: 'neon' })).status, 400);
    assert.equal((await json('GET', '/api/projects/shop')).body.tile, 'rose');
  });

  it('the address check says whether the page answers and shows a login form, and never throws', async () => {
    const login = await probeAddress(`${demo.url}/`);
    assert.equal(login.ok, true);
    assert.equal(login.loginForm, true);
    const down = await probeAddress('http://127.0.0.1:1/');
    assert.equal(down.ok, false);
    assert.ok(down.error);
    assert.equal((await probeAddress('file:///etc/passwd')).ok, false);
    assert.equal((await json('POST', '/api/probe', { url: 'not an address' })).status, 400);
    assert.equal((await json('POST', '/api/probe', { url: `${demo.url}/` })).body.loginForm, true);
  });

  it('the dashboard counts what needs a person and what was blocked, and gives each project its tile', async () => {
    for (const [id, status] of [
      ['T1', 'PASS'],
      ['T2', 'NEEDS REVIEW'],
      ['T3', 'NOT VERIFIED'],
      ['T4', 'BLOCKED'],
    ] as const) {
      await store.upsertTestCase('shop', { id, title: id, steps: '1. Open the page', expected: 'The page is shown' }, { kind: 'form' }, 'test');
      await store.recordResult('shop', id, { jobId: 'JOB-x', status, at: new Date().toISOString() });
    }
    const d = (await json('GET', '/api/dashboard')).body;
    const shop = d.projects.find((p: { project: { id: string } }) => p.project.id === 'shop');
    assert.equal(shop.project.tile, 'rose');
    assert.equal(shop.cases.needs, 2, 'NEEDS REVIEW and NOT VERIFIED wait for a person');
    assert.equal(shop.cases.blocked, 1);
    assert.equal(d.totals.needs, 2);
    assert.equal(d.totals.blocked, 1);
  });

  it('the review summary gives each project the open questions of its latest finished run, and the one that covers the most cases', async () => {
    const job = await store.createJob({ projectId: 'shop', kind: 'workbook', input: {} });
    const unclear = (testId: string): TestVerdict =>
      ({
        executionId: 'E',
        testId,
        title: testId,
        automationId: testId,
        status: 'NEEDS REVIEW',
        reason: 'step 2 "Click on Employee Name": ambiguous wording',
        review: [{ id: 'step 2', raw: 'Click on Employee Name', headline: '', why: '"Employee Name" names no employee', todo: [] }],
        expected: 'x',
        actual: `page ${testId}`,
        steps: [{ id: 'S1', raw: 'Open', result: 'passed' }],
        checks: [],
        durationMs: 1,
        evidence: { screenshots: [] },
      }) as TestVerdict;
    const other: TestVerdict = {
      ...unclear('T9'),
      review: [{ id: 'expected result', raw: 'It works', headline: '', why: 'no check could be read', todo: [] }],
    };
    await store.saveVerdicts(job.id, [
      { testId: 'T5', status: 'NEEDS REVIEW', verdict: unclear('T5') },
      { testId: 'T6', status: 'NEEDS REVIEW', verdict: unclear('T6') },
      { testId: 'T9', status: 'NEEDS REVIEW', verdict: other },
    ]);
    await store.updateJob(job.id, { status: 'done', finishedAt: new Date().toISOString() });
    const s = (await json('GET', '/api/review-summary')).body;
    const shop = s.projects.find((p: { projectId: string }) => p.projectId === 'shop');
    assert.equal(shop.jobId, job.id);
    assert.equal(shop.questions, 2);
    assert.equal(shop.biggest.clause, 'Click on Employee Name');
    assert.equal(shop.biggest.cases, 2);
    assert.equal(s.projects.find((p: { projectId: string }) => p.projectId === 'plain').questions, 0);
    assert.equal(typeof s.remembered, 'number');
  });
});
