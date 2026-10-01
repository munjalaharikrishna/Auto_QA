/**
 * A small local app for end-to-end tests (PLAN.md step 0): no internet, same result every run.
 *
 *   npm run demo            serves it on http://127.0.0.1:4173
 *
 * Login: demo / demo123. Pages: / (login) → /dashboard → /profile, and /reports (broken on purpose).
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
<nav aria-label="Main"><a href="/profile">Profile</a> · <a href="/reports">Reports</a> · <a href="/">Log out</a></nav>
<p><button disabled>Delete account</button></p>
<section aria-label="Activity"><h2>Recent activity</h2><p id="activity">Loading…</p></section>
<section aria-label="Messages"><h2>Messages</h2>
  <p>Invoice ready <button onclick="shown.textContent = 'Invoice details'">Details</button></p>
  <p>Password changed <button onclick="shown.textContent = 'Security details'">Details</button></p>
  <p id="shown" role="status"></p>
</section>
<script>setTimeout(() => { activity.textContent = '3 new messages'; }, 800);</script>`,
  ),
  // Looks fine, but throws in the page and gets a 500 from its API: the health check must catch it (FR-VAL-04).
  '/reports': layout(
    'Reports',
    `<h1>Reports</h1><p id="summary">No reports yet.</p>
<script>fetch('/api/reports'); setTimeout(() => { throw new Error('Reports widget crashed'); }, 50);</script>`,
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
  // A page with something of everything the validation catalogue checks (VALIDATIONS.md): layout, tables, messages…
  '/lab': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lab · Demo</title>
<style>
  *{box-sizing:border-box} body{margin:0;font:15px system-ui;min-height:100vh}
  header{display:flex;align-items:center;gap:24px;padding:12px 24px;background:#f3f4f6;position:sticky;top:0}
  header img{width:40px;height:40px}
  .stage{display:flex;justify-content:center;padding:24px}
  form.card{width:360px;padding:20px;border:1px solid #ccc;border-radius:8px}
  .card label{display:block;margin:10px 0 4px}
  .actions{display:flex;justify-content:space-between;margin-top:16px}
  #save{background:#0066cc;color:#fff;border:0;padding:10px 16px;border-radius:4px;min-height:44px}
  #cancel{padding:10px 16px;min-height:44px}
  .err{color:#cc0000}
  .products{display:flex;gap:12px;padding:0 24px} .product{width:160px;height:90px;border:1px solid #ddd;padding:8px}
  table{border-collapse:collapse;margin:16px 24px} th,td{border:1px solid #ddd;padding:6px 12px;text-align:left}
  .spinner{margin:8px 24px} .tabs{display:flex;gap:8px;padding:0 24px}
  .toast{position:fixed;bottom:16px;right:16px;background:#222;color:#fff;padding:8px 12px;border-radius:4px}
  #top{height:900px}
</style></head><body>
<header>
  <img alt="Lab logo" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%230066cc'/%3E%3C/svg%3E">
  <nav aria-label="Main"><a href="/lab?tab=home">Home</a> <a href="/lab?tab=help" target="_blank" rel="noopener noreferrer">Help</a> <a href="/terms">Terms</a></nav>
</header>
<div class="stage">
  <form class="card" id="labform" aria-label="Lab login" name="labform">
    <h1 style="margin-top:0">Lab sign in</h1>
    <label for="email">Email</label><input id="email" name="email" placeholder="Enter email" maxlength="20" required>
    <label for="pw">Password</label><input id="pw" name="pw" type="password">
    <label for="country">Country</label>
    <select id="country" name="country"><option>India</option><option>USA</option><option>UK</option></select>
    <div class="actions"><button type="button" id="cancel">Cancel</button><button type="button" id="save">Save</button></div>
    <p class="err" id="err" role="alert" hidden>Invalid credentials</p>
  </form>
</div>
<div class="tabs" role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Settings</button></div>
<h2 style="margin:16px 24px 0">Users</h2>
<table id="users"><thead><tr><th>Name</th><th>Email</th><th>Status</th></tr></thead>
<tbody><tr><td>Asha</td><td>asha@example.com</td><td>Active</td></tr><tr><td>Mia</td><td>mia@example.com</td><td>Active</td></tr><tr><td>Ravi</td><td>ravi@example.com</td><td>Pending</td></tr></tbody></table>
<h2 style="margin:16px 24px 0">Prices</h2>
<table id="prices"><thead><tr><th>Item</th><th>Price</th></tr></thead>
<tbody><tr><td>Pen</td><td>$2.00</td></tr><tr><td>Book</td><td>$10.00</td></tr><tr><td>Bag</td><td>$25.50</td></tr></tbody></table>
<div class="products"><div class="product">Product A</div><div class="product">Product B</div><div class="product">Product C</div></div>
<p id="spinner" class="spinner" role="progressbar" aria-busy="true">Loading…</p>
<p style="margin:16px 24px"><button id="ping">Ping server</button> <a id="export" href="/report.csv" download>Export</a> <button id="toastbtn">Show toast</button> <button id="dlg">Open dialog</button> <button id="alertbtn">Show alert</button></p>
<p style="margin:16px 24px"><span role="img" aria-label="Info icon" title="Your data is safe" id="info">i</span> <output id="today" aria-label="Order date"></output> <output id="order" aria-label="Order number">ORD-123456</output> <output id="due" aria-label="Total due">$29.99</output></p>
<dialog id="d" aria-label="Confirm"><p>Delete item?</p><button id="yes">Yes</button> <button id="no">No</button></dialog>
<div id="top"></div>
<script>
  document.cookie = 'session=abc123; path=/; SameSite=Lax';
  localStorage.setItem('theme', 'dark');
  today.textContent = new Date().toISOString().slice(0, 10);
  setTimeout(() => spinner.remove(), 700);
  ping.onclick = () => fetch('/api/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com' }) });
  toastbtn.onclick = () => { const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = 'Saved'; document.body.append(t); setTimeout(() => t.remove(), 1500); };
  dlg.onclick = () => d.showModal(); no.onclick = () => d.close(); yes.onclick = () => d.close();
  alertbtn.onclick = () => alert('Hello from lab');
  save.onclick = () => { if (!email.value) err.hidden = false; };
</script></body></html>`,
  // A page that opens browser pop-ups (alert, confirm): they must not stop exploration or the test.
  '/alerts': layout(
    'Alerts',
    `<h1>Alerts</h1>
<p><button onclick="alert('Saved!'); result.textContent = 'alert closed'">Show alert</button>
<button onclick="result.textContent = confirm('Delete item?') ? 'deleted' : 'kept'">Ask me</button></p>
<p id="result" role="status"></p>`,
  ),
};

export async function startDemoApp(port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/api/reports') return res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
    if (path === '/api/ping') return res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
    if (path === '/report.csv') {
      return res
        .writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' })
        .end(['Name,Email', 'Asha,asha@example.com', 'Mia,mia@example.com', ''].join(String.fromCharCode(10)));
    }
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
