import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Resolver } from '../explorer/controller.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { prepareCases } from './run-cases.js';

/**
 * With the semantic engine, what needs a person is decided by the new engine (its own reasons, in the tester's words), not
 * by the legacy parser's questions. These cases stop before any browser is opened.
 */

const config = defaultParserConfig();
const unattended: Resolver = { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false };
const model = (id: string, steps: string, expected: string) => parseTestCase({ id, title: id, steps, expected }, config);

async function prepare(models: ReturnType<typeof model>[], engine: 'semantic' | 'legacy') {
  const dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-sem-'));
  try {
    return await prepareCases(models, {
      config,
      baseUrl: 'http://127.0.0.1:1',
      env: {},
      resolver: unattended,
      exploreDir: path.join(dir, 'explore'),
      engine,
      workspace: path.join(dir, 'ws'),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the semantic engine decides what needs review', () => {
  const alternatives = model('TC-ALT', '1. Open Login page\n2. Click the Add button', 'The Success message or the Employee List page is displayed');
  const vague = model('TC-VAGUE', '1. Open Login page\n2. Do the needful', 'System works correctly');

  it("gives the new engine's reason, in the tester's words, for a sentence with two alternatives", async () => {
    const { early } = await prepare([alternatives], 'semantic');
    const v = early.get('TC-ALT');
    assert.equal(v?.status, 'NEEDS REVIEW');
    const reason = v?.review?.find((r) => r.why.includes('alternatives'));
    assert.ok(reason, JSON.stringify(v?.review));
    assert.ok(reason.raw.includes('message or'));
    assert.ok(reason.todo[0]?.includes('Name the one'), reason.todo.join());
  });
  it("gives the new engine's reason for an action it does not support, instead of a question about the page", async () => {
    const { early } = await prepare([vague], 'semantic');
    const v = early.get('TC-VAGUE');
    assert.equal(v?.status, 'NEEDS REVIEW');
    assert.ok(
      v?.review?.some((r) => r.headline.startsWith('unsupported action')),
      JSON.stringify(v?.review),
    );
  });
  it('leaves the legacy engine as it was', async () => {
    const { early } = await prepare([vague], 'legacy');
    const v = early.get('TC-VAGUE');
    assert.equal(v?.status, 'NEEDS REVIEW');
    assert.ok(!v?.review?.some((r) => r.headline.startsWith('unsupported action:')), 'the legacy reasons are not the new ones');
  });
});
