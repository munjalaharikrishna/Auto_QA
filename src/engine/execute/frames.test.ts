import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { RawTestCase } from '../../model/test-model.js';
import {
  compileCase,
  type ExecutionSession,
  executePlan,
  inspectPage,
  judge,
  openExecutionSession,
  planActions,
  type RunTrace,
  renderTrace,
} from '../index.js';
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
    const raw: RawTestCase = {
      id: 'T-FRAME',
      title: 'A frame',
      steps: lines.map((l, i) => `${i + 1}. ${l}`).join('\n'),
      expected: 'The Employee Information heading is displayed',
    };
    const c = await compileCase(raw, { env: {} });
    assert.ok(c.ir && c.plan, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
    return executePlan({ plan: planActions(c.ir, c.plan), values: c.values, pages: c.pages }, { mcp: session.port, page: session.page, baseUrl: base });
  }

  /** A check is judged on a page that is a frame inside a page: what the frame shows is shown. */
  async function judged(expected: string) {
    const raw: RawTestCase = { id: 'T-TRAP', title: 'A frame trap', steps: `1. Open ${base}/`, expected };
    const c = await compileCase(raw, { env: {} });
    assert.ok(c.ir && c.plan, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(c.ir, c.plan), values: c.values, pages: c.pages },
      { mcp: session.port, page: session.page, baseUrl: base },
    );
    const verdict = judge({ compile: c, trace });
    await session.reset();
    return verdict;
  }

  // E0.12 (S1): "X is not displayed" can pass only when every frame was looked at. A check that cannot see inside a frame would find
  // nothing there and call it absent, which is true of any page whose content is in a frame.
  it('TRAP: "not displayed" is not a PASS for what the frame shows (a heading, a button, a field)', async () => {
    for (const expected of [
      'The Employee Information heading is not displayed',
      'The Save button is not displayed',
      'The Employee Name field is not displayed',
    ]) {
      const v = await judged(expected);
      assert.notEqual(v.verdict, 'PASS', `${expected}: it is in the frame, so "not displayed" is false`);
      assert.equal(v.evaluations[0]?.result, 'disproven', `${expected}: ${v.evaluations[0]?.actual}`);
    }
  });

  it('what is shown in the frame is shown: "displayed" is a PASS', async () => {
    assert.equal((await judged('The Employee Information heading is displayed')).verdict, 'PASS');
    assert.equal((await judged('The Save button is displayed')).verdict, 'PASS');
  });

  it('"not displayed" of a name that no page of the run showed is not a PASS either: it cannot be told from a typo (EX-08)', async () => {
    const absent = await judged('The Delete Everything button is not displayed');
    assert.equal(absent.verdict, 'NEEDS_REVIEW', absent.reason);
    assert.equal(absent.evaluations[0]?.doubt, 'VACUOUS');
  });

  it('reads the elements and the text of the frame, and says which frame they are in', async () => {
    await session.page.goto(base);
    await waitSettled(session.page);
    const elements = await inspectPage(session.page, { includeText: true });
    const name = elements.find((e) => e.id === 'name');
    assert.ok(name, 'the field in the frame is found');
    assert.equal(name.frame.length, 1);
    assert.ok(
      elements.some((e) => e.frame.length === 0 && e.text === 'Shell'),
      'the page itself is read too',
    );
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
    assert.ok(
      last?.after?.lines.some((l) => l.includes('Saved Asha Rao')),
      `the reloaded frame is waited for: ${last?.after?.lines.join(' | ')}`,
    );
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
