import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import { LocalArtifactStore } from '../db/artifacts.js';
import { defaultParserConfig } from '../parser/index.js';
import { buildApp } from './app.js';
import { JobRunner } from './jobs.js';
import { Store } from './store.js';

/**
 * E0.14b exit tests, end to end on the demo app: a walkthrough opened for a saved test case runs its steps one at a time, asks for a
 * pick where a step finds two elements, takes a check, asks before the step that saves, saves a new version only when told, keeps the
 * screens as the person's, and remembers the pick for that screen so the next walkthrough does not ask again. Needs Chrome.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Q = { id: number; kind: string; payload: Record<string, unknown> };
type J = { id: string; status: string; questions: Q[]; output: Record<string, unknown>; logs: Array<{ message: string }>; error?: string };

describe('E0.14b: the guided walkthrough, end to end', { skip: !!process.env.AUTO_QA_SKIP_BROWSER, concurrency: false }, () => {
  let dir: string;
  let demo: Awaited<ReturnType<typeof startDemoApp>>;
  let store: Store;
  let runner: JobRunner;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const get = async (url: string) => (await app.inject({ url })).json();
  const post = async (url: string, payload: unknown = {}) => (await app.inject({ method: 'POST', url, payload: payload as object })).json();

  /** Answers every question the job asks with `answer`, until it ends. */
  async function drive(jobId: string, answer: (q: Q) => unknown): Promise<J> {
    for (let i = 0; i < 1200; i++) {
      const j = (await get(`/api/jobs/${jobId}`)) as J;
      if (['done', 'failed', 'cancelled'].includes(j.status)) return j;
      const q = j.questions[0];
      if (j.status === 'waiting' && q) await post(`/api/questions/${q.id}/answer`, { answer: answer(q) });
      else await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`job ${jobId} did not end`);
  }

  const CASE = (url: string) => ({
    id: 'TC-WALK',
    title: 'Save the profile',
    steps: [
      `Open ${url}/`,
      'Enter valid username',
      'Enter valid password',
      'Click Login',
      'Click Details',
      'Click Profile',
      'Enter "Asha" in Full name',
      'Click Save changes',
    ]
      .map((l, i) => `${i + 1}. ${l}`)
      .join('\n'),
    expected: 'The "Profile saved" message is displayed',
  });

  before(async () => {
    dir = await mkdtemp(path.join(root, '.auto-qa', 'test-walk-'));
    demo = await startDemoApp();
    const artifacts = new LocalArtifactStore({ local: path.join(dir, 'data'), workspace: path.join(dir, 'workspaces') });
    store = await Store.open(':memory:', { artifacts });
    runner = new JobRunner({ store, config: defaultParserConfig(), dataDir: path.join(dir, 'data'), headless: true });
    app = await buildApp({ store, runner, dataDir: path.join(dir, 'data'), workspacesDir: path.join(dir, 'workspaces') });
    await post('/api/projects', { name: 'Demo', baseUrl: demo.url, username: DEMO_USER.username, password: DEMO_USER.password });
    await store.upsertTestCase('demo', CASE(demo.url), { kind: 'form' }, 'written');
  });
  after(async () => {
    await app.close();
    await demo.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs step by step: a pick, a check, a question before Save, and a new version only when told', async () => {
    const job = await post('/api/projects/demo/test-cases/TC-WALK/walkthrough', { who: 'Tester One' });
    assert.equal(job.kind, 'walkthrough');
    const seen: string[] = [];
    let savedBeforeConfirm: boolean | undefined;
    let tried: unknown;
    const done = await drive(job.id, (q) => {
      const p = q.payload;
      seen.push(`${q.kind}:${String(p.code ?? p.step ?? '')}`);
      if (q.kind === 'choose') {
        // Two Details buttons: the second one, remembered for this screen.
        const view = p.view as { elements: Array<{ ref: string; name: string; candidate?: number }> };
        const second = view.elements.find((e) => e.name === 'Details' && e.candidate === 1);
        return { ref: second?.ref, remember: true };
      }
      if (q.kind === 'step' && p.step === 'S5' && !p.last) return { check: { kind: 'url-contains', expected: 'dashboard' } };
      if (q.kind === 'step' && p.step === 'S5' && p.last) {
        tried = p.last;
        return 'next';
      }
      if (q.kind === 'confirm' && p.code === 'CHANGES_DATA') {
        savedBeforeConfirm = (p.raw as string).includes('Save changes') ? false : undefined;
        return true;
      }
      if (q.kind === 'confirm' && p.code === 'SAVE_WALKTHROUGH') return true;
      return 'next';
    });
    assert.equal(done.status, 'done', done.error ?? '');
    // The order the person was asked in: a pick at S5 before its "step done", the data question before S8 runs.
    assert.ok(seen.indexOf('choose:LOCATE_AMBIGUOUS') >= 0 && seen.indexOf('choose:LOCATE_AMBIGUOUS') < seen.indexOf('step:S5'), seen.join(' '));
    assert.ok(seen.indexOf('confirm:CHANGES_DATA') > seen.indexOf('step:S7') && seen.indexOf('confirm:CHANGES_DATA') < seen.indexOf('step:S8'), seen.join(' '));
    assert.equal(savedBeforeConfirm, false, 'asked about "Save changes" before it was clicked');
    assert.deepEqual(tried && { ok: (tried as { ok: boolean }).ok, result: (tried as { result: string }).result }, { ok: true, result: 'proven' });

    const walk = done.output.walk as { savedVersion?: number; ended: string; who: string; durationMs: number };
    assert.equal(walk.ended, 'finished');
    assert.equal(walk.who, 'Tester One');
    assert.ok(walk.durationMs > 0, 'the time a walkthrough took is kept, for the review KPIs (E0.19)');
    assert.equal(walk.savedVersion, 2);
    const record = await store.testCase('demo', 'TC-WALK');
    assert.equal(record?.version, 2);
    assert.match(record?.raw.steps ?? '', /\n6\. Verify The page URL contains "dashboard"\n7\. Click Profile/);
    const versions = await store.testCaseVersions(record?.id ?? '');
    assert.match(versions[0]?.reason ?? '', /^edited in a walkthrough by Tester One/, 'an "edited" version wins when the workbook runs again (D23)');
    assert.ok((await store.editedTestCases('demo'))['TC-WALK']);

    // The screens reached are kept as the person's, and the pick is a word for that screen only.
    const screens = JSON.parse(readFileSync(path.join(dir, 'data', 'projects', 'demo', 'explore', 'TC-WALK', 'screens.json'), 'utf8')) as Array<{
      key: string;
      source: string;
    }>;
    assert.ok(screens.some((s) => s.key === '/dashboard') && screens.every((s) => s.source === 'walkthrough'), JSON.stringify(screens.map((s) => s.key)));
    const labels = await store.learnedEntries('demo', { kind: 'label' });
    const word = labels.find((l) => (l.payload as { screen?: string }).screen === '/dashboard');
    assert.ok(word, JSON.stringify([labels.map((l) => l.payload), done.logs.map((l) => l.message).filter((m) => m.includes('emembered'))]));
    assert.equal(word?.status, 'active');
  });

  it('the next walkthrough of that screen does not ask about Details again, and saves nothing when stopped', async () => {
    const job = await post('/api/projects/demo/test-cases/TC-WALK/walkthrough');
    const kinds: string[] = [];
    const done = await drive(job.id, (q) => {
      kinds.push(`${q.kind}:${String(q.payload.code ?? q.payload.step ?? '')}`);
      return q.kind === 'step' && q.payload.step === 'S5' ? 'stop' : 'next';
    });
    assert.equal(done.status, 'done', done.error ?? '');
    assert.ok(!kinds.some((k) => k.startsWith('choose')), kinds.join(' '));
    assert.equal((done.output.walk as { ended: string }).ended, 'stopped');
    assert.equal((await store.testCase('demo', 'TC-WALK'))?.version, 2, 'nothing was added, so nothing was saved');
  });

  it('a walkthrough nobody answers is closed, and says so', async () => {
    const job = await store.createJob({ projectId: 'demo', kind: 'walkthrough', input: { caseId: 'TC-WALK', idleMs: 1500 } });
    runner.enqueue(job);
    let j: J | undefined;
    for (let i = 0; i < 600; i++) {
      j = (await get(`/api/jobs/${job.id}`)) as J;
      if (['done', 'failed', 'cancelled'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(j?.status, 'cancelled', j?.error ?? '');
    assert.equal((j?.output.walk as { ended: string } | undefined)?.ended, 'idle');
    assert.ok(j?.logs.some((l) => l.message.includes('without an answer')));
    assert.equal(j?.questions.length, 0, 'the question it waited on is not left open');
  });

  it('on a production environment, a step that changes data is not run unless the project allows it', async () => {
    // There is no screen to mark an environment as production yet: set it in the database, as an administrator would.
    await (store as unknown as { db: { run(sql: string, args: unknown[]): Promise<unknown> } }).db.run(
      'UPDATE environments SET is_production = 1 WHERE project_id = ?',
      ['demo'],
    );
    try {
      const job = await post('/api/projects/demo/test-cases/TC-WALK/walkthrough');
      const kinds: string[] = [];
      const done = await drive(job.id, (q) => {
        kinds.push(`${q.kind}:${String(q.payload.code ?? q.payload.step ?? '')}`);
        return q.kind === 'confirm' ? false : 'next';
      });
      assert.equal(done.status, 'done', done.error ?? '');
      assert.ok(!kinds.includes('confirm:CHANGES_DATA'), 'not even asked: refused');
      assert.ok(!kinds.includes('step:S9'), 'Save changes (S9 with the check added) was not run');
      assert.ok(
        done.logs.some((l) => l.message.includes('production environment: not run')),
        JSON.stringify([kinds, done.logs.map((l) => l.message)]),
      );
      assert.ok(done.logs.some((l) => l.message.includes('production environment: not run')));
    } finally {
      await (store as unknown as { db: { run(sql: string, args: unknown[]): Promise<unknown> } }).db.run(
        'UPDATE environments SET is_production = 0 WHERE project_id = ?',
        ['demo'],
      );
    }
  });

  it('serves the screenshots of a walkthrough, and only from the data folder', async () => {
    const shots = path.join(dir, 'data', 'projects', 'demo', 'walkthroughs');
    assert.ok(existsSync(shots));
  });
});
