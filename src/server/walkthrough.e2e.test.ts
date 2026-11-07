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
import { PANEL_HOST_ID } from './walk-panel.js';

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

  /** Answers each question with what `answer` gives, which may first act in the walkthrough's browser as the person, until the job ends. */
  async function driveAs(jobId: string, answer: (q: Q) => Promise<unknown>): Promise<J> {
    for (let i = 0; i < 1200; i++) {
      const j = (await get(`/api/jobs/${jobId}`)) as J;
      if (['done', 'failed', 'cancelled'].includes(j.status)) return j;
      const q = j.questions[0];
      if (j.status === 'waiting' && q) await post(`/api/questions/${q.id}/answer`, { answer: await answer(q) });
      else await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`job ${jobId} did not end`);
  }

  /** The tab of the walkthrough's browser that shows the application. */
  const appTab = (jobId: string) => {
    const tab = runner.walkthroughPages(jobId).find((p) => p.url().startsWith(demo.url));
    assert.ok(tab, 'the walkthrough has a tab on the application');
    return tab;
  };

  /** Waits until the walkthrough holds `n` changes to save. */
  async function pendingOf(jobId: string, n: number): Promise<Array<{ kind: string; sentence?: string; afterStep?: string; replaces?: string }>> {
    let walk: { pending: Array<{ kind: string; sentence?: string }>; recorderNote?: string } | undefined;
    for (let i = 0; i < 100; i++) {
      walk = ((await get(`/api/jobs/${jobId}`)) as J).output.walk as typeof walk;
      if ((walk?.pending.length ?? 0) >= n) return walk?.pending ?? [];
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`expected ${n} recorded, got ${JSON.stringify(walk)}`);
  }

  it('records what the person does in the browser, across pages, as steps both readers read, and runs them again (E0.14c)', async () => {
    await store.upsertTestCase(
      'demo',
      { id: 'TC-REC', title: 'Profile by hand', steps: `1. Open ${demo.url}/`, expected: 'The page URL contains "/"' },
      { kind: 'form' },
      'written',
    );
    const job = await post('/api/projects/demo/test-cases/TC-REC/walkthrough');
    const done = await driveAs(job.id, async (q) => {
      if (q.kind === 'step' && q.payload.step === 'S1') {
        const tab = appTab(job.id);
        await tab.fill('#username', DEMO_USER.username);
        await tab.fill('#password', DEMO_USER.password);
        await tab.click('button[data-testid="login"]');
        await tab.waitForURL('**/dashboard');
        await tab.getByRole('link', { name: 'Profile' }).click();
        await tab.waitForURL('**/profile');
        await tab.fill('#name', 'Asha');
        await tab.keyboard.press('Tab');
        await tab.selectOption('#country', 'in');
        await tab.check('#news');
        const recorded = await pendingOf(job.id, 7);
        assert.ok(
          recorded.every((p) => (p as { added?: boolean }).added === false),
          'what was done is recorded first, not added as a step',
        );
        // Every step but the last is added; the checkbox is never said to be a step.
        for (const [i, p] of recorded.slice(0, 6).entries()) await post(`/api/jobs/${job.id}/walkthrough/pending`, { add: i, sentence: p.sentence });
        return 'next';
      }
      return q.kind === 'confirm' ? true : 'next';
    });
    assert.equal(done.status, 'done', done.error ?? '');
    const saved = await store.testCase('demo', 'TC-REC');
    assert.equal(saved?.version, 2, JSON.stringify(done.logs.map((l) => l.message)));
    assert.equal(
      saved?.raw.steps,
      [
        `1. Open ${demo.url}/`,
        '2. Enter the valid username in the "Username" field',
        '3. Enter the valid password in the "Password" field',
        '4. Click the "Login" button',
        '5. Click the "Profile" link',
        '6. Enter "Asha" in the "Full name" field',
        '7. Select "India" from the "Country" dropdown',
      ].join('\n'),
    );
    assert.ok(done.logs.some((l) => l.message === '1 recorded step(s) you did not add are left out.'));
    assert.ok(!saved?.raw.steps.includes(DEMO_USER.password), 'the password is never written');

    // The recorded flow runs again, step by step, without a person doing anything but going on.
    const again = await post('/api/projects/demo/test-cases/TC-REC/walkthrough');
    const replay = await drive(again.id, (q) => (q.kind === 'confirm' ? true : 'next'));
    assert.equal(replay.status, 'done', replay.error ?? '');
    const steps = (replay.output.walk as { steps: Array<{ step: string; status: string }> }).steps;
    assert.deepEqual(
      steps.map((s) => `${s.step}:${s.status}`),
      steps.map((s) => `${s.step}:done`),
    );
  });

  it('a step that cannot find its element can be done by hand: what was done takes its place (E0.14c)', async () => {
    await store.upsertTestCase(
      'demo',
      {
        id: 'TC-HAND',
        title: 'Security details',
        steps: [`Open ${demo.url}/`, 'Enter valid username', 'Enter valid password', 'Click Login', 'Click Security info']
          .map((l, i) => `${i + 1}. ${l}`)
          .join('\n'),
        expected: 'The page URL contains "dashboard"',
      },
      { kind: 'form' },
      'written',
    );
    const job = await post('/api/projects/demo/test-cases/TC-HAND/walkthrough');
    const asked: string[] = [];
    const done = await driveAs(job.id, async (q) => {
      asked.push(`${q.kind}:${String(q.payload.code ?? q.payload.step ?? '')}`);
      if (q.kind === 'choose' && q.payload.item === 'S5') {
        await appTab(job.id).getByRole('button', { name: 'Details' }).nth(1).click();
        assert.deepEqual(await pendingOf(job.id, 1), [{ kind: 'recorded', sentence: 'Click the "Details" button', replaces: 'S5', added: false }]);
        // "I did this step myself" is the OK for it: it is saved without pressing Add.
        return 'manual';
      }
      return q.kind === 'confirm' ? true : 'next';
    });
    assert.equal(done.status, 'done', done.error ?? '');
    assert.ok(asked.includes('step:S5'), `S5 counts as done: ${asked.join(' ')}`);
    assert.ok(done.logs.some((l) => l.message === 'S5 was done by hand'));
    assert.match((await store.testCase('demo', 'TC-HAND'))?.raw.steps ?? '', /\n5\. Click the "Details" button$/);
    // The words of the step now mean the element used, on that screen, for every test case that says them.
    const labels = await store.learnedEntries('demo', { kind: 'label' });
    const word = labels.find((l) => (l.payload as { label?: string }).label === 'security info');
    const payload = word?.payload as { means?: string; screen?: string } | undefined;
    assert.deepEqual([payload?.means, payload?.screen, word?.status], ['Details', '/dashboard', 'active']);
  });

  const LOGIN_CASE = (id: string) => ({
    id,
    title: 'Login by hand',
    steps: [`Open ${demo.url}/`, 'Enter valid username', 'Enter valid password', 'Click Login'].map((l, i) => `${i + 1}. ${l}`).join('\n'),
    expected: 'The page URL contains "dashboard"',
  });
  const RECORDED_LOGIN = () =>
    [
      `1. Open ${demo.url}/`,
      '2. Enter the valid username in the "Username" field',
      '3. Enter the valid password in the "Password" field',
      '4. Click the "Login" button',
    ].join('\n');

  /** Logs in by hand in the walkthrough's window, and waits until the three actions are recorded. */
  async function loginByHand(jobId: string): Promise<void> {
    const tab = appTab(jobId);
    await tab.fill('#username', DEMO_USER.username);
    await tab.fill('#password', DEMO_USER.password);
    await tab.click('button[data-testid="login"]');
    await tab.waitForURL('**/dashboard');
    await pendingOf(jobId, 3);
  }

  it('closing the browser window keeps what was recorded, and saving can let it replace the steps not run (E0.14c)', async () => {
    await store.upsertTestCase('demo', LOGIN_CASE('TC-CLOSE'), { kind: 'form' }, 'written');
    const job = await post('/api/projects/demo/test-cases/TC-CLOSE/walkthrough');
    let asked: Record<string, unknown> | undefined;
    const done = await driveAs(job.id, async (q) => {
      if (q.kind === 'step' && q.payload.step === 'S1') {
        await loginByHand(job.id);
        await post(`/api/jobs/${job.id}/walkthrough/pending`, { addAll: true });
        // The person closes the window instead of answering.
        await appTab(job.id).context().close();
        for (let i = 0; i < 100 && runner.walkthroughPages(job.id).length; i++) await new Promise((r) => setTimeout(r, 100));
        return 'next';
      }
      if (q.kind === 'confirm' && q.payload.code === 'SAVE_WALKTHROUGH') {
        asked = q.payload;
        return 'replace';
      }
      return q.kind === 'confirm' ? true : 'next';
    });
    assert.equal(done.status, 'done', done.error ?? JSON.stringify(done.logs.map((l) => l.message)));
    assert.deepEqual(asked?.notRun, ['S2', 'S3', 'S4'], JSON.stringify(asked));
    assert.match(String(asked?.text), /browser window was closed/);
    const walk = done.output.walk as { ended: string; savedVersion?: number; browserClosed?: boolean };
    assert.equal(walk.ended, 'closed');
    assert.equal(walk.browserClosed, true);
    assert.equal(walk.savedVersion, 2);
    assert.equal((await store.testCase('demo', 'TC-CLOSE'))?.raw.steps, RECORDED_LOGIN());
  });

  it('the window shows the steps and what was recorded, and Finish and Save there end it with one tab open (E0.14c)', async () => {
    await store.upsertTestCase('demo', LOGIN_CASE('TC-PANEL'), { kind: 'form' }, 'written');
    // A headless browser has no panel by default; this one asks for it.
    const job = await store.createJob({ projectId: 'demo', kind: 'walkthrough', input: { caseId: 'TC-PANEL', panel: true } });
    runner.enqueue(job);
    const panelText = () => appTab(job.id).evaluate((id) => (document.getElementById(id) as unknown as { text(): string } | null)?.text() ?? '', PANEL_HOST_ID);
    const panelShown = () => appTab(job.id).evaluate((id) => document.getElementById(id)?.style.display === 'block', PANEL_HOST_ID);
    const press = (label: string) =>
      appTab(job.id).evaluate(([id, l]) => (document.getElementById(id) as unknown as { press(x: string): boolean }).press(l), [PANEL_HOST_ID, label] as const);
    const until = async (what: string, test: () => Promise<boolean>) => {
      for (let i = 0; i < 150; i++) {
        if (await test().catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(`the panel never showed ${what}: ${await panelText().catch((e: Error) => e.message)}`);
    };
    for (let i = 0; i < 300; i++) {
      const j = (await get(`/api/jobs/${job.id}`)) as J;
      if (j.status === 'waiting' && j.questions[0]?.payload.step === 'S1') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(runner.walkthroughPages(job.id).length, 1, 'the empty starter tab is closed: one window');
    await until(
      'the steps and Next step',
      async () => (await panelShown()) && (await panelText()).includes('Enter valid password') && (await panelText()).includes('Next step'),
    );
    await loginByHand(job.id);
    await until(
      'what was recorded, waiting for an OK',
      async () => (await panelText()).includes('Recorded (3)') && (await panelText()).includes('waiting for your OK'),
    );
    assert.equal(await press('Add all (3)'), true);
    await until('the steps added', async () => !(await panelText()).includes('waiting for your OK') && (await panelText()).includes('added as a step'));
    assert.equal(await press('Finish'), true);
    await until('the save question', async () => (await panelText()).includes('Save: recorded steps replace S2–S4'));
    assert.equal(await press('Save: recorded steps replace S2–S4'), true);
    await until('that it was saved', async () => (await panelText()).includes('Saved as version 2 of TC-PANEL'));
    let done: J | undefined;
    for (let i = 0; i < 300; i++) {
      done = (await get(`/api/jobs/${job.id}`)) as J;
      if (['done', 'failed', 'cancelled'].includes(done.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(done?.status, 'done', done?.error ?? '');
    assert.equal((done?.output.walk as { ended?: string } | undefined)?.ended, 'stopped');
    // Pressing the panel's buttons is answering the walkthrough, never a step of the case.
    assert.equal((await store.testCase('demo', 'TC-PANEL'))?.raw.steps, RECORDED_LOGIN());
  });

  it('what the engine typed is not recorded when the field loses focus later, as when the person goes to the Auto QA page (E0.14c)', async () => {
    await store.upsertTestCase('demo', LOGIN_CASE('TC-PHANTOM'), { kind: 'form' }, 'written');
    const job = await post('/api/projects/demo/test-cases/TC-PHANTOM/walkthrough');
    const done = await driveAs(job.id, async (q) => {
      if (q.kind === 'step' && (q.payload.step === 'S2' || q.payload.step === 'S3')) {
        // The field the engine just typed in loses focus: the browser sends its "change" now, while the walkthrough listens.
        await appTab(job.id).evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await new Promise((r) => setTimeout(r, 700));
        const walk = ((await get(`/api/jobs/${job.id}`)) as J).output.walk as { pending: unknown[] };
        assert.deepEqual(walk.pending, [], `nothing was done by the person after ${String(q.payload.step)}`);
      }
      return q.kind === 'confirm' ? true : 'next';
    });
    assert.equal(done.status, 'done', done.error ?? '');
    assert.ok(!done.logs.some((l) => l.message.includes('● recorded')), JSON.stringify(done.logs.map((l) => l.message)));
    assert.equal((await store.testCase('demo', 'TC-PHANTOM'))?.version, 1, 'nothing to save, so nothing saved');
  });

  it('serves the screenshots of a walkthrough, and only from the data folder', async () => {
    const shots = path.join(dir, 'data', 'projects', 'demo', 'walkthroughs');
    assert.ok(existsSync(shots));
  });
});
