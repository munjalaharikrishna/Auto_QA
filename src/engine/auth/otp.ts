import { Secret } from '../data/secret.js';
import type { CredentialStore } from '../data/store.js';
import { otpCodeOf } from '../patterns/index.js';
import type { Clock, MailAdapter } from './mail.js';
import { DEFAULT_WAIT_SECONDS, type LoginProfile, validateProfile } from './profile.js';
import { msToNextWindow, totpOfWindow, windowOf } from './totp.js';

/**
 * AU-04 to AU-06: where the one-time code of a login comes from when the test runs. The code is made for one login:
 * a mail is used once, and an authenticator window is used once (replay protection), so a stale or repeated code is
 * never typed. A failure is a named kind, which the executor maps to a verdict that is never FAIL (AU-06): the mail not
 * coming is the environment; a missing secret is test data.
 */

export type OtpFailure = 'NOT_RECEIVED' | 'NOT_CONFIGURED';

export class OtpError extends Error {
  constructor(
    readonly kind: OtpFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OtpError';
  }
}

export interface OtpRequest {
  /**
   * The moment the login step started. Only a mail received after it counts: an older one in the inbox is for an older login (AU-04).
   */
  since: number;
  /** The code was refused once: use the next window of the authenticator clock, once (AU-05). */
  retry?: boolean;
}

export interface OtpSource {
  readonly type: LoginProfile['type'];
  /** The clock the source waits by; the executor takes the moment of a step from it. */
  now(): number;
  code(request: OtpRequest): Promise<Secret>;
}

/** The codes and mails already used, by source: a code is never typed twice (replay protection). */
export class ReplayGuard {
  private readonly used = new Set<string>();

  has(token: string): boolean {
    return this.used.has(token);
  }

  /** Marks a token used. Returns false when it already was. */
  use(token: string): boolean {
    if (this.used.has(token)) return false;
    this.used.add(token);
    return true;
  }
}

export interface OtpDeps {
  store: CredentialStore;
  /** The mailbox, for an email code. */
  mail?: MailAdapter;
  /** The clock the source waits by (see `Clock`). */
  clock: Clock;
  guard?: ReplayGuard;
}

/** Seconds before the end of an authenticator window below which the next window is waited for: a code about to expire is not typed. */
const EXPIRY_MARGIN_MS = 2000;

async function secretNamed(store: CredentialStore, name: string, what: string): Promise<Secret> {
  const s = await store.get(name);
  if (!s) throw new OtpError('NOT_CONFIGURED', `${what} is not in the credential store (name: ${name})`);
  return s;
}

/** Builds the source for a login profile. A profile that cannot work is refused here, before any login. */
export function createOtpSource(profile: LoginProfile, deps: OtpDeps): OtpSource {
  const problems = validateProfile(profile);
  if (profile.type === 'password') throw new OtpError('NOT_CONFIGURED', 'this application logs in with a password only: there is no one-time code');
  if (problems.length) throw new OtpError('NOT_CONFIGURED', problems.join('; '));
  const clock = deps.clock;
  const guard = deps.guard ?? new ReplayGuard();
  const waitMs = (profile.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
  const base = { type: profile.type, now: () => clock.now() };

  if (profile.type === 'fixed-otp') {
    const ref = profile.fixed?.codeRef as string;
    // A fixed code is the same every time by definition, so it is not guarded against repeats.
    return { ...base, code: async () => secretNamed(deps.store, ref, 'the fixed test code') };
  }

  if (profile.type === 'totp') {
    const t = profile.totp as NonNullable<LoginProfile['totp']>;
    const period = t.period ?? 30;
    return {
      ...base,
      async code({ retry }) {
        const secret = (await secretNamed(deps.store, t.secretRef, 'the authenticator secret')).reveal();
        let at = clock.now();
        // A window that is nearly over, or was used already, is not used: the next one is waited for, within the wait limit.
        if (guard.has(`totp:${t.secretRef}:${windowOf(at, period)}`) || msToNextWindow(at, period) < EXPIRY_MARGIN_MS) {
          const wait = msToNextWindow(at, period);
          if (wait > waitMs) throw new OtpError('NOT_RECEIVED', 'the next authenticator window is further away than the wait limit');
          await clock.waitUntil(at + wait);
          at = clock.now();
        }
        // After a refusal, the clocks may differ: the next window is used, once.
        const window = windowOf(at, period) + (retry ? 1 : 0);
        if (!guard.use(`totp:${t.secretRef}:${window}`)) throw new OtpError('NOT_RECEIVED', 'the authenticator code of this window was used already');
        return new Secret(totpOfWindow(secret, window, { digits: t.digits, period, algorithm: t.algorithm }));
      },
    };
  }

  // email-otp
  const mailbox = profile.mailbox as NonNullable<LoginProfile['mailbox']>;
  const mail = deps.mail;
  if (!mail) throw new OtpError('NOT_CONFIGURED', `the mail adapter "${mailbox.adapter}" is not connected`);
  return {
    ...base,
    async code({ since }) {
      const used = new Set<string>();
      const deadline = clock.now() + waitMs;
      for (;;) {
        const left = deadline - clock.now();
        const message = await mail.waitForMessage({
          after: since,
          timeoutMs: Math.max(0, left),
          ...(mailbox.sender ? { from: mailbox.sender } : {}),
          ...(mailbox.subjectContains ? { subjectContains: mailbox.subjectContains } : {}),
          skip: new Set(used),
        });
        if (!message) throw new OtpError('NOT_RECEIVED', `OTP mail not received within ${waitMs / 1000} s`);
        // A mail is used for one login only.
        if (guard.has(`mail:${message.id}`)) {
          used.add(message.id);
          continue;
        }
        const code = otpCodeOf(message.body);
        if (code === undefined) {
          used.add(message.id);
          if (clock.now() >= deadline) throw new OtpError('NOT_RECEIVED', 'OTP mail arrived but holds no code');
          continue;
        }
        guard.use(`mail:${message.id}`);
        return new Secret(code);
      }
    },
  };
}
