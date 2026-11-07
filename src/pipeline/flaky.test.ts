import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { defaultParserConfig } from '../parser/config.js';
import { parseTestCase } from '../parser/index.js';
import { runCases } from './run-cases.js';

/**
 * E0.18 step 4 exit test, on a real run: demo app /ui/flaky says "Busy" on its second load only. The exploration loads it first, the
 * generated test's first attempt second (it fails), and its retry third (it passes). The result is NEEDS REVIEW, flaky; never PASS.
 * Needs Google Chrome and no internet. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('E0.18 step 4: a test that passes only on its retry', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  const base = path.join(root, '.auto-qa', 'test-flaky');
  before(async () => {
    app = await startDemoApp();
    await rm(base, { recursive: true, force: true });
  });
  after(async () => {
    await app?.close();
    await rm(base, { recursive: true, force: true });
  });

  it('is NEEDS REVIEW with the label flaky', async () => {
    const config = defaultParserConfig();
    const model = parseTestCase({ id: 'TC-FLAKY', title: 'Status is ready', steps: '1. Open the application', expected: 'Message "Ready" is shown' }, config);
    const r = await runCases([model], {
      config,
      baseUrl: `${app.url}/ui/flaky`,
      env: {},
      resolver: { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false },
      exploreDir: path.join(base, 'explore'),
      runsDir: path.join(base, 'runs'),
      workspace: path.join(base, 'workspace'),
    });
    const v = r.verdicts[0];
    assert.equal(v?.status, 'NEEDS REVIEW', v?.reason);
    assert.equal(v?.label, 'flaky');
  });
});
