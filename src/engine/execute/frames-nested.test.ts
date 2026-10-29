import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { RawTestCase } from '../../model/test-model.js';
import { compileCase, type ExecutionSession, executePlan, inspectPageDetailed, judge, openExecutionSession, planActions, type RunTrace } from '../index.js';
import { observe } from './observe.js';
import { waitSettled } from './waits.js';

/**
 * E0.13: a screen two frames deep (shell > menu frame > content frame), the same name in two frames, and a content frame that reloads
 * slowly while the engine reads it. Needs Google Chrome.
 */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

const OUTER = `<!doctype html><title>Shell</title><h1>Shell</h1><button>Help</button>
<iframe name="mid" src="/mid" style="width:800px;height:500px"></iframe>`;
const MID = `<!doctype html><title>Mid</title><h3>Menu</h3><button>Help</button>
<iframe name="inner" src="/inner" style="width:700px;height:300px"></iframe>`;
const inner = (saved?: string): string => `<!doctype html><title>Inner</title>
<h2>Employee Information</h2>
${saved ? `<p role="alert">Saved ${saved}</p>` : ''}
<form method="get" action="/saved">
  <label for="name">Employee Name</label><input id="name" name="name" type="text">
  <button type="submit">Save</button>
</form>`;

describe('a screen two frames deep (E0.13)', { skip }, () => {
  let server: Server;
  let base: string;
  let session: ExecutionSession;
  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/') res.end(OUTER);
      else if (url.pathname === '/mid') res.end(MID);
      else if (url.pathname === '/saved') setTimeout(() => res.end(inner(url.searchParams.get('name') ?? '')), 400);
      else res.end(inner());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await new Promise((r) => server?.close(r));
  });

  async function compile(steps: string[], expected: string) {
    const raw: RawTestCase = { id: 'T-NEST', title: 'Nested', steps: steps.map((l, i) => `${i + 1}. ${l}`).join('\n'), expected };
    const c = await compileCase(raw, { env: {} });
    assert.ok(c.ir && c.plan, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
    return { c, ir: c.ir, plan: c.plan };
  }

  async function run(steps: string[], expected: string): Promise<{ trace: RunTrace; verdict: ReturnType<typeof judge> }> {
    const { c, ir, plan } = await compile(steps, expected);
    const trace = await executePlan(
      { plan: planActions(ir, plan), values: c.values, pages: c.pages },
      { mcp: session.port, page: session.page, baseUrl: base },
    );
    const verdict = judge({ compile: c, trace });
    await session.reset();
    return { trace, verdict };
  }

  it('reads the field two frames deep, with a frame path of two, and says which screen the content frame is', async () => {
    await session.page.goto(base);
    await waitSettled(session.page);
    const r = await inspectPageDetailed(session.page, { includeText: true });
    const name = r.elements.find((e) => e.id === 'name');
    assert.ok(name, 'the field is found');
    assert.equal(name.frame.length, 2);
    assert.deepEqual(r.unread, []);
    assert.ok(name.frameUrl?.endsWith('/inner'), String(name.frameUrl));
    const seen = await observe(session.page);
    assert.ok(seen.contentUrl?.endsWith('/inner'), `the screen is the innermost frame: ${seen.contentUrl}`);
    assert.equal(seen.unreadFrames?.length ?? 0, 0);
  });

  it('enters a value and clicks Save two frames deep, and waits for the reload', async () => {
    const { trace } = await run(
      [`Open ${base}`, "Enter 'Asha Rao' in the Employee Name field", 'Click the Save button'],
      'The Employee Information heading is displayed',
    );
    assert.deepEqual(
      trace.steps.map((s) => s.status),
      trace.steps.map(() => 'done'),
    );
    const last = trace.steps[trace.steps.length - 1];
    assert.ok(
      last?.after?.lines.some((l) => l.includes('Saved Asha Rao')),
      `${last?.after?.lines.join(' | ')}`,
    );
  });

  it('TRAP: "not displayed" of what the nested frame shows is not a PASS', async () => {
    const { verdict } = await run([`Open ${base}`], 'The Save button is not displayed');
    assert.notEqual(verdict.verdict, 'PASS');
    assert.equal(verdict.evaluations[0]?.result, 'disproven');
  });

  it('a name that two frames both have is not guessed: the Help button is ambiguous, never clicked at random', async () => {
    const { trace } = await run([`Open ${base}`, "Click the 'Help' button"], 'The Employee Information heading is displayed');
    const last = trace.steps[trace.steps.length - 1];
    assert.notEqual(last?.status, 'done', 'two Help buttons in two frames: nothing to choose by');
  });

  it('the slow reload is read whole, run after run: no step fails on a frame that was reloading', async () => {
    for (let i = 0; i < 6; i++) {
      const { trace, verdict } = await run(
        [`Open ${base}`, `Enter 'Person ${i}' in the Employee Name field`, 'Click the Save button'],
        `The Employee Information heading is displayed`,
      );
      assert.equal(trace.status, 'completed', `run ${i}: ${JSON.stringify(trace.stoppedAt)}`);
      assert.equal(verdict.verdict, 'PASS', `run ${i}: ${verdict.reason}`);
    }
  });
});
