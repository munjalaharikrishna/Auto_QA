import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import type { RawTestCase } from '../../model/test-model.js';
import { systemClock } from '../../pipeline/clock.js';
import { createOtpSource, LocalMailbox } from '../auth/index.js';
import { isSecret, scanForSecrets } from '../data/secret.js';
import { CredentialStore, newKey } from '../data/store.js';
import { type Call, type ExecutionSession, executePlan, type McpPort, openExecutionSession, type RunTrace, type StepRecord } from '../execute/index.js';
import { type ExecutionPlan, planActions } from '../execute/planner.js';
import { compileCase } from '../pipeline/compile.js';
import { type AuditTrail, auditOf, checkTrail, contractIdOf, renderTrail } from './index.js';

/**
 * GV-02: every call of a run is in the audit trail once, in order, tied to the step it served and to the locator contract it acted on
 * (Page → Component → Semantic name → Selector chain), and nothing in it holds a secret. The first part needs no browser; the second
 * runs the demo app in Chrome. AUTO_QA_SKIP_BROWSER=1 skips the second.
 */

const raw = (over: Partial<RawTestCase> = {}): RawTestCase => ({
  id: 'T-AUDIT',
  title: 'Login',
  steps: ['1. Open the Application', "2. Enter 'demo' in the Username field", '3. Enter password in the Password field', "4. Click the 'Login' button"].join(
    '\n',
  ),
  expected: 'The Dashboard heading is displayed',
  testData: 'Password: demo123',
  ...over,
});

const call = (seq: number, over: Partial<Call> = {}): Call => ({
  seq,
  via: 'mcp',
  tool: 'browser_click',
  fn: 'click',
  args: { target: `#b${seq}` },
  at: 1000 + seq,
  ms: 5,
  outcome: 'ok',
  ...over,
});

const compiled = async () => {
  const c = await compileCase(raw(), { env: {} });
  assert.ok(c.ir && c.plan);
  return { c, plan: planActions(c.ir, c.plan) };
};

/** A run with a located element and calls for the second step, built by hand: the shape of a real trace, no browser. */
async function syntheticRun(): Promise<{ trace: RunTrace; plan: ExecutionPlan }> {
  const { plan } = await compiled();
  const located = (selector: string, name: string): StepRecord['located'] => ({
    name,
    level: 'label',
    weight: 0.9,
    selector,
    contract: { id: contractIdOf('/login', name, selector), page: '/login', component: name, semantic: name },
    tried: [{ level: 'label', weight: 0.9, matches: 1, active: 1, outcome: 'used' }],
    element: { tag: 'input', role: 'textbox' },
    ignored: [],
  });
  let n = 0;
  const steps: StepRecord[] = plan.chains.map((chain, i) => {
    const sel = `#f${i}`;
    const acting = i > 0;
    return {
      step: chain.step,
      action: chain.action,
      original: chain.original,
      status: 'done',
      calls: acting
        ? [call(++n, { args: { target: sel, element: 'x' }, fn: i === 3 ? 'click' : 'type', tool: i === 3 ? 'browser_click' : 'browser_type' })]
        : [call(++n, { fn: 'navigate', tool: 'browser_navigate', args: { url: 'http://app/' } })],
      changes: [],
      dialogs: [],
      checksAfter: chain.checksAfter,
      notes: [],
      ...(acting ? { located: located(sel, chain.target?.name ?? `field${i}`) } : {}),
    };
  });
  return { trace: { testId: plan.testId, status: 'completed', capabilities: [], steps }, plan };
}

describe('the audit trail of a run (GV-02), without a browser', () => {
  it('has every call once, in order, tied to its step and to the contract it acted on', async () => {
    const { trace, plan } = await syntheticRun();
    const trail = auditOf(trace, plan);
    assert.deepEqual(
      trail.entries.map((e) => e.seq),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      trail.entries.map((e) => e.step),
      plan.chains.map((c) => c.step),
    );
    assert.equal(trail.contracts.length, 3);
    assert.ok(
      trail.entries.slice(1).every((e) => e.contract !== undefined),
      'each action names its contract',
    );
    assert.equal(trail.entries[0]?.contract, undefined, 'a navigation acts on no element');
    assert.deepEqual(checkTrail(trail, trace, plan), []);
    const text = renderTrail(trail);
    assert.ok(text.includes('/login →') && text.includes('browser_type'), text);
  });

  it('is the same every time for the same run (GV-05)', async () => {
    const { trace, plan } = await syntheticRun();
    assert.equal(JSON.stringify(auditOf(trace, plan)), JSON.stringify(auditOf(trace, plan)));
  });

  it('a contract id is the same for the same page, name and selector, and differs when any of them does', () => {
    assert.equal(contractIdOf('/login', 'Username', '#u'), contractIdOf('/login', 'Username', '#u'));
    assert.notEqual(contractIdOf('/login', 'Username', '#u'), contractIdOf('/login', 'Username', '#v'));
    assert.notEqual(contractIdOf('/login', 'Username', '#u'), contractIdOf('/home', 'Username', '#u'));
  });

  it('finds a call that was lost, a number that repeats, and a call that names a step the run does not have', async () => {
    const { trace, plan } = await syntheticRun();
    const full = auditOf(trace, plan);
    const lost: AuditTrail = { ...full, entries: full.entries.filter((e) => e.seq !== 3) };
    assert.ok(checkTrail(lost, trace, plan).some((p) => p.includes('the run made 4 call(s) and the trail has 3')));
    assert.ok(checkTrail(lost, trace, plan).some((p) => p.includes('not 1, 2, 3')));
    const stranger: AuditTrail = { ...full, entries: full.entries.map((e) => (e.seq === 2 ? { ...e, step: 'S99' } : e)) };
    assert.ok(checkTrail(stranger, trace, plan).some((p) => p.includes('S99')));
  });

  it('finds a failed call that does not say why, a contract that was changed, and a contract that is missing', async () => {
    const { trace, plan } = await syntheticRun();
    const full = auditOf(trace, plan);
    const silent: AuditTrail = { ...full, entries: full.entries.map((e) => (e.seq === 2 ? { ...e, outcome: 'failed' as const } : e)) };
    assert.ok(checkTrail(silent, trace, plan).some((p) => p.includes('says nothing about why')));
    const forged: AuditTrail = { ...full, contracts: full.contracts.map((c, i) => (i === 0 ? { ...c, selector: '#elsewhere' } : c)) };
    assert.ok(checkTrail(forged, trace, plan).some((p) => p.includes('is not the contract of its page, name and selector')));
    const dangling: AuditTrail = { ...full, entries: full.entries.map((e) => (e.seq === 2 ? { ...e, contract: 'nope' } : e)) };
    assert.ok(checkTrail(dangling, trace, plan).some((p) => p.includes('names contract nope')));
  });

  it('a step that was to act and made no call must say why; one that says why is fine', async () => {
    const { trace, plan } = await syntheticRun();
    const quiet = { ...trace, steps: trace.steps.map((s) => (s.step === 'S3' ? { ...s, calls: [] } : s)) };
    // The calls are renumbered by the run, so only the quiet step differs.
    const noReason = auditOf(quiet, plan);
    assert.ok(checkTrail(noReason, quiet, plan).some((p) => p.includes('made no call and gives no reason')));
    const explained = { ...quiet, steps: quiet.steps.map((s) => (s.step === 'S3' ? { ...s, notes: ['already ticked'] } : s)) };
    assert.ok(!checkTrail(auditOf(explained, plan), explained, plan).some((p) => p.includes('gives no reason')));
  });

  it('masks a secret wherever it would show: the arguments of a call and the error of a failed one', async () => {
    const { trace, plan } = await syntheticRun();
    const dirty: RunTrace = {
      ...trace,
      steps: trace.steps.map((s) =>
        s.step === 'S3'
          ? {
              ...s,
              calls: [
                call(2, { args: { target: '#f2', text: 'Tr0ub4dor-secret' }, outcome: 'failed', error: 'could not type Tr0ub4dor-secret into the field' }),
              ],
            }
          : s,
      ),
    };
    const unmasked = JSON.stringify(auditOf(dirty, plan));
    assert.ok(unmasked.includes('Tr0ub4dor-secret'), 'a trail built without the secrets holds what the record holds');
    const trail = auditOf(dirty, plan, { secrets: ['Tr0ub4dor-secret'] });
    const found = scanForSecrets({ audit: JSON.stringify(trail), rendered: renderTrail(trail) }, ['Tr0ub4dor-secret']);
    assert.deepEqual(found.findings, [], 'the scan finds none once masked');
    assert.equal(scanForSecrets({ audit: unmasked }, ['Tr0ub4dor-secret']).findings.length, 1, 'and it does find one that is not masked');
  });
});

describe('the audit trail of a run in Chrome (GV-02)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let session: ExecutionSession;
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  before(async () => {
    app = await startDemoApp();
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  async function run(port: McpPort = session.port): Promise<{ trace: RunTrace; plan: ExecutionPlan; trail: AuditTrail; secrets: string[] }> {
    const c = await compileCase(raw(), { env: {} });
    assert.ok(c.ir && c.plan, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
    const plan = planActions(c.ir, c.plan);
    const trace = await executePlan({ plan, values: c.values, pages: c.pages }, { mcp: port, page: session.page, baseUrl: app.url });
    const secrets = Object.values(c.values ?? {}).flatMap((v) => (isSecret(v.value) ? [v.value.reveal()] : []));
    await session.reset();
    return { trace, plan, trail: auditOf(trace, plan, { secrets }), secrets };
  }

  it('records every call in order, each action tied to a contract with its page, name and chain of levels, and checks out', async () => {
    const { trace, plan, trail } = await run();
    assert.equal(trace.status, 'completed');
    assert.deepEqual(checkTrail(trail, trace, plan), []);
    assert.deepEqual(
      trail.entries.map((e) => e.seq),
      trail.entries.map((_, i) => i + 1),
    );
    assert.ok(trail.entries.every((e) => e.outcome === 'ok' && e.ms >= 0 && e.at > 0));
    const typed = trail.entries.filter((e) => e.fn === 'type');
    assert.equal(typed.length, 2, 'the username and the password');
    for (const e of typed) {
      const contract = trail.contracts.find((c) => c.id === e.contract);
      assert.ok(contract, `call ${e.seq} names a contract`);
      assert.ok(contract.chain.length > 0 && contract.chain.some((t) => t.outcome === 'used'), 'the chain shows the level that was used');
      assert.ok(contract.semantic.length > 0 && contract.page.length > 0);
      assert.equal(e.args.target, contract.selector, 'the call used the selector of the contract');
    }
    assert.ok(trail.entries.some((e) => e.fn === 'navigate'));
  });

  it('records a call that failed, with the error, and the step it stopped', async () => {
    const failing: McpPort = {
      ...session.port,
      callTool: (name, args) =>
        name === 'browser_click' ? Promise.reject(new Error('the MCP server closed the connection')) : session.port.callTool(name, args),
    };
    const { trace, plan, trail } = await run(failing);
    assert.notEqual(trace.status, 'completed');
    const failed = trail.entries.filter((e) => e.outcome === 'failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.tool, 'browser_click');
    assert.ok(failed[0]?.error?.includes('closed the connection'));
    assert.equal(trail.stoppedAt?.step, failed[0]?.step);
    assert.deepEqual(checkTrail(trail, trace, plan), []);
  });

  it('gives the same contract ids for the same page, name and selector in a second run', async () => {
    const a = await run();
    const b = await run();
    assert.deepEqual(
      a.trail.contracts.map((c) => c.id),
      b.trail.contracts.map((c) => c.id),
    );
    assert.deepEqual(
      a.trail.contracts.map((c) => [c.page, c.semantic, c.selector]),
      b.trail.contracts.map((c) => [c.page, c.semantic, c.selector]),
    );
  });

  it('holds no secret: the password of the test is in no part of the trail or its text', async () => {
    const { trail, secrets } = await run();
    assert.ok(secrets.includes('demo123'));
    const found = scanForSecrets({ audit: JSON.stringify(trail), rendered: renderTrail(trail) }, secrets);
    assert.deepEqual(found.findings, []);
    assert.ok(
      trail.entries.some((e) => JSON.stringify(e.args).includes('••••')),
      'a typed secret is shown as the mask',
    );
  });

  it('holds no one-time code in a login with a mailed code', async () => {
    const mail = new LocalMailbox({ clock: systemClock });
    const store = new CredentialStore(path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-audit-')), 'store.json'), newKey());
    const otpApp = await startDemoApp(0, { onCode: (code) => void mail.deliver({ body: `Your verification code is ${code}.` }) });
    try {
      const c = await compileCase(
        raw({
          steps: [
            `1. Open ${otpApp.url}/otp`,
            "2. Enter 'demo' in the Username field",
            '3. Enter password in the Password field',
            "4. Click the 'Login' button",
            '5. Enter valid OTP in the OTP field',
            "6. Click the 'Verify' button",
          ].join('\n'),
        }),
        { env: {}, otpAtRun: true },
      );
      assert.ok(c.ir && c.plan, JSON.stringify(c.issues.filter((i) => i.severity === 'blocking')));
      const plan = planActions(c.ir, c.plan);
      const otp = createOtpSource(
        { type: 'email-otp', mailbox: { adapter: 'local', address: 'qa@example.test' }, waitSeconds: 20 },
        { store, mail, clock: systemClock },
      );
      const trace = await executePlan({ plan, values: c.values, pages: c.pages }, { mcp: session.port, page: session.page, baseUrl: otpApp.url, otp });
      assert.equal(trace.status, 'completed', JSON.stringify(trace.stoppedAt));
      const sent = mail.messages.map(
        (m) =>
          m.body
            .split(' ')
            .find((w) => w.length === 7 && w.endsWith('.'))
            ?.slice(0, 6) ?? '',
      );
      assert.ok(sent[0] && sent[0].length === 6, 'the code that was mailed');
      const trail = auditOf(trace, plan);
      assert.deepEqual(checkTrail(trail, trace, plan), []);
      const found = scanForSecrets({ audit: JSON.stringify(trail), rendered: renderTrail(trail) }, [sent[0] as string, 'demo123']);
      assert.deepEqual(found.findings, []);
    } finally {
      await otpApp.close();
      await session.reset();
    }
  });
});
