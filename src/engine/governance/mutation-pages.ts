import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Mutation, MutationCase } from './mutation.js';

/**
 * E0.19 step 5: the mutation harness on pages of a real application. The pages are saved copies of local OrangeHRM 2.5 screens
 * (`test/dom/orangehrm-*.html`), served as they were captured; each mutation breaks one of them the way a release can (a button
 * removed, a text changed, an element hidden, a record gone, a server error, an empty page). Every check that held on the saved page
 * must not PASS on the broken one: a PASS there is a wrong PASS, and the gate fails on it.
 */

/** Where each saved page is served, and the file it is in `test/dom`. */
export const ORANGEHRM_PAGES: Readonly<Record<string, string>> = {
  '/login.php': 'orangehrm-login.html',
  '/employee-list': 'orangehrm-employee-list.html',
  '/add-employee': 'orangehrm-add-employee.html',
  '/employee': 'orangehrm-employee.html',
};

const open = (path: string) => (url: string) => [`Open ${url}${path}`];

export const ORANGEHRM_MUTATION_CASES: readonly MutationCase[] = [
  {
    id: 'O-LOGIN-BUTTON',
    title: 'The login page has its Login button',
    steps: open('/login.php'),
    expected: 'The "Login" button is displayed',
    baseline: 'PASS',
  },
  {
    id: 'O-LIST-EMPLOYEE',
    title: 'The employee is in the list',
    steps: open('/employee-list'),
    expected: 'The "Anita Kumari Rao" link is displayed',
    baseline: 'PASS',
  },
  { id: 'O-LIST-ADD', title: 'The list has its Add button', steps: open('/employee-list'), expected: 'The "Add" button is displayed', baseline: 'PASS' },
  {
    id: 'O-LIST-NOBODY',
    title: 'An employee who does not exist is not in the list',
    steps: open('/employee-list'),
    expected: 'The "Bob Stone" link is displayed',
    baseline: 'FAIL',
  },
  {
    id: 'O-ADD-HEADING',
    title: 'The Add Employee page says what it is',
    steps: open('/add-employee'),
    expected: 'The "PIM : Add Employee" heading is displayed',
    baseline: 'PASS',
  },
  {
    id: 'O-PERSONAL-DETAILS',
    title: 'The employee page shows Personal Details',
    steps: open('/employee'),
    expected: 'The "Personal Details" heading is displayed',
    baseline: 'PASS',
  },
];

const swap = (body: string, from: string, to: string): string => {
  if (!body.includes(from)) throw new Error(`the saved page no longer contains "${from}": the mutation needs updating`);
  return body.split(from).join(to);
};
const onPage =
  (page: string, from: string, to: string) =>
  (path: string, body: string): string =>
    path === page ? swap(body, from, to) : body;

export const ORANGEHRM_MUTATIONS: readonly Mutation[] = [
  {
    id: 'login-button-removed',
    describes: 'the Login button is gone from the login page',
    rewrite: onPage('/login.php', 'value="Login"', 'value="Login" hidden disabled'),
    overrides: { 'O-LOGIN-BUTTON': 'FAIL' },
  },
  {
    id: 'employee-deleted',
    describes: 'the employee is no longer in the list',
    rewrite: onPage('/employee-list', 'Anita Kumari Rao', 'Ravi Shankar Iyer'),
    overrides: { 'O-LIST-EMPLOYEE': 'FAIL' },
  },
  {
    id: 'add-button-hidden',
    describes: 'the Add button is on the list page but hidden',
    rewrite: onPage('/employee-list', 'value="Add"', 'value="Add" style="display:none"'),
    overrides: { 'O-LIST-ADD': 'FAIL' },
  },
  {
    id: 'heading-renamed',
    describes: 'the Add Employee page calls itself something else',
    rewrite: onPage('/add-employee', 'PIM : Add Employee', 'PIM : New Hire'),
    overrides: { 'O-ADD-HEADING': 'FAIL' },
  },
  {
    id: 'list-server-error',
    describes: 'the employee list answers with a server error (500)',
    rewrite: (_path, body) => body,
    status: (path) => (path === '/employee-list' ? 500 : undefined),
    overrides: { 'O-LIST-EMPLOYEE': 'FAIL', 'O-LIST-ADD': 'FAIL' },
  },
  {
    id: 'employee-page-empty',
    describes: 'the employee page comes back empty',
    rewrite: (path, body) => (path === '/employee' ? '<html><head><title>OrangeHRM - Employee Details</title></head><body></body></html>' : body),
    overrides: { 'O-PERSONAL-DETAILS': 'FAIL' },
  },
];

/** Serves saved pages (path to HTML) as they are; any other path is a 404. */
export async function startSavedPages(pages: Readonly<Record<string, string>>): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const html = pages[path];
    if (html === undefined) return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
