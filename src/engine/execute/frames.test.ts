import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { RawTestCase } from '../../model/test-model.js';
import { compileCase, type ExecutionSession, executePlan, inspectPage, openExecutionSession, planActions, type RunTrace, renderTrace } from '../index.js';
import { observe } from './observe.js';
import { waitForText, waitSettled } from './waits.js';

/**
 * UI-01: a screen shown inside an iframe, as OrangeHRM shows its PIM pages. The outer page holds a menu and the frame
 * `rightMenu`; Save reloads the frame once the server answers, slowly, as that application does. Needs Google Chrome.
 */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

const OUTER = `<!doctype html><title>Shell</title><h1>Shell</h1><ul><li><a href="#">PIM</a></li></ul>
<iframe id="rightMenu" name="rightMenu" src="/form" style="width:700px;height:400px"></iframe>`;

const form = (saved?: string, rows = ['Anita Roy', 'Ben Cole']): string => `<!doctype html><title>Inner</title>
<h2>Employee Information</h2>
${saved ? `<p role="alert">Saved ${saved}</p>` : ''}
<form method="get" action="/saved">
  <label for="name">Employee Name</label><input id="name" name="name" type="text">
  <button type="submit">Save</button>
</form>
<table><tr><th>Name</th><th>Action</th></tr>${rows.map((r) => `<tr><td>${r}</td><td><button>Edit</button></td></tr>`).join('')}</table>`;

describe('a screen inside an iframe (UI-01)', { skip }, () => {
  let server: Server;
  let base: string;
  let session: ExecutionSession;
  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/') res.end(OUTER);
      else if (url.pathname === '/saved') setTimeout(() => res.end(form(url.searchParams.get('name') ?? '')), 1500);
      else res.end(form());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await new Promise((r) => server?.close(r));
  });

  async function run(lines: string[]): Promise<RunTrace> {
    const raw: RawTestCase = { id: 'T-FRAME', title: 'A frame', steps: lines.map((l, i) => `${i + 1}. ${l}`).join('\n'), expected: 'The Employee Information heading is displayed' };
    const c = await compileCase(raw, { env: {} });
    assert.ok(c.ir && c.plan, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
    return executePlan({ plan: planActions(c.ir, c.plan), values: c.values, pages: c.pages }, { mcp: session.port, page: session.page, baseUrl: base });
  }

  it('reads the elements and the text of the frame, and says which frame they are in', async () => {
    await session.page.goto(base);
    await waitSettled(session.page);
    const elements = await inspectPage(session.page, { includeText: true });
    const name = elements.find((e) => e.id === 'name');
    assert.ok(name, 'the field in the frame is found');
    assert.equal(name.frame.length, 1);
    assert.ok(elements.some((e) => e.frame.length === 0 && e.text === 'Shell'), 'the page itself is read too');
    assert.ok(new Set(elements.map((e) => e.index)).size === elements.length, 'indexes are unique across frames');
    const seen = await observe(session.page);
    assert.ok(seen.lines.includes('Employee Information'), seen.lines.join(' | '));
    assert.ok(await waitForText(session.page, 'Employee Information', 2000));
    assert.equal(await waitForText(session.page, 'Nothing like this', 300), false);
  });

  it('enters a value and clicks Save in the frame, then waits for the frame to reload', async () => {
    const trace = await run([`Open ${base}`, "Enter 'Asha Rao' in the Employee Name field", 'Click the Save button']);
    assert.deepEqual(
      trace.steps.map((s) => s.status),
      trace.steps.map(() => 'done'),
      renderTrace(trace),
    );
    const last = trace.steps[trace.steps.length - 1];
    assert.ok(last?.after?.lines.some((l) => l.includes('Saved Asha Rao')), `the reloaded frame is waited for: ${last?.after?.lines.join(' | ')}`);
    assert.ok(last?.located?.selector.includes('enter-frame'), last?.located?.selector ?? '');
  });

  it('acts on a row of a table that is in the frame', async () => {
    const trace = await run([`Open ${base}`, 'Click the Edit button for Ben Cole']);
    assert.deepEqual(
      trace.steps.map((s) => s.status),
      trace.steps.map(() => 'done'),
      renderTrace(trace),
    );
  });
});
