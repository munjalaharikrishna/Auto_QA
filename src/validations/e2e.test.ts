import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDemoApp } from '../../examples/demo-app/server.js';
import type { Resolver } from '../explorer/controller.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { runCases } from '../pipeline/run-cases.js';
import type { TestVerdict } from '../results/verdict.js';

/**
 * The validation catalogue end to end: sentences a tester writes → parsed → the element found on a real page →
 * Playwright code → run → PASS, or FAIL with a readable "Actual". Needs Google Chrome, no internet.
 * AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const config = defaultParserConfig();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const unattended: Resolver = { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false };

interface Case {
  id: string;
  steps: string;
  expected: string;
  /** PASS unless the check is meant to fail. */
  status?: 'PASS' | 'FAIL';
  /** For a failing check: what the result must say. */
  actual?: RegExp;
}

const open = '1. Open Lab page';
const CASES: Case[] = [
  // F. Layout
  { id: 'LAB-CENTRE', steps: open, expected: 'Lab login form is in the middle of the screen' },
  { id: 'LAB-CENTRE-BARE', steps: `${open}\n2. validate login was middle of screen`, expected: 'The page is not blank' },
  { id: 'LAB-CENTRE-SECTION', steps: `${open}\n2. "Checking the login section at middle of the page"`, expected: 'Login form is in the middle of the screen' },
  { id: 'LAB-REGION', steps: open, expected: 'Logo is at the top left' },
  { id: 'LAB-REGION-WRONG', steps: open, expected: 'Logo is at the bottom right', status: 'FAIL', actual: /at the top left of the screen/ },
  { id: 'LAB-RELATIVE', steps: open, expected: 'Cancel is to the left of Save' },
  { id: 'LAB-RELATIVE-WRONG', steps: open, expected: 'Cancel is to the right of Save', status: 'FAIL', actual: /the element is at x \d+/ },
  { id: 'LAB-ALIGNED', steps: open, expected: 'Cancel and Save buttons are top-aligned' },
  { id: 'LAB-SIZE', steps: open, expected: 'Save button is at least 44 px high' },
  { id: 'LAB-COLOUR', steps: open, expected: 'Save button is blue' },
  { id: 'LAB-COLOUR-WRONG', steps: open, expected: 'Save button is red', status: 'FAIL', actual: /background color is blue/ },
  { id: 'LAB-STICKY', steps: open, expected: 'Header stays at the top when scrolling' },
  // B, C. Elements and text
  { id: 'LAB-PASSWORD', steps: open, expected: 'Password field hides characters' },
  { id: 'LAB-PLACEHOLDER', steps: open, expected: 'Email placeholder is Enter email' },
  { id: 'LAB-MAXLEN', steps: open, expected: 'Email accepts at most 20 characters' },
  { id: 'LAB-DROPDOWN', steps: open, expected: 'Country dropdown shows India' },
  { id: 'LAB-OPTIONS', steps: open, expected: 'Country options are India, USA, UK' },
  { id: 'LAB-COUNT', steps: open, expected: '3 products are shown' },
  { id: 'LAB-COUNT-WRONG', steps: open, expected: '5 products are shown', status: 'FAIL', actual: /3 found/ },
  { id: 'LAB-PATTERN', steps: open, expected: 'Order number looks like ORD-######' },
  { id: 'LAB-FORMAT', steps: open, expected: 'Total due is a currency amount' },
  { id: 'LAB-TODAY', steps: open, expected: 'Order date is today' },
  { id: 'LAB-TOOLTIP', steps: open, expected: 'Info icon has a tooltip Your data is safe' },
  { id: 'LAB-SELECTED-TAB', steps: open, expected: 'Overview tab is selected' },
  { id: 'LAB-LINK', steps: open, expected: 'Terms link points to /terms' },
  { id: 'LAB-NEWTAB-SAFE', steps: open, expected: 'Help link opens safely' },
  // G. Tables
  { id: 'LAB-COLUMNS', steps: open, expected: 'Table columns are Name, Email, Status' },
  { id: 'LAB-COLUMNS-WRONG', steps: open, expected: 'Table columns are Name, Phone', status: 'FAIL', actual: /missing Phone/ },
  { id: 'LAB-ROWS', steps: open, expected: 'Table shows 3 rows' },
  { id: 'LAB-ROW-VALUE', steps: open, expected: 'Row for Ravi has Status Pending' },
  { id: 'LAB-CELL', steps: open, expected: 'Row 2, column Email is mia@example.com' },
  { id: 'LAB-SORTED', steps: open, expected: 'Table is sorted by Name ascending' },
  { id: 'LAB-EVERY-WRONG', steps: open, expected: 'Every row is Active', status: 'FAIL', actual: /1 of 3 do not/ },
  // E. Messages and dialogs
  { id: 'LAB-TOAST', steps: `${open}\n2. Click Show toast`, expected: 'Toast "Saved" appears' },
  { id: 'LAB-DIALOG', steps: `${open}\n2. Click Open dialog`, expected: 'Confirm dialog opens\nDialog says "Delete item?" with Yes and No buttons' },
  { id: 'LAB-BROWSER-ALERT', steps: `${open}\n2. Click Show alert`, expected: 'The browser shows Hello from lab' },
  { id: 'LAB-LOADING', steps: open, expected: 'Loading finishes' },
  { id: 'LAB-ALERT', steps: `${open}\n2. Click Save`, expected: 'An error alert "Invalid credentials" is shown' },
  // H, J, K. Network, session, storage
  { id: 'LAB-REQUEST', steps: `${open}\n2. Click Ping server`, expected: 'Clicking Ping server calls POST /api/ping and gets 201' },
  {
    id: 'LAB-REQUEST-WRONG',
    steps: `${open}\n2. Click Ping server`,
    expected: 'Clicking Ping server calls POST /api/other',
    status: 'FAIL',
    actual: /no such request; the page sent/,
  },
  { id: 'LAB-COOKIE', steps: open, expected: 'Session cookie is set' },
  { id: 'LAB-STORAGE', steps: open, expected: 'Theme dark is remembered' },
  { id: 'LAB-CONSOLE', steps: open, expected: 'No console errors' },
  { id: 'LAB-DOWNLOAD', steps: `${open}\n2. Click Export`, expected: 'report.csv is downloaded\nThe CSV has 2 rows and the header Name, Email' },
  // L. Accessibility
  { id: 'LAB-LABELS', steps: open, expected: 'Every field has a label' },
  { id: 'LAB-ALT', steps: open, expected: 'All images have alt text' },
];

describe('validation catalogue end to end', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let verdicts: TestVerdict[];
  const base = path.join(root, '.auto-qa', 'test-validations');
  const byId = (id: string) => verdicts.find((v) => v.testId === id)!;

  before(async () => {
    app = await startDemoApp();
    await rm(base, { recursive: true, force: true });
    const models = CASES.map((c) => parseTestCase({ id: c.id, title: c.id, steps: c.steps, expected: c.expected }, config));
    const run = await runCases(models, {
      config,
      baseUrl: `${app.url}/lab`,
      env: {},
      resolver: unattended,
      exploreDir: path.join(base, 'explore'),
      runsDir: path.join(base, 'runs'),
      workspace: path.join(base, 'workspace'),
    });
    verdicts = run.verdicts;
  });
  after(async () => {
    await app?.close();
  });

  for (const c of CASES) {
    it(`${c.id}: ${c.expected.split('\n')[0]} → ${c.status ?? 'PASS'}`, () => {
      const v = byId(c.id);
      assert.ok(v, 'has a verdict');
      const detail = JSON.stringify({
        status: v.status,
        reason: v.reason,
        review: v.review?.map((r) => r.headline),
        actual: v.actual,
        checks: v.checks.map((k) => [k.result, k.actual]),
      });
      assert.equal(v.status, c.status ?? 'PASS', detail);
      if (c.actual) assert.match(v.actual, c.actual, detail);
    });
  }
});
