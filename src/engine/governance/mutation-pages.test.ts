import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type ExecutionSession, openExecutionSession } from '../execute/index.js';
import {
  benchmarkText,
  mutationKey,
  mutationScore,
  ORANGEHRM_MUTATION_CASES,
  ORANGEHRM_MUTATIONS,
  ORANGEHRM_PAGES,
  runBenchmark,
  runMutationMatrix,
  startMutant,
  startSavedPages,
} from './index.js';

/** E0.19 step 5: saved OrangeHRM pages broken on purpose; a check that held on the saved page must never PASS on a broken one. */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pages = Object.fromEntries(Object.entries(ORANGEHRM_PAGES).map(([at, file]) => [at, readFileSync(path.join(root, 'test/dom', file), 'utf8')]));

describe('broken copies of saved OrangeHRM pages (E0.19 step 5)', () => {
  it('every mutation names real cases, changes the right answer of one, and still finds what it breaks on the saved page', () => {
    const ids = new Set(ORANGEHRM_MUTATION_CASES.map((c) => c.id));
    for (const m of ORANGEHRM_MUTATIONS) {
      assert.ok(Object.keys(m.overrides).length > 0, m.id);
      for (const [id, v] of Object.entries(m.overrides)) {
        assert.ok(ids.has(id), `${m.id}: no case ${id}`);
        assert.notEqual(v, ORANGEHRM_MUTATION_CASES.find((c) => c.id === id)?.baseline, `${m.id}/${id} changes nothing`);
      }
      // A rewrite throws when the saved page no longer has the text it breaks: the set never tests a fault that is not there.
      for (const [at, html] of Object.entries(pages)) assert.doesNotThrow(() => m.rewrite(at, html), `${m.id} on ${at}`);
    }
  });

  it('the kinds of fault a release brings are all there: removed, hidden, renamed, gone, server error, empty page', () => {
    const ids = ORANGEHRM_MUTATIONS.map((m) => m.id);
    for (const kind of ['removed', 'hidden', 'renamed', 'deleted', 'server-error', 'empty'])
      assert.ok(
        ids.some((id) => id.includes(kind)),
        kind,
      );
  });
});

describe('the engine against broken saved OrangeHRM pages', { skip }, () => {
  let site: Awaited<ReturnType<typeof startSavedPages>>;
  let session: ExecutionSession;
  before(async () => {
    site = await startSavedPages(pages);
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await site?.close();
  });

  it('a mutant really breaks the page, and a server error is a 500', async () => {
    const hidden = ORANGEHRM_MUTATIONS.find((m) => m.id === 'add-button-hidden');
    const failing = ORANGEHRM_MUTATIONS.find((m) => m.id === 'list-server-error');
    assert.ok(hidden && failing);
    const a = await startMutant(site.url, hidden.rewrite, hidden.status);
    const b = await startMutant(site.url, failing.rewrite, failing.status);
    try {
      assert.ok((await (await fetch(`${a.url}/employee-list`)).text()).includes('value="Add" style="display:none"'));
      assert.equal((await fetch(`${b.url}/employee-list`)).status, 500);
      assert.equal((await fetch(`${b.url}/login.php`)).status, 200);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('every check holds on the saved pages, and no broken page earns a wrong PASS', { timeout: 600_000 }, async () => {
    const results = await runMutationMatrix(
      site.url,
      session,
      mkdtempSync(path.join(tmpdir(), 'aq-mutate-ohrm-')),
      ORANGEHRM_MUTATIONS,
      ORANGEHRM_MUTATION_CASES,
    );
    const key = mutationKey('E0.19 step 5', '2026-11-08', ORANGEHRM_MUTATIONS, ORANGEHRM_MUTATION_CASES);
    const report = runBenchmark(key, results);
    const untouched = results.filter((r) => r.module === 'app:untouched');
    for (const c of ORANGEHRM_MUTATION_CASES)
      assert.equal(untouched.find((r) => r.id === c.id)?.verdict, c.baseline, `${c.id} on the saved page\n${benchmarkText(report)}`);
    assert.equal(report.wrongPass, 0, benchmarkText(report));
    const score = mutationScore(key, results);
    assert.deepEqual(score.survivors, []);
    assert.equal(score.killed, score.total);
  });
});
