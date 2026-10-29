import type http from 'node:http';
import { totp } from '../../src/engine/auth/totp.js';

/**
 * Login with a one-time code, for the tests of the OTP flow (AU-04, AU-05). No internet and no real mail: the app "sends" the
 * code by calling `onCode`, and the test puts it into its local mailbox, so it is the same every run.
 *
 *   /otp    username + password, then a code that was "mailed"        (user demo / demo123)
 *   /totp   username + password, then the code of an authenticator app (secret DEMO_TOTP_SECRET)
 */

export const DEMO_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

export interface OtpDemoOptions {
  /** Called with each code the app "sends", at the time it is sent. */
  onCode?: (code: string, at: number) => void;
  /** How long a mailed code lives. */
  ttlMs?: number;
  /** The clock of the app, so a test controls what "now" is for the authenticator. */
  now?: () => number;
}

const layout = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:40px;max-width:640px} label{display:block;margin:10px 0 4px} [role=alert]{color:#b00020;margin-top:12px}</style>
</head><body>${body}</body></html>`;

const page = (title: string, api: string): string =>
  layout(
    title,
    `<h1>${title}</h1>
<form id="login" aria-label="Login">
  <label for="username">Username</label><input id="username" name="username" autocomplete="off">
  <label for="password">Password</label><input id="password" name="password" type="password">
  <p><button type="submit">Login</button></p>
</form>
<form id="otpform" aria-label="Verification" hidden>
  <p id="sent" role="status">Enter the code we sent you.</p>
  <label for="otp">OTP</label><input id="otp" name="otp" autocomplete="off">
  <p><button type="submit">Verify</button></p>
</form>
<div id="error" role="alert" hidden></div>
<script>
const fail = (m) => { error.hidden = false; error.textContent = m; };
login.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('${api}/start', { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) });
  if (!r.ok) return fail('Invalid username or password');
  error.hidden = true; login.hidden = true; otpform.hidden = false;
});
otpform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('${api}/verify', { method: 'POST', body: JSON.stringify({ code: otp.value }) });
  if (r.ok) { location.href = '/dashboard'; } else fail('Invalid OTP');
});
</script>`,
  );

export const OTP_PAGES: Record<string, string> = {
  '/otp': page('Sign in with a code', '/api/otp'),
  '/totp': page('Sign in with an authenticator', '/api/totp'),
};

const readBody = (req: http.IncomingMessage): Promise<Record<string, string>> =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });

/** The API of the two pages. Returns true when the request was one of theirs. */
export function otpApi(options: OtpDemoOptions = {}): (req: http.IncomingMessage, res: http.ServerResponse, path: string) => boolean {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 60_000;
  let counter = 0;
  let mailed: { code: string; at: number } | undefined;
  const reply = (res: http.ServerResponse, status: number): void => void res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
  const credentialsOk = (b: Record<string, string>): boolean => b.username === 'demo' && b.password === 'demo123';
  return (req, res, path) => {
    if (req.method !== 'POST') return false;
    if (path === '/api/otp/start' || path === '/api/totp/start') {
      readBody(req).then((b) => {
        if (!credentialsOk(b)) return reply(res, 401);
        if (path === '/api/otp/start') {
          counter++;
          const code = String(100000 + ((counter * 7919 + 13) % 900000));
          mailed = { code, at: now() };
          options.onCode?.(code, mailed.at);
        }
        reply(res, 200);
      });
      return true;
    }
    if (path === '/api/otp/verify') {
      readBody(req).then((b) => {
        const ok = mailed !== undefined && b.code === mailed.code && now() - mailed.at <= ttl;
        if (ok) mailed = undefined; // a code works once
        reply(res, ok ? 200 : 401);
      });
      return true;
    }
    if (path === '/api/totp/verify') {
      readBody(req).then((b) => reply(res, b.code === totp(DEMO_TOTP_SECRET, now()) ? 200 : 401));
      return true;
    }
    return false;
  };
}
