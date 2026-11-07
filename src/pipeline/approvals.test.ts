import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import { LearningBook } from '../engine/verdict/index.js';
import { defaultParserConfig } from '../parser/config.js';
import { parseTestCase } from '../parser/index.js';
import type { TestVerdict } from '../results/verdict.js';
import { runCases } from './run-cases.js';

/**
 * E0.18 step 5 exit test, on real runs of the demo app: the first run leaves a check open (NEEDS REVIEW); a person decides it; the
 * second run of the unchanged case does not ask again; the same case with another expected value asks again. Needs Google Chrome and
 * no internet. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STEPS = '1. Open the application\n2. Enter the given valid username in the Username Text box\n3. Enter valid password\n4. Click Login';

describe('E0.18 step 5: a decided check is not asked again while it is unchanged', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  const base = path.join(root, '.auto-qa', 'test-approvals');
  before(async () => {
    app = await startDemoApp();
    await rm(base, { recursive: true, force: true });
  });
  after(async () => {
    await app?.close();
    await rm(base, { recursive: true, force: true });
  });

  const run = async (expected: string, learning?: LearningBook): Promise<TestVerdict> => {
    const config = defaultParserConfig();
    const r = await runCases([parseTestCase({ id: 'TC-APPROVE', title: 'First page', steps: STEPS, expected }, config)], {
      config,
      baseUrl: app.url,
      engine: 'semantic',
      env: { TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: DEMO_USER.password },
      resolver: { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false },
      exploreDir: path.join(base, 'explore'),
      runsDir: path.join(base, 'runs'),
      workspace: path.join(base, 'workspace'),
      ...(learning ? { learning } : {}),
    });
    return r.verdicts[0] as TestVerdict;
  };

  it('first run: NEEDS REVIEW with a fingerprint; decided PASS: the next run passes; another expected value asks again', async () => {
    const first = await run('User should see Profile as a default page');
    assert.equal(first.status, 'NEEDS REVIEW', first.reason);
    assert.equal(first.approvals?.length, 1);
    const decided = new LearningBook({
      decisions: (first.approvals ?? []).map((a) => ({
        fingerprint: a.fingerprint,
        testId: first.testId,
        clause: a.clause,
        decision: 'PASS',
        who: 'Owner',
        when: '2026-11-07T10:00:00.000Z',
      })),
    });

    const second = await run('User should see Profile as a default page', decided);
    assert.equal(second.status, 'PASS', second.reason);
    assert.ok(second.reason.includes('earlier decision of a person'), second.reason);

    const changed = await run('User should see Settings as a default page', decided);
    assert.equal(changed.status, 'NEEDS REVIEW', 'another expected value is another check: it is asked again');
  });
});
