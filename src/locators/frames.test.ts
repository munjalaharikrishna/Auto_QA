import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Resolver } from '../explorer/controller.js';
import { pageBoxes } from '../explorer/frame-boxes.js';
import { flatten, parseSnapshot } from '../explorer/snapshot-parser.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { runCases } from '../pipeline/run-cases.js';
import { locate } from './engine.js';
import { buildLadder } from './ladder.js';
import { parseLocatorCode, spec, toCode } from './locator.js';
import type { TargetQuery } from './match.js';
import { openSession, type Session } from './session.js';

/**
 * Elements inside iframes (OrangeHRM puts its whole content in one). A page locator never looks inside a frame, so such an
 * element used to be found by the matcher but never accepted: every locator "matched nothing", and the tester's pick was
 * refused again and again. The boxes of frame elements were also measured from the frame, so the highlight was in the wrong place.
 * Needs Google Chrome, no internet. AUTO_QA_SKIP_BROWSER=1 skips the browser part.
 */

describe('locators inside frames (code and parsing)', () => {
  it('prints and reads the code for an element in a frame, nested frames included', () => {
    const s = { ...spec('getByRole', 'button', { name: 'Add', exact: true }), frame: ['iframe[name="rightMenu"]'] };
    assert.equal(toCode(s), `frameLocator('iframe[name="rightMenu"]').getByRole('button', { name: 'Add', exact: true })`);
    const nested = { ...spec('getByText', 'Hi'), frame: ['#outer', 'iframe >> nth=1'] };
    assert.equal(toCode(nested), `frameLocator('#outer').frameLocator('iframe >> nth=1').getByText('Hi')`);
    assert.deepEqual(parseLocatorCode(toCode(nested))?.frame, ['#outer', 'iframe >> nth=1']);
  });

  it("reads Playwright MCP's code for a frame element (it prints locator(…).contentFrame())", () => {
    const parsed = parseLocatorCode(`locator('iframe[name="rightMenu"]').contentFrame().getByRole('button', { name: 'Add' })`);
    assert.deepEqual(parsed?.frame, ['iframe[name="rightMenu"]']);
    assert.equal(parsed?.method, 'getByRole');
    assert.equal(parsed?.options?.name, 'Add');
    assert.deepEqual(parseLocatorCode(`page.frameLocator('#a').frameLocator('#b').getByLabel('Email').fill('x')`)?.frame, ['#a', '#b']);
    // Still refused: a chain that is not a frame, and a locator that is not followed by contentFrame().
    assert.equal(parseLocatorCode(`locator('form').getByRole('button', { name: 'Add' })`), undefined);
    assert.equal(parseLocatorCode(`locator('iframe').first().getByRole('button')`), undefined);
  });

  it('puts every rung of the ladder in the frame', () => {
    const node = { role: 'button', name: 'Add', ref: 'f2e2', attributes: {}, props: {}, depth: 0, children: [] };
    const facts = { tag: 'button', labels: [], text: 'Add', xpath: '/html/body/button' };
    const ladder = buildLadder(node, facts, [], ['iframe[name="x"]']);
    assert.ok(ladder.length > 1);
    assert.ok(ladder.every((s) => s.frame?.[0] === 'iframe[name="x"]' && toCode(s).startsWith(`frameLocator('iframe[name="x"]').`)));
  });
});

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;
const config = defaultParserConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const INNER = (extra = '') =>
  `<html><body style="margin:0"><button onclick="document.body.insertAdjacentHTML('beforeend','<p>Added</p>')">Add</button> <button>Delete</button><p>Employee list</p>${extra}</body></html>`;
const PAGES: Record<string, string> = {
  '/': `<html><body style="margin:0"><iframe name="menu" src="/menu" style="border:0;height:60px;width:600px;display:block"></iframe><iframe name="rightMenu" id="rightMenu" src="/inner" style="border:0;margin-top:40px;height:300px;width:600px;display:block"></iframe></body></html>`,
  '/menu': `<html><body style="margin:0"><a href="#">Admin</a> <a href="#">PIM</a></body></html>`,
  '/inner': INNER(),
  // two frames that both have an "Add" button: the tester has to pick one
  '/two': `<html><body style="margin:0"><iframe name="first" src="/inner" style="border:0;height:80px;width:400px;display:block"></iframe><iframe name="second" src="/inner" style="border:0;margin-top:30px;height:80px;width:400px;display:block"></iframe></body></html>`,
  // a frame inside a frame
  '/nested': `<html><body style="margin:0"><iframe name="mid" src="/mid" style="border:0;margin:20px 0 0 30px;height:200px;width:500px;display:block"></iframe></body></html>`,
  '/mid': `<html><body style="margin:0"><iframe name="deep" src="/inner" style="border:0;margin:50px 0 0 10px;height:100px;width:300px;display:block"></iframe></body></html>`,
};

describe('elements inside iframes', { skip }, () => {
  let server: http.Server;
  let session: Session;
  let url: string;
  const q = (kind: TargetQuery['kind'], target: string, more: Partial<TargetQuery> = {}): TargetQuery => ({ kind, target, alternatives: [], ...more });
  const open = async (route: string) => {
    await session.mcp.navigate(`${url}${route}`);
    await new Promise((r) => setTimeout(r, 600)); // the frames load after the page
  };
  const locateAdd = () => locate(q('click', 'Add'), session.mcp, session.probe, { config, testIdAttribute: 'data-testid' });

  before(async () => {
    server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[req.url ?? '/'] ?? PAGES['/']));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    session = await openSession();
  });
  after(async () => {
    await session?.close();
    server?.close();
  });

  it('accepts an element inside a frame, with a locator that goes through the frame', async () => {
    await open('/');
    const r = await locateAdd();
    assert.equal(r.status, 'resolved', r.status === 'needs-review' ? `${r.code}: ${r.text}` : '');
    if (r.status !== 'resolved') return;
    assert.equal(r.locator.code, `frameLocator('iframe[name="rightMenu"]').getByRole('button', { name: 'Add', exact: true })`);
    assert.ok(/^f\d+e\d+$/.test(r.match.node.ref ?? ''), 'the element is in a frame, as in the tester report');
  });

  it('goes through every frame of a nested one', async () => {
    await open('/nested');
    const r = await locateAdd();
    assert.equal(r.status, 'resolved', r.status === 'needs-review' ? `${r.code}: ${r.text}` : '');
    if (r.status === 'resolved')
      assert.equal(r.locator.code, `frameLocator('iframe[name="mid"]').frameLocator('iframe[name="deep"]').getByRole('button', { name: 'Add', exact: true })`);
  });

  it('shows frame elements where the screenshot has them, not at the top of the page', async () => {
    await open('/');
    const page = session.probe.page();
    const nodes = flatten(parseSnapshot(await page.ariaSnapshot({ mode: 'ai', boxes: true })));
    const add = nodes.find((n) => n.role === 'button' && n.name === 'Add');
    assert.ok(add?.ref);
    assert.match(String(add.attributes.box), /^0,0,/, 'the snapshot measures from the frame: this is the fault');
    const boxes = await pageBoxes(page, nodes);
    const real = await page.frameLocator('iframe[name="rightMenu"]').getByRole('button', { name: 'Add' }).boundingBox();
    assert.ok(real && real.y >= 100, 'the button really is 100px down');
    const shown = boxes.get(add.ref as string);
    assert.ok(shown);
    assert.ok(Math.abs(shown.y - real.y) < 1 && Math.abs(shown.x - real.x) < 1, `drawn at ${shown.x},${shown.y}, really at ${real.x},${real.y}`);
    // The page's own elements are not moved.
    const menu = nodes.find((n) => n.role === 'link' && n.name === 'Admin');
    assert.ok(menu?.ref && boxes.get(menu.ref)?.y === 0);
  });

  it('adds the offsets of nested frames', async () => {
    await open('/nested');
    const page = session.probe.page();
    const nodes = flatten(parseSnapshot(await page.ariaSnapshot({ mode: 'ai', boxes: true })));
    const add = nodes.find((n) => n.role === 'button' && n.name === 'Add');
    const boxes = await pageBoxes(page, nodes);
    const real = await page.frameLocator('iframe[name="mid"]').frameLocator('iframe[name="deep"]').getByRole('button', { name: 'Add' }).boundingBox();
    const shown = add?.ref ? boxes.get(add.ref) : undefined;
    assert.ok(
      real && shown && Math.abs(shown.y - real.y) < 1 && Math.abs(shown.x - real.x) < 1,
      `drawn ${JSON.stringify(shown)}, really ${JSON.stringify(real)}`,
    );
  });

  it('accepts the element the tester picks when two frames have a button of the same name', async () => {
    await session.mcp.navigate(`${url}/two`);
    await new Promise((r) => setTimeout(r, 600));
    const state = await session.mcp.snapshot();
    const first = await locate(q('click', 'Add'), session.mcp, session.probe, { config, testIdAttribute: 'data-testid' }, { state });
    assert.equal(first.status, 'needs-review', 'two equal buttons: the tester has to say which');
    if (first.status !== 'needs-review') return;
    assert.equal(first.code, 'AMBIGUOUS');
    // The tester clicks the second one on the screenshot.
    // (Frame numbers keep counting across page loads, so the second button is the second candidate, not "f2…".)
    const second = first.candidates[1]?.node;
    assert.ok(second && first.candidates.length === 2, `candidates: ${first.candidates.map((c) => c.node.ref).join(', ')}`);
    const picked = await locate(q('click', 'Add'), session.mcp, session.probe, { config, testIdAttribute: 'data-testid' }, { state, node: second });
    assert.equal(picked.status, 'resolved', picked.status === 'needs-review' ? `${picked.code}: ${picked.text}` : '');
    if (picked.status === 'resolved')
      assert.match(picked.locator.code, /^frameLocator\('iframe\[name="second"\]'\)\.getByRole\('button', \{ name: 'Add', exact: true \}\)/);
  });
});

describe('a test case whose element is inside a frame, end to end', { skip }, () => {
  let server: http.Server;
  const base = path.join(root, '.auto-qa', 'test-frames');
  const dirs = { exploreDir: path.join(base, 'explore'), runsDir: path.join(base, 'runs'), workspace: path.join(base, 'workspace') };
  const unattended: Resolver = { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false };

  before(async () => {
    server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[req.url ?? '/'] ?? PAGES['/']));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await rm(base, { recursive: true, force: true });
  });
  after(async () => {
    server?.close();
    await rm(base, { recursive: true, force: true });
  });

  it('is explored, generated with frame locators and passes without asking the tester', async () => {
    const model = parseTestCase(
      { id: 'TC-FRAME', title: 'Add in the content frame', steps: '1. Open the application\n2. Click Add', expected: 'Added is displayed' },
      config,
    );
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const result = await runCases([model], { config, baseUrl, env: {}, resolver: unattended, ...dirs });
    const v = result.verdicts[0];
    assert.equal(v.status, 'PASS', JSON.stringify({ reason: v.reason, steps: v.steps, checks: v.checks }));
    const pages = path.join(dirs.workspace, 'pages');
    assert.ok(existsSync(pages));
    const generated = (await Promise.all((await readdir(pages)).map((f) => readFile(path.join(pages, f), 'utf8')))).join('\n');
    assert.match(generated, /page\.frameLocator\('iframe\[name="rightMenu"\]'\)\.getByRole\('button', \{ name: 'Add', exact: true \}\)/);
  });
});
