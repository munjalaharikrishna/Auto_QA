import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RawTestCase } from '../../model/test-model.js';
import {
  compileCase,
  type ExecutionSession,
  executePlan,
  openExecutionSession,
  type PickRequest,
  planActions,
  type RunTrace,
  type StepHook,
} from '../index.js';
import { keepScreens } from './capture.js';

/**
 * E0.14a: stepping through a run (the hook a walkthrough uses) and run capture on a real browser. Without a hook the run is exactly as
 * before; with one, it waits before and after every step, can be stopped, and asks for a pick where it would have stopped. Needs Chrome.
 */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

let label = 'Code';
const page = (): string => `<!doctype html><title>Form</title><h1>Employee</h1>
<label for="code">${label}</label><input id="code" name="code">
<p id="out"></p>
<button onclick="document.getElementById('out').textContent='saved A'">Save</button>
<button onclick="document.getElementById('out').textContent='saved B'">Save</button>
<a href="/next">Next</a>`;
const FRAMED = `<!doctype html><title>Shell</title><div style="height:150px">Menu</div>
<iframe id="content" name="content" src="/inner" style="position:absolute;left:300px;top:150px;width:500px;height:300px;border:0"></iframe>`;
const INNER = `<!doctype html><title>Inner</title><p id="out"></p><button onclick="document.getElementById('out').textContent='inner saved'">Store</button>`;

describe('E0.14a: stepping through a run, and run capture', { skip }, () => {
  let server: Server;
  let base: string;
  let session: ExecutionSession;
  let dir: string;
  before(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      res.end(p === '/framed' ? FRAMED : p === '/inner' ? INNER : p === '/next' ? '<!doctype html><title>Next</title><h1>Next</h1>' : page());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    session = await openExecutionSession();
    dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-walk-'));
  });
  after(async () => {
    await session?.close();
    await new Promise((r) => server?.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  async function run(lines: string[], hook?: StepHook, expected = 'The Employee heading is displayed', start = '/'): Promise<RunTrace> {
    const raw: RawTestCase = { id: 'T-WALK', title: 'Walk', steps: [`Open ${base}${start}`, ...lines].map((l, i) => `${i + 1}. ${l}`).join('\n'), expected };
    const c = await compileCase(raw, { env: {} });
    assert.ok(c.ir && c.plan, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(c.ir, c.plan), values: c.values, pages: c.pages },
      { mcp: session.port, page: session.page, baseUrl: base, screenshotDir: dir, ...(hook ? { hook } : {}) },
    );
    await session.reset();
    return trace;
  }

  it('asks before and after every step, in order, and goes on', async () => {
    const seen: string[] = [];
    const trace = await run(['Enter "7" in Code', 'Click Next'], {
      before: async (chain) => {
        seen.push(`before ${chain.step}`);
        return 'go';
      },
      after: async (rec) => {
        seen.push(`after ${rec.step} ${rec.status}`);
        return 'go';
      },
    });
    assert.equal(trace.status, 'completed');
    assert.deepEqual(seen, ['before S1', 'after S1 done', 'before S2', 'after S2 done', 'before S3', 'after S3 done']);
  });

  it('stops where the person says: the steps after it are not run, and the trace says a person stopped it', async () => {
    const trace = await run(['Enter "7" in Code', 'Click Next'], { after: async (rec) => (rec.step === 'S2' ? 'stop' : 'go') });
    assert.equal(trace.status, 'blocked');
    assert.equal(trace.stoppedAt?.code, 'STOPPED');
    assert.equal(trace.stoppedAt?.step, 'S3');
    assert.deepEqual(
      trace.steps.map((s) => s.status),
      ['done', 'done', 'skipped'],
    );
    const early = await run(['Click Next'], { before: async (chain) => (chain.step === 'S2' ? 'stop' : 'go') });
    assert.deepEqual(
      early.steps.map((s) => s.status),
      ['done', 'skipped'],
    );
  });

  it('without a person, two Save buttons stop the step as always; with one, the pick is used and said so', async () => {
    const alone = await run(['Click Save']);
    assert.equal(alone.steps[1]?.code, 'LOCATE_AMBIGUOUS');
    let asked: PickRequest | undefined;
    const picked = await run(['Click Save'], {
      pick: async (request) => {
        asked = request;
        const second = request.view.elements.find((e) => e.candidate === 1);
        return second ? { ref: second.ref } : undefined;
      },
    });
    assert.equal(picked.status, 'completed', JSON.stringify(picked.stoppedAt));
    assert.equal(picked.steps[1]?.located?.picked, true);
    assert.ok(picked.steps[1]?.after?.lines.includes('saved B'), 'the button the person picked was clicked');
    assert.equal(asked?.code, 'LOCATE_AMBIGUOUS');
    assert.equal(asked?.view.elements.filter((e) => e.candidate !== undefined).length, 2, 'both Save buttons are numbered');
    assert.ok(asked?.view.screenshot && existsSync(asked.view.screenshot), 'the person sees the page as it is');
  });

  it('a step that finds nothing asks too; no answer leaves it blocked as before', async () => {
    const none = await run(['Click Publish'], { pick: async () => undefined });
    assert.equal(none.steps[1]?.code, 'LOCATE_NOT_FOUND');
    const shown = await run(['Click Publish'], { pick: async (r) => ({ ref: r.view.elements.find((e) => e.name === 'Next')?.ref ?? '' }) });
    assert.equal(shown.steps[1]?.status, 'done');
    assert.equal(shown.steps[1]?.after?.title, 'Next');
  });

  it('draws an element inside a frame where it is on the page, and clicks the one picked there', async () => {
    let request: PickRequest | undefined;
    const trace = await run(
      ['Click Publish'],
      {
        pick: async (r) => {
          request = r;
          const store = r.view.elements.find((e) => e.name === 'Store');
          return store ? { ref: store.ref } : undefined;
        },
      },
      'The Store button is displayed',
      '/framed',
    );
    const store = request?.view.elements.find((e) => e.name === 'Store');
    assert.ok(store && store.box.x >= 300 && store.box.y >= 150, JSON.stringify(store?.box));
    assert.equal(trace.steps[1]?.status, 'done');
    assert.ok(trace.steps[1]?.after?.lines.includes('inner saved'));
  });

  it('run capture: a label renamed on the application is one rename the next time the case runs', async () => {
    const caseDir = path.join(dir, 'capture', 'T-WALK');
    label = 'Code';
    const first = await keepScreens(caseDir, await run(['Enter "7" in Code']));
    assert.deepEqual(first.changes, [], 'the first capture is not a change');
    const form = first.screens.find((s) => s.elements.some((e) => e.htmlId === 'code'));
    assert.equal(form?.elements.find((e) => e.htmlId === 'code')?.label, 'Code');
    label = 'Employee Id';
    const second = await keepScreens(caseDir, await run(['Enter "7" in Employee Id']));
    assert.deepEqual(
      second.changes.map((c) => `${c.change}: ${c.what}`),
      ['renamed: textbox "Code" → "Employee Id"'],
    );
    label = 'Code';
  });
});
