import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import { defaultParserConfig } from '../../parser/config.js';
import { parseTestCase } from '../../parser/index.js';
import { toTestVerdict } from '../../pipeline/semantic-run.js';
import { screensOf } from '../execute/capture.js';
import { type ExecutionSession, executePlan, openExecutionSession } from '../execute/index.js';
import { planActions } from '../execute/planner.js';
import { ApplicationSchema } from '../knowledge/schema.js';
import { compileCase } from '../pipeline/compile.js';
import { judge } from '../verdict/index.js';
import { fingerprintOf, MIN_SCORE, matchFingerprint, scoreOf } from './fingerprint.js';
import type { DomElement } from './types.js';

/**
 * E0.17 item 5, fallback fingerprints. What a step found is kept as a fingerprint with its screen; a later run that cannot find the
 * element by any level compares it with the page. Exactly one usable element above the minimum score, with a lead over the next, is
 * used, as an assumption a person approves; never for a check. The browser test uses demo app /ui/renamed, whose ?v=2 renames the
 * Save button and ?v=3 also changes its id and handler. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const button = (over: Partial<DomElement>): DomElement => ({
  index: 0,
  tag: 'button',
  type: 'button',
  role: 'button',
  ariaName: '',
  labels: [],
  text: 'Save profile',
  visible: true,
  disabled: false,
  readOnly: false,
  covered: false,
  box: { x: 0, y: 0, width: 80, height: 20 },
  focused: false,
  focusable: true,
  parents: [],
  nearbyText: '',
  xpath: "//*[@id='save-profile']",
  inDialog: false,
  invalid: false,
  frame: [],
  id: 'save-profile',
  handler: "done('Profile stored')",
  ...over,
});
const CANCEL = button({ text: 'Cancel', id: 'cancel-profile', xpath: "//*[@id='cancel-profile']", handler: "done('Cancelled')" });

describe('E0.17 item 5: what a fingerprint keeps and how it is matched', () => {
  const fp = fingerprintOf(button({}), [button({}), CANCEL]);

  it('keeps the locators that found only this element, in the order people trust them', () => {
    assert.deepEqual(
      fp.locators.map((l) => l.kind),
      ['id', 'role', 'xpath'],
    );
    assert.equal(fp.htmlId, 'save-profile');
    assert.equal(fp.handler, "done('Profile stored')");
  });

  it('renamed, with the same id and handler: found, above the minimum and well ahead of the other button', () => {
    const renamed = button({ text: 'Store profile' });
    const r = matchFingerprint(fp, [renamed, CANCEL]);
    assert.equal(r.status, 'found');
    if (r.status === 'found') {
      assert.ok(r.score >= MIN_SCORE, String(r.score));
      assert.equal(r.via, 'id');
    }
  });

  it('renamed with a new id and a new handler: too little left of it, not found', () => {
    const changed = button({ text: 'Store profile', id: 'store-profile', xpath: "//*[@id='store-profile']", handler: "done('Profile kept')" });
    assert.equal(matchFingerprint(fp, [changed, CANCEL]).status, 'none');
  });

  it('another role or frame is never the same element; a hidden or disabled one is not used', () => {
    assert.equal(scoreOf(fp, button({ role: 'link', tag: 'a' })), 0);
    assert.equal(scoreOf(fp, button({ frame: ['#content'] })), 0);
    assert.equal(matchFingerprint(fp, [button({ text: 'Store profile', visible: false })]).status, 'none');
    assert.equal(matchFingerprint(fp, [button({ text: 'Store profile', disabled: true })]).status, 'none');
  });

  it('two elements that both have enough of it: the engine does not choose', () => {
    const twin = button({ text: 'Store profile', xpath: '/html[1]/body[1]/p[2]/button[1]' });
    assert.equal(matchFingerprint(fp, [button({ text: 'Store profile' }), twin]).status, 'none');
  });
});

describe('E0.17 item 5 on a real page: the release renames a button', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
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

  const run = async (version: number, expected: string, knowledge?: ReturnType<typeof ApplicationSchema.parse>) => {
    const compile = await compileCase(
      { id: 'T-RENAMED', title: 'Save the profile', steps: `1. Open ${app.url}/ui/renamed?v=${version}\n2. Click the Save profile button`, expected },
      { env: {} },
    );
    assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
      { mcp: session.port, page: session.page, baseUrl: app.url, ...(knowledge ? { knowledge } : {}) },
    );
    await session.reset();
    return { trace, verdict: judge({ compile, trace }), compile };
  };

  it('first release: found by its name and PASS; what it was is kept with its screen', async () => {
    const first = await run(1, 'The text "Profile stored" is shown');
    assert.equal(first.verdict.verdict, 'PASS', first.verdict.reason);
    const kept = screensOf(first.trace).flatMap((s) => s.found ?? []);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.word, 'Save profile');
  });

  it('renamed release: found by its fingerprint, NEEDS REVIEW and never PASS; too different a release: not found', async () => {
    const first = await run(1, 'The text "Profile stored" is shown');
    const knowledge = ApplicationSchema.parse({ name: 'demo', screens: screensOf(first.trace) });

    const renamed = await run(2, 'The text "Profile stored" is shown', knowledge);
    const click = renamed.trace.steps.find((s) => s.action === 'CLICK');
    assert.equal(renamed.trace.status, 'completed', JSON.stringify(renamed.trace.stoppedAt));
    assert.ok(click?.located?.assumed?.why.includes('found by what it was in an earlier run'), JSON.stringify(click?.notes));
    assert.equal(renamed.verdict.verdict, 'NEEDS_REVIEW', renamed.verdict.reason);
    // E0.18 step 4: in the results it is NEEDS REVIEW, labelled healed.
    const model = parseTestCase({ id: 'T-RENAMED', title: 'Save the profile', steps: '1. Open the page 2. Click', expected: 'x' }, defaultParserConfig());
    assert.equal(toTestVerdict(model, renamed.verdict, renamed.trace, renamed.compile).label, 'healed');

    const changed = await run(3, 'The text "Profile kept" is shown', knowledge);
    assert.equal(changed.trace.stoppedAt?.code, 'LOCATE_NOT_FOUND', JSON.stringify(changed.trace.stoppedAt));
    assert.ok(changed.trace.steps.at(-1)?.notes.some((n) => n.includes('fingerprint')));

    const without = await run(2, 'The text "Profile stored" is shown');
    assert.equal(without.trace.stoppedAt?.code, 'LOCATE_NOT_FOUND', 'with nothing kept from before, there is no fallback');
  });

  it('a check is never made on a fingerprint: "The Save profile button is displayed" on the renamed release is not proven', async () => {
    const first = await run(1, 'The text "Profile stored" is shown');
    const knowledge = ApplicationSchema.parse({ name: 'demo', screens: screensOf(first.trace) });
    const r = await run(2, 'The Save profile button is displayed', knowledge);
    assert.notEqual(r.verdict.verdict, 'PASS', r.verdict.reason);
    assert.equal(r.verdict.evaluations[0]?.result !== 'proven', true);
  });
});
