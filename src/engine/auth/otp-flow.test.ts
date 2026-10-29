import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEMO_TOTP_SECRET } from '../../../examples/demo-app/otp-pages.js';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import type { RawTestCase } from '../../model/test-model.js';
import { systemClock } from '../../pipeline/clock.js';
import { CredentialStore, newKey } from '../data/store.js';
import { type ExecutionSession, executePlan, openExecutionSession, type RunTrace } from '../execute/index.js';
import { planActions } from '../execute/planner.js';
import { compileCase } from '../pipeline/compile.js';
import { judge, renderVerdict, type Verdict } from '../verdict/index.js';
import { createOtpSource, LocalMailbox, type LoginProfile, type OtpSource } from './index.js';

/**
 * E0.9 exit tests on a real browser: a login with a one-time code completes with no action by the user, an old mail is
 * never used, a wrong code is a normal test, and a mail that does not come or a code that is refused is never a FAIL.
 * Needs Google Chrome and no internet. AUTO_QA_SKIP_BROWSER=1 skips them.
 */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

describe('login with a one-time code on the demo app', { skip }, () => {
  let session: ExecutionSession;
  before(async () => {
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
  });

  const credentials = async (): Promise<CredentialStore> => {
    const store = new CredentialStore(path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-otp-')), 'store.json'), newKey());
    await store.set('totp.secret', DEMO_TOTP_SECRET);
    return store;
  };

  /** One run of the login case against a fresh app: `otp` decides where the code comes from. */
  async function login(
    path: '/otp' | '/totp',
    setup: { mailbox?: LocalMailbox; otp?: (url: string) => Promise<OtpSource>; ttlMs?: number; silent?: boolean },
    otpStep = 'Enter valid OTP in the OTP field',
  ): Promise<{ verdict: Verdict; trace: RunTrace; sent: string[] }> {
    const sent: string[] = [];
    const mailbox = setup.mailbox ?? new LocalMailbox({ clock: systemClock });
    const app = await startDemoApp(0, {
      ttlMs: setup.ttlMs,
      onCode: (code) => {
        sent.push(code);
        if (!setup.silent) mailbox.deliver({ body: `Your verification code is ${code}. It expires in 10 minutes.` });
      },
    });
    try {
      const raw: RawTestCase = {
        id: 'T-E09',
        title: 'Login with a code',
        steps: [
          `Open ${app.url}${path}`,
          "Enter 'demo' in the Username field",
          'Enter password in the Password field',
          "Click the 'Login' button",
          otpStep,
          "Click the 'Verify' button",
        ]
          .map((s, i) => `${i + 1}. ${s}`)
          .join('\n'),
        expected: 'The Dashboard heading is displayed',
        testData: 'Password: demo123',
      };
      const compile = await compileCase(raw, { env: {}, otpAtRun: true });
      assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
      const trace = await executePlan(
        { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
        { mcp: session.port, page: session.page, baseUrl: app.url, ...(setup.otp ? { otp: await setup.otp(app.url) } : {}) },
      );
      return { verdict: judge({ compile, trace }), trace, sent };
    } finally {
      await app.close();
      await session.reset();
    }
  }

  const emailProfile = (waitSeconds = 20): LoginProfile => ({ type: 'email-otp', mailbox: { adapter: 'local', address: 'qa@example.test' }, waitSeconds });
  const emailSource = (mail: LocalMailbox, waitSeconds?: number) => async (): Promise<OtpSource> =>
    createOtpSource(emailProfile(waitSeconds), { store: await credentials(), mail, clock: systemClock });

  it('AU-04: an email code is read after the login step and typed: the login completes with no user action', async () => {
    const mail = new LocalMailbox({ clock: systemClock });
    mail.deliver({ body: 'Your verification code is 111111' }); // an old mail from an older login: must not be used
    const { verdict, trace, sent } = await login('/otp', { mailbox: mail, otp: emailSource(mail) });
    assert.equal(verdict.verdict, 'PASS', renderVerdict(verdict));
    assert.equal(trace.status, 'completed');
    assert.equal(sent.length, 1);
    const typed = trace.steps.find((s) => s.original.includes('OTP'));
    assert.ok(
      typed?.calls.some((c) => c.tool === 'browser_type' && c.args.text === '••••'),
      'the code is typed and shown masked',
    );
  });

  it('AU-07: the code is in no part of the trace or the verdict', async () => {
    const mail = new LocalMailbox({ clock: systemClock });
    const { verdict, trace, sent } = await login('/otp', { mailbox: mail, otp: emailSource(mail) });
    const code = sent[0] as string;
    for (const output of [JSON.stringify(trace), JSON.stringify(verdict), renderVerdict(verdict)]) {
      const at = output.indexOf(code);
      assert.ok(at < 0, `the code is written: …${output.slice(Math.max(0, at - 120), at + 40)}…`);
    }
  });

  it('AU-05: an authenticator code is computed from the stored secret and accepted on the first try', async () => {
    const { verdict, trace } = await login('/totp', {
      otp: async () =>
        createOtpSource({ type: 'totp', totp: { secretRef: 'totp.secret' }, waitSeconds: 40 }, { store: await credentials(), clock: systemClock }),
    });
    assert.equal(verdict.verdict, 'PASS', renderVerdict(verdict));
    for (const output of [JSON.stringify(trace), JSON.stringify(verdict)])
      assert.ok(!output.includes(DEMO_TOTP_SECRET), 'the authenticator secret is not written');
  });

  it('AU-08: a wrong code is an ordinary test: the mailbox is not read and the error is checked', async () => {
    const mail = new LocalMailbox({ clock: systemClock });
    let asked = 0;
    const { verdict, trace } = await login(
      '/otp',
      {
        mailbox: mail,
        otp: async () => {
          const real = createOtpSource(emailProfile(), { store: await credentials(), mail, clock: systemClock });
          return {
            ...real,
            code: (r) => {
              asked++;
              return real.code(r);
            },
          };
        },
      },
      'Enter invalid OTP in the OTP field',
    );
    assert.equal(asked, 0, 'no code was read from the mailbox');
    assert.equal(trace.status, 'completed');
    assert.notEqual(verdict.verdict, 'TEST_DATA_ERROR');
    assert.ok(
      trace.steps.some((s) => s.after?.messages.some((m) => m.includes('Invalid OTP'))),
      'the application showed its error',
    );
  });

  it('AU-06: no mail within the wait is ENVIRONMENT_ERROR "OTP mail not received", never FAIL', async () => {
    const mail = new LocalMailbox({ clock: systemClock });
    const { verdict, trace } = await login('/otp', { mailbox: mail, silent: true, otp: emailSource(mail, 2) });
    assert.equal(trace.stoppedAt?.code, 'OTP_MAIL_NOT_RECEIVED');
    assert.equal(verdict.verdict, 'ENVIRONMENT_ERROR', renderVerdict(verdict));
    assert.equal(verdict.rootCause, 'ENVIRONMENT');
    assert.ok(verdict.reason.includes('OTP mail not received'), verdict.reason);
  });

  it('AU-06: a code the application refuses is TEST_DATA_ERROR, never FAIL', async () => {
    const mail = new LocalMailbox({ clock: systemClock });
    const { verdict, trace } = await login('/otp', { mailbox: mail, ttlMs: -1, otp: emailSource(mail) });
    assert.equal(trace.stoppedAt?.code, 'OTP_REJECTED');
    assert.equal(verdict.verdict, 'TEST_DATA_ERROR', renderVerdict(verdict));
    assert.equal(verdict.rootCause, 'TEST_DATA');
  });

  it('a step that needs a code but has no source is not run, and says why (TEST_DATA_ERROR)', async () => {
    const { verdict, trace } = await login('/otp', {});
    assert.equal(trace.stoppedAt?.code, 'VALUE_UNRESOLVED');
    assert.equal(verdict.verdict, 'TEST_DATA_ERROR');
    assert.ok((trace.stoppedAt?.reason ?? '').includes('login type'));
  });

  it('exit test: 20 logins in a row complete with no action by the user', { timeout: 300_000 }, async () => {
    const mail = new LocalMailbox({ clock: systemClock });
    const source = await emailSource(mail)();
    for (let i = 1; i <= 20; i++) {
      const { verdict, trace, sent } = await login('/otp', { mailbox: mail, otp: async () => source });
      // When it fails, say what the app did and what the page showed after the login click: the cause is in the first of these.
      const afterLogin = trace.steps.find((st) => st.original.includes('Login'));
      const why = `codes sent by the app: ${sent.length}; after the click: ${JSON.stringify(afterLogin?.changes)} ${JSON.stringify(afterLogin?.after?.messages)}`;
      assert.equal(
        verdict.verdict,
        'PASS',
        `login ${i}: ${renderVerdict(verdict)}
${why}`,
      );
    }
  });
});
