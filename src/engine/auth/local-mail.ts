import type { Clock, MailAdapter, MailMessage, MailQuery } from './mail.js';

/**
 * The local test mailbox: the first email adapter (AU-09). It lives in the process, holds mail in memory and opens no
 * network connection, so a test of the OTP flow is fast and the same every time. A test delivers a mail now, or schedules
 * it for a moment on the clock, to play "the mail arrives three seconds after the login". With a `ManualClock` the waiting is exact.
 */

export interface LocalMailboxOptions {
  /** The clock the mailbox waits by: the real one in a run, a `ManualClock` in a test. */
  clock: Clock;
  /** How often the mailbox is looked at while waiting. */
  pollMs?: number;
}

export type NewMail = Omit<MailMessage, 'id' | 'receivedAt' | 'from' | 'subject'> & Partial<Pick<MailMessage, 'id' | 'receivedAt' | 'from' | 'subject'>>;

export class LocalMailbox implements MailAdapter {
  readonly name = 'local';
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly inbox: MailMessage[] = [];
  private readonly due: Array<{ at: number; mail: NewMail }> = [];
  private counter = 0;
  /** Set by a test to play a broken mailbox: the next `connect` fails with this reason. */
  failConnect?: string;

  constructor(options: LocalMailboxOptions) {
    this.clock = options.clock;
    this.pollMs = options.pollMs ?? 250;
  }

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error(this.failConnect);
  }

  /** A mail arrives now, or at the moment it is given. */
  deliver(mail: NewMail): MailMessage {
    const message: MailMessage = {
      id: mail.id ?? `m${++this.counter}`,
      from: mail.from ?? 'no-reply@example.test',
      subject: mail.subject ?? 'Your verification code',
      body: mail.body,
      receivedAt: mail.receivedAt ?? this.clock.now(),
      ...(mail.to ? { to: mail.to } : {}),
    };
    this.inbox.push(message);
    return message;
  }

  /** A mail that arrives when the clock reaches `at`. */
  deliverAt(at: number, mail: NewMail): void {
    this.due.push({ at, mail: { ...mail, receivedAt: at } });
  }

  get messages(): readonly MailMessage[] {
    return this.inbox;
  }

  private flushDue(): void {
    const now = this.clock.now();
    for (const d of this.due.filter((x) => x.at <= now)) {
      this.due.splice(this.due.indexOf(d), 1);
      this.deliver(d.mail);
    }
  }

  private newest(q: MailQuery): MailMessage | undefined {
    return this.inbox
      .filter(
        (m) =>
          m.receivedAt > q.after &&
          !q.skip?.has(m.id) &&
          (q.from === undefined || m.from.toLowerCase().includes(q.from.toLowerCase())) &&
          (q.subjectContains === undefined || m.subject.toLowerCase().includes(q.subjectContains.toLowerCase())),
      )
      .sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id))[0];
  }

  async waitForMessage(query: MailQuery): Promise<MailMessage | undefined> {
    const until = this.clock.now() + query.timeoutMs;
    for (;;) {
      this.flushDue();
      const found = this.newest(query);
      if (found) return found;
      const left = until - this.clock.now();
      if (left <= 0) return undefined;
      await this.clock.waitUntil(this.clock.now() + Math.min(this.pollMs, left));
    }
  }
}
