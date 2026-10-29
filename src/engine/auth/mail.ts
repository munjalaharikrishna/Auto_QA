/**
 * AU-09: the email adapter. All mail access goes through this one interface: connect, wait for a message after a moment,
 * read it. A provider is a separate adapter; nothing outside an adapter knows which provider is in use. The first adapter
 * is the local test mailbox (`local-mail.ts`). No real provider is chosen yet (PD-5).
 *
 * Time comes from a `Clock`, so that waiting is deterministic in a test and never a fixed sleep in the engine's own code.
 */

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /**
   * Resolves when the clock reaches `at`. The engine never waits by a timer of its own (UI-09): the clock is given to it.
   * The real clock is `src/pipeline/clock.ts`; a `ManualClock` reaches the moment at once.
   */
  waitUntil(at: number): Promise<void>;
}

/** A clock that only moves when it is told to, or when something waits for a moment: a test sets the time and the waiting is exact. */
export class ManualClock implements Clock {
  constructor(private time = 0) {}

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  async waitUntil(at: number): Promise<void> {
    if (at > this.time) this.time = at;
  }
}

export interface MailMessage {
  /** Unique in the mailbox. A message is used for one login only (replay protection). */
  id: string;
  from: string;
  to?: string;
  subject: string;
  body: string;
  /** When the mailbox received it, on the mailbox's clock. */
  receivedAt: number;
}

export interface MailQuery {
  /** Only a message received after this moment counts (AU-04): an older mail in the inbox is never used. */
  after: number;
  /** How long to wait for one. */
  timeoutMs: number;
  /** A message whose sender holds this text. */
  from?: string;
  /** A message whose subject holds this text. */
  subjectContains?: string;
  /** Messages that were used already; they are skipped, and the wait goes on. */
  skip?: ReadonlySet<string>;
}

export interface MailAdapter {
  readonly name: string;
  /** Opens the mailbox. A failure says why in words (wrong password, server unreachable, access disabled): AU-03. */
  connect(): Promise<void>;
  /** The newest message that matches and arrived after `query.after`, or undefined when none came within the time. */
  waitForMessage(query: MailQuery): Promise<MailMessage | undefined>;
}
