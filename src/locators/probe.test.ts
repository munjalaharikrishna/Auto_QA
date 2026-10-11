import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { defaultParserConfig } from '../parser/config.js';
import { type LocateResult, locate } from './engine.js';
import type { TargetQuery } from './match.js';
import { openSession, type Session } from './session.js';

/**
 * The Locator Probe and engine against a real Chrome shared with Playwright MCP (D7).
 * Uses a local page, so it needs Google Chrome but no internet. Set AUTO_QA_SKIP_BROWSER=1 to skip.
 */

const PAGE = `<!doctype html>
<title>Sign in</title>
<h1>Welcome</h1>
<form id="signin">
  <label for="email">Email</label> <input id="email" name="email">
  <input name="q" placeholder="Search">
  <button id="btn-8812734" type="submit">Sign in</button>
  <button disabled>Delete</button>
  <button>Save</button> <button>Save</button>
  <input type="checkbox"> Remember me
  <input type="file" aria-label="Upload photo">
</form>
<p>Help</p><a href="#help">Help</a>
<button data-qa="cancel">Cancel</button>`;

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;
const config = defaultParserConfig();
const q = (kind: TargetQuery['kind'], target: string, more: Partial<TargetQuery> = {}): TargetQuery => ({ kind, target, alternatives: [], ...more });

describe('Locator Probe on a shared browser (FR-LO-06, FR-LO-08)', { skip }, () => {
  let server: http.Server;
  let session: Session;
  const run = (query: TargetQuery, allRungs = false): Promise<LocateResult> =>
    locate(query, session.mcp, session.probe, { config, testIdAttribute: 'data-qa', allRungs });
  const code = (r: LocateResult) => (r.status === 'resolved' ? r.locator.code : `${r.status}: ${r.code}`);

  before(async () => {
    server = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    session = await openSession({ testIdAttribute: 'data-qa' });
    await session.mcp.navigate(`http://127.0.0.1:${(server.address() as AddressInfo).port}/signin`);
  });

  after(async () => {
    await session?.close();
    server?.close();
  });

  it('prefers the project test id attribute (FR-LO-09)', async () => {
    assert.equal(code(await run(q('click', 'Cancel'))), "getByTestId('cancel')");
  });

  it('falls back to role + name, then label', async () => {
    const r = await run(q('fill', 'Email'), true);
    assert.equal(code(r), "getByRole('textbox', { name: 'Email', exact: true })");
    assert.ok(r.tried.some((v) => v.ok && v.code === "getByLabel('Email', { exact: true })"));
    assert.ok(r.tried.some((v) => v.ok && v.code === "locator('#email')"));
  });

  it('reports why a rung failed', async () => {
    // "Help" is both a paragraph and a link, so getByText finds two elements.
    const r = await run(q('click', 'Help'), true);
    assert.equal(code(r), "getByRole('link', { name: 'Help', exact: true })");
    assert.ok(r.tried.some((v) => !v.ok && v.code === "getByText('Help', { exact: true })" && v.reason === 'matches 2 elements'));
  });

  it('does not use a generated-looking id', async () => {
    const r = await run(q('click', 'Sign in'), true);
    assert.equal(code(r), "getByRole('button', { name: 'Sign in', exact: true })");
    assert.ok(!r.tried.some((v) => v.code.includes('btn-8812734')));
  });

  it('never stores a locator the action cannot use', async () => {
    const r = await run(q('click', 'Delete'));
    assert.equal(r.status, 'needs-review');
    assert.equal(r.status === 'needs-review' && r.code, 'NO_VALID_LOCATOR');
    assert.ok(r.tried.every((v) => !v.ok));
    assert.match(r.tried[0].reason ?? '', /not possible/);
  });

  it('leaves two equal buttons to the tester', async () => {
    const r = await run(q('click', 'Save'));
    assert.equal(r.status === 'needs-review' && r.code, 'AMBIGUOUS');
  });

  it('finds unlabeled and hidden-name elements', async () => {
    // The only checkbox on the page, so its role alone is unique.
    assert.equal(code(await run(q('check', 'Remember me'))), "getByRole('checkbox')");
    assert.equal(code(await run(q('upload', 'Upload photo'))), "getByRole('button', { name: 'Upload photo', exact: true })");
    assert.equal(code(await run(q('fill', 'Search'))), "getByRole('textbox', { name: 'Search', exact: true })");
  });

  it('stores a fingerprint and the page (FR-LO-10, FR-LO-11)', async () => {
    const r = await run(q('fill', 'Email'));
    assert.equal(r.status, 'resolved');
    if (r.status !== 'resolved') return;
    assert.deepEqual(r.page, { name: 'SigninPage', path: '/signin', title: 'Sign in' });
    assert.deepEqual(r.fingerprint, { role: 'textbox', name: 'Email', tag: 'input', label: 'Email', id: 'email', nameAttr: 'email', form: 'signin' });
  });
});
