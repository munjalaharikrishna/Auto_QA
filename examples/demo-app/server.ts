/**
 * A small local app for end-to-end tests (PLAN.md step 0): no internet, same result every run.
 *
 *   npm run demo            serves it on http://127.0.0.1:4173
 *
 * Login: demo / demo123. Pages: / (login) → /dashboard → /profile.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const DEMO_USER = { username: 'demo', password: 'demo123' };

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Demo</title>
<style>body{font:15px system-ui;margin:40px;max-width:640px} label{display:block;margin:10px 0 4px} [role=alert]{color:#b00020;margin-top:12px}</style>
</head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  '/': layout(
    'Login',
    `<h1>Sign in to Demo</h1>
<form id="login" aria-label="Login">
  <label for="username">Username</label><input id="username" name="username" autocomplete="off">
  <label for="password">Password</label><input id="password" name="password" type="password">
  <p><button type="submit" data-testid="login">Login</button></p>
  <div id="error" role="alert" hidden></div>
</form>
<script>
document.getElementById('login').addEventListener('submit', (e) => {
  e.preventDefault();
  const ok = username.value === '${DEMO_USER.username}' && password.value === '${DEMO_USER.password}';
  if (ok) { document.cookie = 'session=1; path=/'; location.href = '/dashboard'; }
  else { error.hidden = false; error.textContent = 'Invalid username or password'; }
});
</script>`,
  ),
  '/dashboard': layout(
    'Dashboard',
    `<h1>Dashboard</h1>
<nav aria-label="Main"><a href="/profile">Profile</a> · <a href="/">Log out</a></nav>
<p><button disabled>Delete account</button></p>
<section aria-label="Activity"><h2>Recent activity</h2><p id="activity">Loading…</p></section>
<script>setTimeout(() => { activity.textContent = '3 new messages'; }, 800);</script>`,
  ),
  '/profile': layout(
    'Profile',
    `<h1>Profile</h1>
<form id="profile" aria-label="Profile">
  <label for="name">Full name</label><input id="name" name="name">
  <label for="country">Country</label>
  <select id="country" name="country"><option value="">Choose…</option><option value="in">India</option><option value="us">United States</option></select>
  <p><input type="checkbox" id="news"> <label for="news" style="display:inline">Send me news</label></p>
  <p><button type="submit">Save changes</button></p>
  <div id="saved" role="status"></div>
</form>
<script>
document.getElementById('profile').addEventListener('submit', (e) => {
  e.preventDefault();
  setTimeout(() => { saved.textContent = 'Profile saved'; }, 300);
});
</script>`,
  ),
};

export async function startDemoApp(port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const page = PAGES[path];
    if (!page) return res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${actual}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const app = await startDemoApp(Number(process.env.PORT ?? 4173));
  console.log(`Demo app on ${app.url}  (login ${DEMO_USER.username} / ${DEMO_USER.password})`);
}
