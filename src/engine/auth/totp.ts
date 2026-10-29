import { createHmac } from 'node:crypto';

/**
 * AU-05: the authenticator code (TOTP, RFC 6238) and the counter code it is built on (HOTP, RFC 4226). The code is a
 * function of the secret and the clock only: the same secret at the same second always gives the same code, so a test
 * can pin the clock and know the answer. Nothing here reads a clock; the caller passes the time.
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpOptions {
  /** 6 for every authenticator app; the RFC test vectors use 8. */
  digits?: number;
  /** Seconds a code lives. 30 for every authenticator app. */
  period?: number;
  algorithm?: TotpAlgorithm;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The secret an authenticator app shows is base32 (RFC 4648): spaces, dashes, padding and case do not count. */
export function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const raw of text.toUpperCase()) {
    if (raw === ' ' || raw === '-' || raw === '=') continue;
    const index = BASE32.indexOf(raw);
    if (index < 0) throw new Error('the authenticator secret is not base32: it holds a character outside A-Z and 2-7');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) throw new Error('the authenticator secret is empty');
  return Buffer.from(bytes);
}

/** HOTP (RFC 4226): the code for a counter. */
export function hotp(secret: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = 'SHA1'): string {
  if (!Number.isInteger(counter) || counter < 0) throw new Error('the counter must be a whole number, zero or more');
  if (digits < 4 || digits > 10) throw new Error('a code has 4 to 10 digits');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), secret).update(message).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The number of the time window a moment falls in: the counter of TOTP. */
export const windowOf = (timeMs: number, period = 30): number => Math.floor(timeMs / 1000 / period);

/** Milliseconds from a moment to the start of the next window. */
export const msToNextWindow = (timeMs: number, period = 30): number => (windowOf(timeMs, period) + 1) * period * 1000 - timeMs;

/** TOTP (RFC 6238): the code at a moment. `secret` is what the authenticator app shows (base32) or the raw bytes. */
export function totp(secret: string | Buffer, timeMs: number, options: TotpOptions = {}): string {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  return hotp(key, windowOf(timeMs, options.period), options.digits, options.algorithm);
}

/** The code of a given window, for the next-window retry (AU-05). */
export function totpOfWindow(secret: string | Buffer, window: number, options: TotpOptions = {}): string {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  return hotp(key, window, options.digits, options.algorithm);
}
