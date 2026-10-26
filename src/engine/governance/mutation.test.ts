import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import { type ExecutionSession, openExecutionSession } from '../execute/index.js';
import { benchmarkText, MUTATION_CASES, MUTATIONS, mutationKey, mutationScore, runBenchmark, runMutationMatrix, startMutant } from './index.js';

/** The mutation harness: a broken copy of the app must never earn a PASS. */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

describe('mutation definitions', () => {
  it('every mutation names real cases and changes the right answer of at least one', () => {
    const ids = new Set(MUTATION_CASES.map((c) => c.id));
    for (const m of MUTATIONS) {
      assert.ok(Object.keys(m.overrides).length > 0, m.id);
      for (const [id, v] of Object.entries(m.overrides)) {
        assert.ok(ids.has(id), `${m.id}: no case ${id}`);
        const base = MUTATION_CASES.find((c) => c.id === id)?.baseline;
        assert.notEqual(v, base, `${m.id}/${id} does not change anything`);
      }
    }
  });
  it('the key has the untouched app and every mutant, and counts only broken cases as faults', () => {
    const key = mutationKey('t', '2026-10-22');
    assert.equal(key.cases.length, MUTATION_CASES.length * (MUTATIONS.length + 1));
    const survived = mutationScore(key, [{ id: 'M-GOOD-LOGIN', module: 'mutant:reject-valid-login', verdict: 'PASS' }]);
    assert.deepEqual(survived.survivors, ['mutant:reject-valid-login/M-GOOD-LOGIN']);
  });
});

describe('the engine against broken copies of the demo app', { skip }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let session: ExecutionSession;
  before(async () => {
    app = await startDemoApp();
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  it('a mutant really changes the app (the proxy rewrites the page)', async () => {
    const m = MUTATIONS.find((x) => x.id === 'wrong-error-text');
    assert.ok(m);
    const mutant = await startMutant(app.url, m.rewrite);
    try {
      const html = await (await fetch(`${mutant.url}/`)).text();
      assert.ok(html.includes('Something went wrong'));
      assert.ok(!html.includes("error.textContent = 'Invalid username or password'"));
    } finally {
      await mutant.close();
    }
  });

  it('no mutant earns a wrong PASS', { timeout: 300_000 }, async () => {
    const results = await runMutationMatrix(app.url, session, mkdtempSync(path.join(tmpdir(), 'aq-mutate-')));
    const report = runBenchmark(mutationKey('test', '2026-10-22'), results);
    console.log(benchmarkText(report));
    assert.equal(report.wrongPass, 0, benchmarkText(report));
  });
});
