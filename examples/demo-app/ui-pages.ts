/**
 * The pages of the demo app that E0.7 runs the UI handlers against: one page for each kind of interaction (UI-02 to
 * UI-09). They are small, plain HTML with a little script, the same on every run, and they need no internet.
 *
 *   /ui/controls  textbox, password, dropdown, checkbox, file upload   (UI-05)
 *   /ui/forms     field errors tied to their field, a submit for each form, a dependent field   (UI-04)
 *   /ui/dialogs   alert, confirm, prompt and an HTML modal   (UI-03)
 *   /ui/tabs      a link that opens a new tab, and a pop-up window   (UI-02)
 *   /ui/table     sortable, paginated employee table with Edit and Delete in every row   (UI-06)
 *   /ui/waits     a spinner, a slow request, a redirect and many small changes   (UI-09)
 *   /ui/keys      keys, a hover, a double click   (UI-08)
 */

const layout = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:32px;max-width:760px} label{display:block;margin:10px 0 4px} .error{color:#b00020} [aria-invalid=true]{border:2px solid #b00020}
table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:6px 10px;text-align:left} nav button{margin:0 2px}</style>
</head><body><p><a href="/ui">UI pages</a></p>${body}</body></html>`;

export const EMPLOYEES = [
  'Aaron Hill',
  'Alice Adams',
  'Bella Cruz',
  'Ben Foster',
  'Carla Diaz',
  'Chris Evans',
  'Dana Ford',
  'Dave Green',
  'Eli Harris',
  'Emma Jones',
  'Finn King',
  'Gina Lopez',
  'Hank Moore',
  'Iris Nolan',
  'Jack Owens',
  'John Doe',
  'John Smith',
  'Kara Lee',
  'Liam Young',
  'Mona Patel',
  'Nick Quinn',
  'Olga Reed',
  'Pete Stone',
  'Quinn Wells',
  'Zed Zimmer',
];

export const UI_PAGES: Record<string, string> = {
  '/ui': layout(
    'UI pages',
    `<h1>UI pages</h1><ul>${['controls', 'forms', 'dialogs', 'tabs', 'table', 'waits', 'keys', 'cards', 'cards-twins'].map((p) => `<li><a href="/ui/${p}">${p}</a></li>`).join('')}</ul>`,
  ),

  '/ui/controls': layout(
    'Controls',
    `<h1>Controls</h1>
<form id="controls" aria-label="Controls" autocomplete="off">
  <label for="fullname">Full name</label><input id="fullname" name="fullname">
  <label for="secret">Secret</label><input id="secret" name="secret" type="password">
  <label for="colour">Favourite colour</label>
  <select id="colour" name="colour"><option value="">Choose…</option><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option></select>
  <p><input type="checkbox" id="agree" name="agree"> <label for="agree" style="display:inline">I agree</label></p>
  <p><label for="photo">Photo</label><input type="file" id="photo" name="photo"></p>
  <p><button type="submit">Show</button> <button type="reset">Reset</button></p>
</form>
<pre id="out" role="status"></pre>
<script>
document.getElementById('controls').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  out.textContent = ['name=' + f.fullname.value, 'secret=' + f.secret.value.length + ' characters', 'colour=' + f.colour.value, 'agree=' + f.agree.checked, 'photo=' + (f.photo.files[0] ? f.photo.files[0].name : 'none')].join('\\n');
});
</script>`,
  ),

  '/ui/forms': layout(
    'Forms',
    `<h1>Forms</h1>
<form id="register" aria-label="Register" novalidate>
  <label for="email">Email</label><input id="email" name="email" aria-describedby="email-error">
  <span id="email-error" class="error" role="alert" hidden></span>
  <label for="age">Age</label><input id="age" name="age" aria-describedby="age-error">
  <span id="age-error" class="error" role="alert" hidden></span>
  <label for="country">Country</label>
  <select id="country" name="country"><option value="">Choose…</option><option value="in">India</option><option value="us">United States</option></select>
  <label for="state">State</label>
  <select id="state" name="state" disabled><option value="">Choose a country first</option></select>
  <p><button type="submit">Register</button></p>
  <p id="registered" role="status"></p>
</form>
<form id="newsletter" aria-label="Newsletter">
  <label for="nemail">Newsletter email</label><input id="nemail" name="nemail">
  <p><button type="submit">Subscribe</button></p>
  <p id="subscribed" role="status"></p>
</form>
<script>
const states = { in: ['Kerala', 'Goa'], us: ['Texas', 'Ohio'] };
country.addEventListener('change', () => {
  state.innerHTML = '<option value="">Choose…</option>' + (states[country.value] || []).map((s) => '<option>' + s + '</option>').join('');
  state.disabled = !country.value;
});
const fail = (input, box, text) => { input.setAttribute('aria-invalid', 'true'); box.textContent = text; box.hidden = false; };
const ok = (input, box) => { input.removeAttribute('aria-invalid'); box.textContent = ''; box.hidden = true; };
document.getElementById('register').addEventListener('submit', (e) => {
  e.preventDefault();
  registered.textContent = '';
  let good = true;
  if (!email.value.includes('@')) { fail(email, document.getElementById('email-error'), 'Enter a valid email address'); good = false; } else ok(email, document.getElementById('email-error'));
  if (!(Number(age.value) >= 18)) { fail(age, document.getElementById('age-error'), 'Age must be 18 or more'); good = false; } else ok(age, document.getElementById('age-error'));
  if (good) registered.textContent = 'Registered ' + email.value;
});
document.getElementById('newsletter').addEventListener('submit', (e) => { e.preventDefault(); subscribed.textContent = 'Subscribed ' + nemail.value; });
</script>`,
  ),

  '/ui/dialogs': layout(
    'Dialogs',
    `<h1>Dialogs</h1>
<p><button id="b-alert" onclick="alert('Saved!'); result.textContent = 'alert closed'">Show alert</button>
<button id="b-confirm" onclick="result.textContent = confirm('Delete item?') ? 'deleted' : 'kept'">Ask me</button>
<button id="b-prompt" onclick="const n = prompt('Your name?', ''); result.textContent = n === null ? 'no name' : 'hello ' + n">Prompt me</button>
<button id="b-modal" onclick="modal.showModal()">Open modal</button></p>
<p id="result" role="status"></p>
<dialog id="modal" aria-label="Remove item"><p>Remove the item?</p><button id="m-ok" onclick="modal.close(); result.textContent = 'removed'">OK</button> <button id="m-cancel" onclick="modal.close(); result.textContent = 'not removed'">Cancel</button></dialog>`,
  ),

  '/ui/tabs': layout(
    'Tabs',
    `<h1>Tabs</h1>
<p><a id="help" href="/ui/tab-target" target="_blank" rel="noopener">Help</a>
<button id="popup" onclick="window.open('/ui/tab-target?popup=1', '_blank')">Open pop-up</button></p>`,
  ),
  '/ui/tab-target': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Help centre</title></head><body><h1>Help centre</h1><p>Welcome to the help centre.</p></body></html>`,

  '/ui/table': layout(
    'Employee table',
    `<h1>Employees</h1>
<form id="add" aria-label="Add employee">
  <label for="first">First name</label><input id="first" name="first">
  <label for="last">Last name</label><input id="last" name="last">
  <p><button type="submit">Add</button></p>
</form>
<p id="rowstatus" role="status"></p>
<table id="employees" aria-label="Employees">
  <thead><tr><th>ID</th><th><button id="sort" type="button" aria-label="Sort by Name">Name</button></th><th>Department</th><th>Actions</th></tr></thead>
  <tbody></tbody>
</table>
<nav aria-label="Pagination"><button id="prev" type="button">Previous</button> <span id="pages"></span> <button id="next" type="button">Next</button></nav>
<script>
const names = ${JSON.stringify(EMPLOYEES)};
let rows = names.map((n, i) => ({ id: i + 1, name: n, dept: ['HR', 'IT', 'Sales'][i % 3] }));
let asc = true, page = 1, nextId = rows.length + 1;
const size = 10;
const pageCount = () => Math.max(1, Math.ceil(rows.length / size));
function render() {
  const sorted = [...rows].sort((a, b) => (asc ? 1 : -1) * a.name.localeCompare(b.name));
  if (page > pageCount()) page = pageCount();
  const body = document.querySelector('#employees tbody');
  body.innerHTML = '';
  for (const r of sorted.slice((page - 1) * size, page * size)) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + r.id + '</td><td>' + r.name + '</td><td>' + r.dept + '</td><td><button type="button" class="edit">Edit</button> <button type="button" class="delete">Delete</button></td>';
    tr.querySelector('.edit').onclick = () => { rowstatus.textContent = 'Editing ' + r.name; };
    tr.querySelector('.delete').onclick = () => { rows = rows.filter((x) => x.id !== r.id); rowstatus.textContent = 'Deleted ' + r.name; render(); };
    body.append(tr);
  }
  pages.innerHTML = '';
  for (let p = 1; p <= pageCount(); p++) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = String(p); b.setAttribute('aria-label', 'Page ' + p);
    if (p === page) b.setAttribute('aria-current', 'page');
    b.onclick = () => { page = p; render(); };
    pages.append(b);
  }
  prev.disabled = page === 1; next.disabled = page === pageCount();
}
sort.onclick = () => { asc = !asc; page = 1; render(); };
prev.onclick = () => { page--; render(); };
next.onclick = () => { page++; render(); };
document.getElementById('add').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = (first.value + ' ' + last.value).trim();
  if (!name) return;
  rows.push({ id: nextId++, name, dept: 'New' });
  rowstatus.textContent = 'Added ' + name;
  first.value = ''; last.value = '';
  render();
});
render();
</script>`,
  ),

  '/ui/waits': layout(
    'Waits',
    `<h1>Waits</h1>
<p><button id="load" onclick="startLoad()">Load data</button> <button id="slow" onclick="slowCall()">Slow call</button>
<button id="go" onclick="setTimeout(() => { location.href = '/ui/waits?done=1'; }, 600)">Redirect later</button>
<button id="many" onclick="manyChanges()">Many changes</button></p>
<div id="area"></div>
<p id="slowresult" role="status"></p>
<ul id="items"></ul>
<script>
function startLoad() {
  area.innerHTML = '<p id="spinner" role="progressbar" aria-busy="true">Loading…</p>';
  setTimeout(() => { area.innerHTML = '<p id="data">Data loaded</p>'; }, 1200);
}
function slowCall() { slowresult.textContent = ''; fetch('/api/slow').then((r) => r.json()).then(() => { slowresult.textContent = 'Call finished'; }); }
function manyChanges() {
  let n = 0;
  const t = setInterval(() => { const li = document.createElement('li'); li.textContent = 'item ' + (++n); items.append(li); if (n === 6) clearInterval(t); }, 100);
}
if (location.search.includes('done=1')) area.innerHTML = '<p id="arrived">Arrived after the redirect</p>';
</script>`,
  ),

  // Cards (UI-07): each product is an article with a title, a price and a button. Three look alike; one is sold out and has no button.
  '/ui/cards': layout(
    'Shop',
    `<h1>Shop</h1>
<p id="cart" role="status">Cart: empty</p>
<section aria-label="Products">
  <article><h2>Backpack</h2><p>Price: $29.99</p><p class="state"></p><button>Add to cart</button></article>
  <article><h2>Bike Light</h2><p>Price: $9.99</p><p class="state"></p><button>Add to cart</button></article>
  <article><h2>Bolt T-Shirt</h2><p>Price: $15.99</p><p class="state"></p><p>Sold out</p></article>
</section>
<script>
for (const card of document.querySelectorAll('article')) {
  const add = card.querySelector('button');
  if (!add) continue;
  add.addEventListener('click', () => {
    const inCart = card.querySelector('.state').textContent === 'In cart';
    card.querySelector('.state').textContent = inCart ? '' : 'In cart';
    add.textContent = inCart ? 'Add to cart' : 'Remove from cart';
    const names = [...document.querySelectorAll('article')].filter((a) => a.querySelector('.state').textContent === 'In cart').map((a) => a.querySelector('h2').textContent);
    cart.textContent = names.length ? 'Cart: ' + names.join(', ') : 'Cart: empty';
  });
}
</script>`,
  ),
  // Two cards with one title: "the Backpack card" does not say which.
  '/ui/cards-twins': layout(
    'Shop twins',
    `<h1>Shop</h1>
<p id="cart" role="status">Cart: empty</p>
<section aria-label="Products">
  <article><h2>Backpack</h2><p>Price: $29.99</p><p class="state"></p><button>Add to cart</button></article>
  <article><h2>Backpack</h2><p>Price: $34.99</p><p class="state"></p><button>Add to cart</button></article>
  <article><h2>Bike Light</h2><p>Price: $9.99</p><p class="state"></p><button>Add to cart</button></article>
</section>
<script>
for (const card of document.querySelectorAll('article')) {
  const add = card.querySelector('button');
  if (!add) continue;
  add.addEventListener('click', () => {
    const inCart = card.querySelector('.state').textContent === 'In cart';
    card.querySelector('.state').textContent = inCart ? '' : 'In cart';
    add.textContent = inCart ? 'Add to cart' : 'Remove from cart';
    const names = [...document.querySelectorAll('article')].filter((a) => a.querySelector('.state').textContent === 'In cart').map((a) => a.querySelector('h2').textContent);
    cart.textContent = names.length ? 'Cart: ' + names.join(', ') : 'Cart: empty';
  });
}
</script>`,
  ),

  '/ui/keys': layout(
    'Keys',
    `<h1>Keys</h1>
<label for="keybox">Type here</label><input id="keybox" name="keybox">
<ul id="log" aria-label="Key log"></ul>
<p><span id="hoverme" tabindex="0" role="button" aria-label="Hover target">Hover me</span> <span id="tip" role="tooltip" hidden>Tooltip shown</span></p>
<p><button id="dbl" type="button">Double click me</button> <span id="dblresult" role="status"></span></p>
<script>
const log = (t) => { const li = document.createElement('li'); li.textContent = t; document.getElementById('log').append(li); };
keybox.addEventListener('keydown', (e) => {
  const combo = [e.ctrlKey ? 'Control' : '', e.shiftKey ? 'Shift' : '', e.key].filter(Boolean).join('+');
  log(combo);
});
hoverme.addEventListener('mouseenter', () => { tip.hidden = false; });
hoverme.addEventListener('mouseleave', () => { tip.hidden = true; });
dbl.addEventListener('dblclick', () => { dblresult.textContent = 'double clicked'; });
</script>`,
  ),
};

/** The API the pages call: `/api/slow` answers after a short wait, so a page really has something to wait for. */
export const slowDelayMs = 700;
