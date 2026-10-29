import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import { readWorkbook } from '../../importer/workbook.js';
import type { RawTestCase } from '../../model/test-model.js';
import { isSecret, Secret } from '../data/secret.js';
import { CredentialStore, newKey } from '../data/store.js';
import { type ExecutionSession, executePlan, openExecutionSession, type RunTrace } from '../execute/index.js';
import { planActions } from '../execute/planner.js';
import { knowledgeFromRuns } from '../knowledge/from-runs.js';
import { type CompileResult, compileCase } from '../pipeline/compile.js';
import { judge } from '../verdict/index.js';
import { cacheEnabled, cacheKeyOf, cacheStats, clearCaches, copyOf, Memo, readingVersions } from './index.js';

/**
 * GV-11: what is worked out from text alone is worked out once; nothing that holds data or evidence is kept. The results are the
 * same with the caches on and off, a hit is faster by a margin that does not depend on the machine, and a cached result can never
 * stand in for what a page shows now.
 */

const fixture = (name: string) => path.join(process.cwd(), 'test', 'fixtures', name);
const realCases = async (): Promise<RawTestCase[]> => [
  ...(await readWorkbook(fixture('OrangeHRM_Login_Test_Cases_Updated.xlsx'))).cases.map((c) => c.raw),
  ...(await readWorkbook(fixture('Add_Employee.xlsx'))).cases.map((c) => c.raw),
];

/** A compile result as plain text, with the values of the run (which a secret hides from JSON) written out, so two can be compared. */
function plain(r: CompileResult): string {
  const values = Object.entries(r.values ?? {}).map(([k, v]) => [k, v.source, v.class, isSecret(v.value) ? `secret:${v.value.reveal()}` : v.value]);
  return JSON.stringify({ ...r, values });
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe('the caches are off when asked, and the same result comes either way', () => {
  it('reads the switch: an option wins over AUTO_QA_CACHE; the default is on', () => {
    assert.equal(cacheEnabled(undefined, {}), true);
    for (const off of ['off', 'OFF', '0', 'false']) assert.equal(cacheEnabled(undefined, { AUTO_QA_CACHE: off }), false, off);
    assert.equal(cacheEnabled(undefined, { AUTO_QA_CACHE: 'on' }), true);
    assert.equal(cacheEnabled(true, { AUTO_QA_CACHE: 'off' }), true);
    assert.equal(cacheEnabled(false, {}), false);
  });

  it('the 39 real OrangeHRM cases give the identical compile result off, on and cold, and on and warm', async () => {
    const cases = await realCases();
    assert.ok(cases.length >= 29, `${cases.length} real cases`);
    clearCaches();
    const off: string[] = [];
    for (const c of cases) off.push(plain(await compileCase(c, { env: {}, cache: false })));
    assert.deepEqual(cacheStats(), {}, 'with the cache off nothing is kept');
    const cold: string[] = [];
    for (const c of cases) cold.push(plain(await compileCase(c, { env: {}, cache: true })));
    assert.equal(cacheStats().understand?.misses, cases.length);
    const warm: string[] = [];
    for (const c of cases) warm.push(plain(await compileCase(c, { env: {}, cache: true })));
    assert.equal(cacheStats().understand?.hits, cases.length, 'the second pass was served from the cache');
    for (const [i, c] of cases.entries()) {
      assert.equal(cold[i], off[i], `${c.id}: cold equals off`);
      assert.equal(warm[i], off[i], `${c.id}: warm equals off`);
    }
  });

  it('a hit is a copy: changing what a caller was given does not change what the next caller gets', async () => {
    const c = (await realCases())[0] as RawTestCase;
    clearCaches();
    const pristine = plain(await compileCase(c, { env: {}, cache: false }));
    await compileCase(c, { env: {}, cache: true }); // a miss: it fills the cache
    const hit = await compileCase(c, { env: {}, cache: true }); // a hit: what a caller changes here must not reach the cache
    assert.equal(cacheStats().understand?.hits, 1);
    hit.issues.push({ code: 'NOT_UNDERSTOOD', severity: 'blocking', where: 'x', original: 'x', message: 'planted' } as never);
    hit.units.length = 0;
    hit.ir?.steps.splice(0);
    const next = await compileCase(c, { env: {}, cache: true });
    assert.equal(cacheStats().understand?.hits, 2);
    assert.equal(plain(next), pristine);
  });
});

describe('what a cached result depends on: any change is a miss', () => {
  const base: RawTestCase = {
    id: 'T-KEY',
    title: 'Keyed',
    steps: '1. Open the Login page\n2. Enter valid password in the Password field',
    expected: 'The Login page is displayed',
    testData: 'Username: cypress',
    preconditions: 'User is on the login page',
  };
  const misses = () => cacheStats().understand?.misses ?? 0;

  it('a change in any part of the test case, or in its source, is read again', async () => {
    clearCaches();
    await compileCase(base, { env: {} });
    assert.equal(misses(), 1);
    await compileCase(base, { env: {} });
    assert.equal(misses(), 1, 'the same case is a hit');
    const variants: Array<[string, RawTestCase]> = [
      ['the steps', { ...base, steps: `${base.steps}\n3. Click the Login button` }],
      ['the expected result', { ...base, expected: 'The Dashboard heading is displayed' }],
      ['the test data', { ...base, testData: 'Username: someone-else' }],
      ['the preconditions', { ...base, preconditions: 'User is on the home page' }],
      ['the id', { ...base, id: 'T-KEY-2' }],
      ['the title', { ...base, title: 'Another title' }],
    ];
    for (const [what, raw] of variants) {
      const before = misses();
      await compileCase(raw, { env: {} });
      assert.equal(misses(), before + 1, `a change in ${what} is a miss`);
    }
    const before = misses();
    await compileCase(base, { env: {}, source: { file: 'other.xlsx', sheet: 'S', rows: [3] } as never });
    assert.equal(misses(), before + 1, 'a change of source is a miss');
  });

  it('the key holds the version of every component that reads the text: a different version is a different key', () => {
    const reads = readingVersions();
    assert.ok(Object.keys(reads.components as object).includes('grammar') && Object.keys(reads.components as object).includes('vocabulary'));
    assert.ok(Object.keys(reads.patterns as object).length > 0, 'every pattern has a version');
    const bumped = { ...reads, components: { ...(reads.components as object), grammar: '9.9.9' } };
    assert.notEqual(cacheKeyOf({ raw: 'x', reads }), cacheKeyOf({ raw: 'x', reads: bumped }));
    assert.equal(cacheKeyOf({ a: 1, b: [1, 2] }), cacheKeyOf({ b: [1, 2], a: 1 }), 'the order of keys does not matter');
  });
});

describe('nothing that holds data is cached: a changed credential is the one used', () => {
  const raw: RawTestCase = {
    id: 'T-DATA',
    title: 'Data',
    steps: '1. Open the Login page\n2. Enter valid password in the Password field\n3. Click the Login button',
    expected: 'The Dashboard heading is displayed',
  };
  const password = (r: CompileResult): string | undefined => {
    const v = Object.values(r.values ?? {}).find((x) => x.field.toLowerCase() === 'password');
    return isSecret(v?.value) ? v.value.reveal() : undefined;
  };

  it('an environment variable that changes between two compiles of the same text is followed, though the reading was cached', async () => {
    clearCaches();
    const a = await compileCase(raw, { env: { TEST_PASSWORD: 'first-pass' } });
    const b = await compileCase(raw, { env: { TEST_PASSWORD: 'second-pass' } });
    assert.equal(cacheStats().understand?.hits, 1, 'the second reading came from the cache');
    assert.equal(password(a), 'first-pass');
    assert.equal(password(b), 'second-pass');
  });

  it('a credential store entry that changes is followed too', async () => {
    clearCaches();
    const store = new CredentialStore(path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-cache-')), 's.json'), newKey());
    await store.set('password.valid', 'one-in-the-store');
    assert.equal(password(await compileCase(raw, { env: {}, store })), 'one-in-the-store');
    await store.set('password.valid', 'two-in-the-store');
    const again = await compileCase(raw, { env: {}, store });
    assert.equal(cacheStats().understand?.hits, 1);
    assert.equal(password(again), 'two-in-the-store');
  });

  it('a password in the test data of the sheet is part of the key: another one is another entry, and neither leaks into the other', async () => {
    clearCaches();
    const withData = (p: string): RawTestCase => ({ ...raw, testData: `Password: ${p}` });
    const a = await compileCase(withData('sheet-one'), { env: {} });
    const b = await compileCase(withData('sheet-two'), { env: {} });
    const a2 = await compileCase(withData('sheet-one'), { env: {} });
    assert.deepEqual([password(a), password(b), password(a2)], ['sheet-one', 'sheet-two', 'sheet-one']);
    assert.equal(cacheStats().understand?.hits, 1);
  });
});

describe('the cache itself', () => {
  it('keeps the most recently used up to its limit, and counts hits and misses', () => {
    const m = new Memo<number>(2);
    m.set('a', 1);
    m.set('b', 2);
    assert.equal(m.get('a'), 1); // a is used again: b is now the oldest
    m.set('c', 3);
    assert.equal(m.get('b'), undefined, 'the oldest was dropped');
    assert.equal(m.get('a'), 1);
    assert.equal(m.get('c'), 3);
    assert.deepEqual(m.stats, { hits: 3, misses: 1, size: 2 });
    m.clear();
    assert.deepEqual(m.stats, { hits: 0, misses: 0, size: 0 });
  });

  it('copies plain data deeply and hands a secret on as it is', () => {
    const secret = new Secret('keep-me');
    const original = { list: [{ n: 1 }], map: new Map([['k', { v: 1 }]]), set: new Set([1]), secret };
    const copy = copyOf(original);
    assert.notEqual(copy.list, original.list);
    assert.notEqual(copy.list[0], original.list[0]);
    assert.notEqual(copy.map.get('k'), original.map.get('k'));
    assert.equal(copy.secret, secret, 'a secret is not copied: a copy would lose what it holds');
    copy.list[0] = { n: 2 };
    assert.equal(original.list[0]?.n, 1);
  });
});

describe('the knowledge of an application built from saved explorations', () => {
  const exploration = (names: string[], baseUrl = 'http://127.0.0.1:1') => ({
    baseUrl,
    status: 'complete',
    items: names.map((name) => ({ status: 'done', element: { role: 'button', name }, page: { name: 'P' } })),
  });
  const write = (dir: string, id: string, body: unknown): void => {
    mkdirSync(path.join(dir, id), { recursive: true });
    writeFileSync(path.join(dir, id, 'exploration.json'), JSON.stringify(body));
  };
  const names = (a: Awaited<ReturnType<typeof knowledgeFromRuns>>): string[] => (a?.pages.flatMap((p) => p.components.map((c) => c.name)) ?? []).sort();

  it('is served from the cache while the explorations are the same, and read again when one is changed, added or removed', async () => {
    clearCaches();
    const dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-know-'));
    try {
      write(dir, 'a', exploration(['Save']));
      const first = await knowledgeFromRuns('app', 'http://127.0.0.1:1', dir);
      assert.deepEqual(names(first), ['Save']);
      assert.deepEqual(names(await knowledgeFromRuns('app', 'http://127.0.0.1:1', dir)), ['Save']);
      assert.deepEqual(cacheStats().knowledge, { hits: 1, misses: 1, size: 1 });

      write(dir, 'a', exploration(['Save', 'Cancel']));
      assert.deepEqual(names(await knowledgeFromRuns('app', 'http://127.0.0.1:1', dir)), ['Cancel', 'Save'], 'a changed exploration is read again');
      write(dir, 'b', exploration(['Delete']));
      assert.deepEqual(names(await knowledgeFromRuns('app', 'http://127.0.0.1:1', dir)), ['Cancel', 'Delete', 'Save'], 'an added one is read');
      await rm(path.join(dir, 'b'), { recursive: true });
      assert.deepEqual(names(await knowledgeFromRuns('app', 'http://127.0.0.1:1', dir)), ['Cancel', 'Save'], 'a removed one is gone');
      // Removing it puts the folder back as it was before it was added: that state was read already, so it is served, and it is right.
      assert.deepEqual([cacheStats().knowledge?.misses, cacheStats().knowledge?.hits], [3, 2]);

      const words = [{ word: 'discard', means: 'Cancel' }];
      const aliased = await knowledgeFromRuns('app', 'http://127.0.0.1:1', dir, words);
      assert.ok(
        aliased?.pages[0]?.components.some((c) => c.aliases.includes('discard')),
        'other words are another entry',
      );
      assert.deepEqual(
        names(await knowledgeFromRuns('app', 'http://127.0.0.1:1', dir, [], { cache: false })),
        ['Cancel', 'Save'],
        'the same with the cache off',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a hit is a copy', async () => {
    clearCaches();
    const dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-know-'));
    try {
      write(dir, 'a', exploration(['Save']));
      const a = await knowledgeFromRuns('app', undefined, dir);
      a?.pages[0]?.components.splice(0);
      assert.deepEqual(names(await knowledgeFromRuns('app', undefined, dir)), ['Save']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the second run is faster, by a margin that does not depend on the machine', () => {
  it('compiling the real cases: the median of a warm pass is far below a cold one in each of three separate batches, and a cold one costs no more than with the cache off', async (t: TestContext) => {
    const cases = await realCases();
    const pass = async (cache: boolean): Promise<number> => {
      const start = performance.now();
      for (const c of cases) await compileCase(c, { env: {}, cache });
      return performance.now() - start;
    };
    await pass(false); // the first use of the code is slower: it is not what is measured
    const batches: Array<{ off: number; cold: number; warm: number }> = [];
    for (let batch = 0; batch < 3; batch++) {
      const off: number[] = [];
      const cold: number[] = [];
      const warm: number[] = [];
      for (let i = 0; i < 5; i++) {
        off.push(await pass(false));
        clearCaches();
        cold.push(await pass(true));
        warm.push(await pass(true));
      }
      batches.push({ off: median(off), cold: median(cold), warm: median(warm) });
    }
    t.diagnostic(
      `${cases.length} cases, median ms per pass: ${batches.map((b) => `off ${b.off.toFixed(0)} / cold ${b.cold.toFixed(0)} / warm ${b.warm.toFixed(0)}`).join('  |  ')}`,
    );
    for (const b of batches) {
      assert.ok(b.warm * 3 < b.cold, `warm ${b.warm.toFixed(1)} ms is not under a third of cold ${b.cold.toFixed(1)} ms`);
      assert.ok(b.cold < b.off * 1.5 + 50, `cold ${b.cold.toFixed(1)} ms costs more than with the cache off (${b.off.toFixed(1)} ms)`);
    }
  });

  it('reading a large folder of explorations: a warm read is under half of a cold one', async (t: TestContext) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-big-'));
    try {
      for (let f = 0; f < 60; f++) {
        const items = Array.from({ length: 300 }, (_, i) => ({ status: 'done', element: { role: 'button', name: `Button ${f}-${i}` }, page: { name: 'P' } }));
        mkdirSync(path.join(dir, `e${f}`), { recursive: true });
        writeFileSync(path.join(dir, `e${f}`, 'exploration.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:1', status: 'complete', items }));
      }
      const time = async (cache: boolean): Promise<number> => {
        const start = performance.now();
        await knowledgeFromRuns('big', 'http://127.0.0.1:1', dir, [], { cache });
        return performance.now() - start;
      };
      await time(false);
      const cold: number[] = [];
      const warm: number[] = [];
      for (let i = 0; i < 5; i++) {
        clearCaches();
        cold.push(await time(true));
        warm.push(await time(true));
      }
      t.diagnostic(`60 explorations: cold ${median(cold).toFixed(1)} ms, warm ${median(warm).toFixed(1)} ms`);
      assert.ok(median(warm) * 2 < median(cold), `warm ${median(warm).toFixed(1)} ms, cold ${median(cold).toFixed(1)} ms`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const REJECTED = 'Error message "Invalid username or password" is displayed';

describe('in Chrome: the same run and verdict with the caches on and off, and a cached reading never stands in for what the page shows', {
  skip: !!process.env.AUTO_QA_SKIP_BROWSER,
}, () => {
  let session: ExecutionSession;
  let demo: Awaited<ReturnType<typeof startDemoApp>>;
  let silent: { url: string; close(): Promise<void> };
  before(async () => {
    demo = await startDemoApp();
    session = await openExecutionSession();
    // The same login form that never shows an error: what a page that does not do what the test expects looks like.
    const server = http.createServer((_req, res) =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><title>Login</title><h1>Sign in to Demo</h1><form id="login" aria-label="Login" onsubmit="return false"><label for="username">Username</label><input id="username" name="username"><label for="password">Password</label><input id="password" name="password" type="password"><p><button type="submit" data-testid="login">Login</button></p></form>',
        ),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    silent = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
  });
  after(async () => {
    await session?.close();
    await demo?.close();
    await silent?.close();
  });

  const caseAt = (url: string): RawTestCase => ({
    id: 'T-CACHE',
    title: 'A wrong password is rejected',
    steps: [`Open ${url}/`, "Enter 'demo' in the Username field", 'Enter password in the Password field', "Click the 'Login' button"]
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n'),
    expected: REJECTED,
    testData: 'Password: nope',
  });

  /** What a run did, without the clock: the steps, their calls with no times, the pages seen, and the verdict. */
  async function run(url: string, cache: boolean): Promise<{ trace: string; verdict: string; status: string }> {
    const c = await compileCase(caseAt(url), { env: {}, cache });
    assert.ok(c.ir && c.plan, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
    const trace: RunTrace = await executePlan(
      { plan: planActions(c.ir, c.plan), values: c.values, pages: c.pages },
      { mcp: session.port, page: session.page, baseUrl: url },
    );
    await session.reset();
    const verdict = judge({ compile: c, trace });
    const noClock = JSON.stringify(trace, (k, v) => (k === 'at' || k === 'ms' ? undefined : v));
    return {
      trace: noClock,
      verdict: JSON.stringify({ v: verdict.verdict, reason: verdict.reason, evaluations: verdict.evaluations.map((e) => [e.expectation, e.result, e.actual]) }),
      status: verdict.verdict,
    };
  }

  it('gives the same execution and the same verdict with the caches off, cold and warm', async () => {
    clearCaches();
    const off = await run(demo.url, false);
    const cold = await run(demo.url, true);
    const warm = await run(demo.url, true);
    assert.equal(cacheStats().understand?.hits, 1, 'the third run was served from the cache');
    assert.equal(off.status, 'PASS', off.verdict);
    assert.equal(cold.trace, off.trace, 'the cold run did what the run without caches did');
    assert.equal(warm.trace, off.trace, 'and so did the warm one');
    assert.equal(cold.verdict, off.verdict);
    assert.equal(warm.verdict, off.verdict);
  });

  it('a page that does not show the error is not a PASS, though the same text was read before and the other page proved it', async () => {
    clearCaches();
    const proven = await run(demo.url, true);
    assert.equal(proven.status, 'PASS', proven.verdict);
    // Same wording, so the reading is served from the cache; the page is another one, so the verdict follows the page.
    const text = (url: string) => caseAt(url).steps.split(url).join('URL');
    assert.equal(text(demo.url), text(silent.url), 'the two cases differ only in the address');
    const stale = await run(silent.url, true);
    assert.notEqual(stale.status, 'PASS', `a page with no error was a PASS: ${stale.verdict}`);
    // And back again: the page that shows it is a PASS again.
    assert.equal((await run(demo.url, true)).status, 'PASS');
  });
});

describe('no browser is left behind (GV-11)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  const leftovers = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('auto-qa-run-'));

  it('a session that is closed leaves no browser profile and no open page, however often it is opened', async () => {
    const before = leftovers().length;
    for (let i = 0; i < 3; i++) {
      const session = await openExecutionSession();
      await session.page.goto('about:blank');
      const context = session.context;
      await session.close();
      assert.equal(session.page.isClosed(), true, 'the page is closed');
      assert.equal(context.pages().length, 0, 'no page is left in the browser');
    }
    assert.equal(leftovers().length, before, 'the profile folders of the sessions are removed');
  });
});
