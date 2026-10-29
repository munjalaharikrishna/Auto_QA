import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { RawTestCase } from '../../model/test-model.js';
import { fieldKindOf } from '../data/classes.js';
import { CredentialStore, newKey } from '../data/store.js';
import { otpCodeOf, refusesOtp } from '../patterns/index.js';
import { compileCase } from '../pipeline/compile.js';
import {
  base32Decode,
  createOtpSource,
  hotp,
  LocalMailbox,
  type LoginProfile,
  ManualClock,
  msToNextWindow,
  OtpError,
  ReplayGuard,
  totp,
  validateProfile,
  windowOf,
} from './index.js';

/** E0.9 exit tests: the RFC test vectors, the local mailbox, freshness, replay, the wait and failure rules, and secrecy. */

/** A validator for an error whose message holds a text: the engine's tests use no regular expression (RX-01). */
const hasText =
  (text: string) =>
  (e: unknown): boolean =>
    e instanceof Error && e.message.includes(text);
const digitRuns = (text: string): string[] => {
  const runs: string[] = [];
  let run = '';
  for (const c of `${text} `) {
    if (c >= '0' && c <= '9') run += c;
    else {
      if (run) runs.push(run);
      run = '';
    }
  }
  return runs;
};

const store = async (): Promise<CredentialStore> => new CredentialStore(path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-auth-')), 'store.json'), newKey());

const ASCII_SHA1 = Buffer.from('12345678901234567890');
const ASCII_SHA256 = Buffer.from('12345678901234567890123456789012');
const ASCII_SHA512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');

describe('AU-05: HOTP and TOTP against the RFC test vectors', () => {
  it('RFC 4226 appendix D: the HOTP codes of counters 0 to 9', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    for (const [counter, code] of expected.entries()) assert.equal(hotp(ASCII_SHA1, counter), code, `counter ${counter}`);
  });
  // RFC 6238 appendix B: 8 digits, the time in seconds, one secret per hash.
  const vectors: Array<[seconds: number, sha1: string, sha256: string, sha512: string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [seconds, sha1, sha256, sha512] of vectors) {
    it(`RFC 6238 appendix B at ${seconds} s`, () => {
      assert.equal(totp(ASCII_SHA1, seconds * 1000, { digits: 8, algorithm: 'SHA1' }), sha1);
      assert.equal(totp(ASCII_SHA256, seconds * 1000, { digits: 8, algorithm: 'SHA256' }), sha256);
      assert.equal(totp(ASCII_SHA512, seconds * 1000, { digits: 8, algorithm: 'SHA512' }), sha512);
    });
  }
  it('the secret an authenticator app shows is base32: spaces, case and padding do not matter', () => {
    assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), ASCII_SHA1);
    assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), ASCII_SHA1);
    assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000, { digits: 8 }), '94287082');
    assert.throws(() => base32Decode('not base32!'), hasText('not base32'));
    assert.throws(() => base32Decode(''), hasText('empty'));
  });
  it('the same secret and second always give the same code; the next window gives another', () => {
    assert.equal(totp(ASCII_SHA1, 90_000), totp(ASCII_SHA1, 90_000));
    assert.notEqual(totp(ASCII_SHA1, 90_000), totp(ASCII_SHA1, 120_000));
    assert.equal(windowOf(59_999), 1);
    assert.equal(msToNextWindow(59_000), 1000);
  });
});

describe('AU-09: the local test mailbox and the adapter interface', () => {
  it('a mail is read only when it arrived after the moment asked for (AU-04)', async () => {
    const clock = new ManualClock(1000);
    const box = new LocalMailbox({ clock });
    box.deliver({ body: 'Your code is 111111' }); // an old mail, in the inbox before the login
    clock.advance(5000);
    const since = clock.now();
    const none = await box.waitForMessage({ after: since, timeoutMs: 2000 });
    assert.equal(none, undefined, 'the old mail is ignored');
    box.deliver({ body: 'Your code is 222222' });
    assert.ok(((await box.waitForMessage({ after: since, timeoutMs: 2000 }))?.body ?? '').includes('222222'));
  });
  it('waits for a mail that arrives later, exactly, without a real sleep', async () => {
    const clock = new ManualClock(0);
    const box = new LocalMailbox({ clock });
    box.deliverAt(3000, { body: 'code 654321' });
    const m = await box.waitForMessage({ after: 0, timeoutMs: 10_000 });
    assert.equal(m?.receivedAt, 3000);
    assert.ok(clock.now() >= 3000 && clock.now() <= 3250, `the clock stopped at ${clock.now()}`);
  });
  it('times out when no mail comes, and the newest mail wins', async () => {
    const clock = new ManualClock(0);
    const box = new LocalMailbox({ clock });
    assert.equal(await box.waitForMessage({ after: 0, timeoutMs: 1000 }), undefined);
    assert.equal(clock.now(), 1000);
    box.deliver({ body: 'code 111111', receivedAt: 1100 });
    box.deliver({ body: 'code 222222', receivedAt: 1200 });
    assert.ok(((await box.waitForMessage({ after: 1000, timeoutMs: 0 }))?.body ?? '').includes('222222'));
  });
  it('filters by sender and subject', async () => {
    const box = new LocalMailbox({ clock: new ManualClock(10) });
    box.deliver({ from: 'promo@shop.test', subject: 'Sale', body: 'code 111111', receivedAt: 20 });
    box.deliver({ from: 'security@bank.test', subject: 'Your sign-in code', body: 'code 222222', receivedAt: 21 });
    const m = await box.waitForMessage({ after: 0, timeoutMs: 0, from: 'security@', subjectContains: 'sign-in' });
    assert.ok((m?.body ?? '').includes('222222'));
  });
  it('a connection failure says why (AU-03)', async () => {
    const box = new LocalMailbox({ clock: new ManualClock(0) });
    box.failConnect = 'wrong password for the mailbox';
    await assert.rejects(() => box.connect(), hasText('wrong password'));
  });
});

describe('AU-04: the code is read with the pattern layer', () => {
  it('finds the code in a mail, and nothing in text without one', () => {
    assert.equal(otpCodeOf('Your verification code is 482913. It expires in 10 minutes.'), '482913');
    assert.equal(otpCodeOf('Hello, no digits here'), undefined);
    assert.equal(otpCodeOf('Order 12345678901 shipped'), undefined);
  });
  it('AU-06: knows the message an application shows for a refused code', () => {
    assert.ok(refusesOtp('Invalid OTP'));
    assert.ok(refusesOtp('The code you entered is incorrect'));
    assert.ok(!refusesOtp('Invalid username or password'));
  });
});

const emailProfile = (over: Partial<LoginProfile> = {}): LoginProfile => ({
  type: 'email-otp',
  mailbox: { adapter: 'local', address: 'qa@example.test' },
  waitSeconds: 10,
  ...over,
});

describe('AU-04 and AU-06: the email code for one login', () => {
  it('uses the mail that arrives after the login step', async () => {
    const clock = new ManualClock(100_000);
    const mail = new LocalMailbox({ clock });
    mail.deliver({ body: 'Your code is 111111' }); // before the login: ignored
    clock.advance(1000);
    const since = clock.now();
    mail.deliverAt(since + 2000, { body: 'Your code is 777888' });
    const source = createOtpSource(emailProfile(), { store: await store(), mail, clock });
    assert.equal((await source.code({ since })).reveal(), '777888');
  });
  it('a mail is used for one login only: a second request does not get the same code (replay)', async () => {
    const clock = new ManualClock(0);
    const mail = new LocalMailbox({ clock });
    const guard = new ReplayGuard();
    const source = createOtpSource(emailProfile({ waitSeconds: 3 }), { store: await store(), mail, clock, guard });
    mail.deliver({ body: 'code 123456', receivedAt: 5 });
    assert.equal((await source.code({ since: 0 })).reveal(), '123456');
    await assert.rejects(
      () => source.code({ since: 0 }),
      (e: unknown) => e instanceof OtpError && e.kind === 'NOT_RECEIVED',
    );
    mail.deliver({ body: 'code 654321', receivedAt: clock.now() + 1 });
    assert.equal((await source.code({ since: 0 })).reveal(), '654321');
  });
  it('no mail within the wait is NOT_RECEIVED with the wait in the message', async () => {
    const clock = new ManualClock(0);
    const source = createOtpSource(emailProfile({ waitSeconds: 4 }), { store: await store(), mail: new LocalMailbox({ clock }), clock });
    await assert.rejects(
      () => source.code({ since: 0 }),
      (e: unknown) => e instanceof OtpError && e.kind === 'NOT_RECEIVED' && e.message.includes('not received within 4 s'),
    );
  });
  it('a mail without a code is skipped, and a later one is used', async () => {
    const clock = new ManualClock(0);
    const mail = new LocalMailbox({ clock });
    mail.deliver({ body: 'Welcome to the service', receivedAt: 1 });
    mail.deliverAt(2000, { body: 'code 909090' });
    const source = createOtpSource(emailProfile(), { store: await store(), mail, clock });
    assert.equal((await source.code({ since: 0 })).reveal(), '909090');
  });
  it('a sender filter ignores a mail from someone else', async () => {
    const clock = new ManualClock(0);
    const mail = new LocalMailbox({ clock });
    mail.deliver({ from: 'promo@shop.test', body: 'code 111111', receivedAt: 5 });
    mail.deliver({ from: 'security@bank.test', body: 'code 222222', receivedAt: 6 });
    const profile = emailProfile();
    profile.mailbox = { adapter: 'local', address: 'qa@example.test', sender: 'security@' };
    assert.equal((await createOtpSource(profile, { store: await store(), mail, clock }).code({ since: 0 })).reveal(), '222222');
  });
});

describe('AU-05: the authenticator code for one login', () => {
  const profile: LoginProfile = { type: 'totp', totp: { secretRef: 'totp.secret' }, waitSeconds: 40 };
  it('gives the code of the current window from the stored secret', async () => {
    const s = await store();
    await s.set('totp.secret', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const clock = new ManualClock(1_111_111_100_000 + 5_000);
    const source = createOtpSource(profile, { store: s, clock });
    assert.equal((await source.code({ since: 0 })).reveal(), totp(ASCII_SHA1, clock.now()));
  });
  it('a window is used once: the next request waits for the next window (replay)', async () => {
    const s = await store();
    await s.set('totp.secret', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const clock = new ManualClock(90_000 + 3_000);
    const source = createOtpSource(profile, { store: s, clock });
    const first = (await source.code({ since: 0 })).reveal();
    const second = (await source.code({ since: 0 })).reveal();
    assert.notEqual(first, second);
    assert.equal(windowOf(clock.now()), 4, 'the clock moved to the next window');
  });
  it('a code about to expire is not typed: the next window is waited for', async () => {
    const s = await store();
    await s.set('totp.secret', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const clock = new ManualClock(90_000 + 29_000); // one second left
    const code = (await createOtpSource(profile, { store: s, clock }).code({ since: 0 })).reveal();
    assert.equal(code, totp(ASCII_SHA1, 120_000));
  });
  it('after a refusal the next window is used, once', async () => {
    const s = await store();
    await s.set('totp.secret', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const clock = new ManualClock(90_000 + 5_000);
    const source = createOtpSource(profile, { store: s, clock });
    const retry = (await source.code({ since: 0, retry: true })).reveal();
    assert.equal(retry, totp(ASCII_SHA1, 120_000));
    await assert.rejects(() => source.code({ since: 0, retry: true }), hasText('used already'));
  });
  it('a missing secret is NOT_CONFIGURED, and the message names the store entry, not a value', async () => {
    const source = createOtpSource(profile, { store: await store(), clock: new ManualClock(0) });
    await assert.rejects(
      () => source.code({ since: 0 }),
      (e: unknown) => e instanceof OtpError && e.kind === 'NOT_CONFIGURED' && e.message.includes('totp.secret'),
    );
  });
});

describe('AU-01 and AU-02: the login type asks for what it needs and nothing else', () => {
  it('each supported type names its missing fields', () => {
    assert.deepEqual(validateProfile({ type: 'password' }), []);
    assert.deepEqual(validateProfile(emailProfile()), []);
    assert.ok(validateProfile({ type: 'email-otp' }).some((p) => p.includes('mailbox.address')));
    assert.ok(validateProfile({ type: 'totp' }).some((p) => p.includes('totp.secretRef')));
    assert.ok(validateProfile({ type: 'fixed-otp' }).some((p) => p.includes('fixed.codeRef')));
  });
  it('a mail adapter that does not exist is refused, and SMS says it is not supported', () => {
    assert.ok(validateProfile({ type: 'email-otp', mailbox: { adapter: 'gmail', address: 'a@b.test' } }).some((p) => p.includes('"gmail"')));
    assert.deepEqual(validateProfile({ type: 'sms-otp' }), ['Username, password and SMS code is not supported yet']);
  });
  it('a fixed test code comes from the store and may repeat', async () => {
    const s = await store();
    await s.set('otp.valid', '000000');
    const source = createOtpSource({ type: 'fixed-otp', fixed: { codeRef: 'otp.valid' } }, { store: s, clock: new ManualClock(0) });
    assert.equal((await source.code({ since: 0 })).reveal(), '000000');
    assert.equal((await source.code({ since: 0 })).reveal(), '000000');
  });
  it('a profile that cannot work is refused before any login', async () => {
    assert.throws(() => createOtpSource({ type: 'totp' }, { store: undefined as never, clock: new ManualClock(0) }), OtpError);
    assert.throws(() => createOtpSource({ type: 'password' }, { store: undefined as never, clock: new ManualClock(0) }), hasText('no one-time code'));
  });
});

describe('AU-07: the code and the secret are never written', () => {
  it('a code is a Secret: text, JSON and the error messages never hold it', async () => {
    const clock = new ManualClock(0);
    const mail = new LocalMailbox({ clock });
    mail.deliver({ body: 'code 135791', receivedAt: 5 });
    const s = await store();
    await s.set('totp.secret', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const code = await createOtpSource(emailProfile(), { store: s, mail, clock }).code({ since: 0 });
    assert.equal(String(code), '***');
    assert.equal(JSON.stringify({ code }), '{"code":"***"}');
    const totpSource = createOtpSource({ type: 'totp', totp: { secretRef: 'totp.secret' } }, { store: s, clock: new ManualClock(1000) });
    const t = (await totpSource.code({ since: 0 })).reveal();
    assert.ok(!JSON.stringify(createOtpSource(emailProfile(), { store: s, mail, clock })).includes('135791'));
    assert.ok(!JSON.stringify({ profile: emailProfile() }).includes('135791') && !JSON.stringify({ profile: emailProfile() }).includes(t));
  });
});

describe('AU-01 and AU-08: "the valid OTP" has a source; a wrong one is made up', () => {
  const raw = (otpStep: string, extra: Partial<RawTestCase> = {}): RawTestCase => ({
    id: 'T-OTP',
    title: 'Code step',
    steps: `1. Open the Login page\n2. ${otpStep}\n3. Click the Verify button`,
    expected: 'The Dashboard heading is displayed',
    ...extra,
  });
  it('a field named for a one-time code is not a made-up value, and "footprint" is not one', () => {
    for (const name of ['OTP', 'One Time Password', 'Verification Code', 'OTP code', 'Authentication code']) assert.equal(fieldKindOf(name), 'otp', name);
    for (const name of ['Footprint', 'Employee Code', 'Hotpot', 'Username']) assert.notEqual(fieldKindOf(name), 'otp', name);
  });
  it('the valid code is read when the test runs: the plan and the data table hold no value (AU-07)', async () => {
    const c = await compileCase(raw('Enter valid OTP in the OTP field'), { env: {}, otpAtRun: true });
    const entry = Object.values(c.ir?.data ?? {}).find((d) => d.rule === 'otp.at-run');
    assert.deepEqual([entry?.source, entry?.secret, entry?.value], ['APPLICATION', true, '***']);
    assert.ok(c.issues.every((i) => i.code !== 'MISSING_DATA'));
    assert.ok(!digitRuns(JSON.stringify(c)).some((r) => r.length === 6), 'no six-digit code anywhere in the compile');
  });
  it('without a login type there is no source: the code is asked for, never made up', async () => {
    const c = await compileCase(raw('Enter valid OTP in the OTP field'), { env: {} });
    assert.ok(
      c.issues.some((i) => i.code === 'MISSING_DATA' && i.message.toLowerCase().includes('otp')),
      JSON.stringify(c.issues),
    );
    assert.ok(!Object.values(c.values ?? {}).some((v) => v.source === 'GENERATOR'));
  });
  it('a fixed test code in the environment wins over the login type (the order of DR-01)', async () => {
    const c = await compileCase(raw('Enter valid OTP in the OTP field'), { env: { TEST_OTP: '000000' }, otpAtRun: true });
    const v = Object.values(c.values ?? {}).find((x) => x.field.toLowerCase() === 'otp');
    assert.equal(v?.source, 'ENV');
  });
  it('a wrong code is generated, with no mailbox: the negative test of AU-08', async () => {
    const c = await compileCase(raw('Enter invalid OTP in the OTP field'), { env: {}, otpAtRun: true });
    const v = Object.values(c.values ?? {}).find((x) => x.field.toLowerCase() === 'otp');
    assert.equal(v?.source, 'GENERATOR');
    assert.equal(v?.rule, 'invalid.otp');
  });
});
