import { BE, firstMatch, NOT, NUM, OBE, re, toList, toNumber } from './common.js';
import type { ValidationSpec } from './types.js';

/** E. Messages, dialogs and loading (VALIDATIONS.md §3.E). */

const SHOWN = '(?:shown|displayed|visible|appears?|pops up|is shown)';
const DIALOG = '(?:dialog|modal|pop-?up|popup|dialog box|overlay)';

export const messageSpecs: ValidationSpec[] = [
  {
    id: 'VAL-X01',
    type: 'observe',
    title: 'A check that cannot be verified from the page',
    targets: 'none',
    // Made from an expected result nothing could verify (policy balanced or lenient, REAL-WORLD-TEST-CASES.md M7); no words of its own.
    parse: () => undefined,
    code: () => [],
    passed: () => 'Observed, not verified',
    examples: [],
  },
  {
    id: 'VAL-E01b',
    type: 'error-shown',
    title: 'An error message appears',
    targets: 'none',
    // Found by the outcome intents (parser/intents.ts), not by words of its own.
    parse: () => undefined,
    code: (a, c) => {
      c.helpers.add('expectErrorShown');
      return [`await expectErrorShown(page${a.expected ? `, { text: ${c.quote(a.expected)} }` : ''});`];
    },
    passed: (a) => (a.expected ? `The error message "${a.expected}" appeared` : 'An error message appeared'),
    examples: [],
  },
  {
    id: 'VAL-E01',
    type: 'alert',
    title: 'Alert or error banner',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:an?\\s+|the\\s+)?(?:error\\s+|warning\\s+|success\\s+|info\\s+)?alert\\s+(?:message\\s+)?(?<v>"[^"]+"|.+?)\\s+${OBE}${SHOWN}`),
          (g) => ({ expected: ctx.value(g.v!) }),
        ],
        [re(`(?:an?\\s+|the\\s+)?(?:error\\s+|warning\\s+|success\\s+|info\\s+)?alert\\s+${OBE}${SHOWN}`), () => ({ expected: '' })],
      ]),
    code: (a, c) => [
      a.expected
        ? `await expect(page.getByRole('alert').filter({ hasText: ${c.quote(a.expected)} }).first()).${NOT(a)}toBeVisible();`
        : `await expect(page.getByRole('alert').first()).${NOT(a)}toBeVisible();`,
    ],
    passed: (a) => `An alert${a.expected ? ` "${a.expected}"` : ''} ${a.negated ? 'was not shown' : 'was shown'}`,
    examples: ['An error alert "Server busy" is shown', 'Alert is displayed'],
  },
  {
    id: 'VAL-E03',
    type: 'toast',
    title: 'Toast appears (and goes away)',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:an?\\s+|the\\s+)?(?:toast|snackbar|snack bar|notification)\\s+(?<v>"[^"]+"|.+?)\\s+appears?\\s+and\\s+(?:then\\s+)?(?:disappears?|goes away|closes)(?:\\s+(?:after|within|in)\\s+(?<n>${NUM})\\s+seconds?)?`,
          ),
          (g) => ({ expected: ctx.value(g.v!), options: { mode: 'contains', timeoutMs: g.n ? Math.round(toNumber(g.n) * 1000) : 8000 } }),
        ],
        [
          re(`(?:an?\\s+|the\\s+)?(?:toast|snackbar|snack bar|notification)\\s+(?<v>"[^"]+"|.+?)\\s+${OBE}${SHOWN}`),
          (g) => ({ expected: ctx.value(g.v!), options: { mode: 'exact' } }),
        ],
      ]),
    code: (a, c) => {
      const toast = `page.getByText(${c.quote(a.expected ?? '')}).first()`;
      const lines = [`await expect(${toast}).${NOT(a)}toBeVisible();`];
      if (a.options?.mode === 'contains') lines.push(`await expect(${toast}).toBeHidden({ timeout: ${a.options.timeoutMs ?? 8000} });`);
      return lines;
    },
    passed: (a) => `The message "${a.expected}" ${a.negated ? 'was not shown' : 'appeared'}${a.options?.mode === 'contains' ? ' and went away by itself' : ''}`,
    examples: ['Toast "Saved" appears', 'A toast "Saved" appears and disappears after 5 seconds'],
  },
  {
    id: 'VAL-E04',
    type: 'dialog',
    title: 'Modal opens or closes',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:an?\\s+|the\\s+)?(?:(?<n>"[^"]+"|[\\p{L}][\\p{L} ]*?)\\s+)?${DIALOG}\\s+${OBE}(?:closes|closed|disappears|is dismissed|goes away)`),
          (g) => ({ expected: g.n ? ctx.value(g.n) : '', negated: !ctx.negated }),
        ],
        [
          re(
            `(?:an?\\s+|the\\s+)?(?:(?<n>"[^"]+"|[\\p{L}][\\p{L} ]*?)\\s+)?${DIALOG}\\s+${OBE}(?:opens?|opened|shown|displayed|appears?|visible|is open|pops up)`,
          ),
          (g) => ({ expected: g.n ? ctx.value(g.n) : '' }),
        ],
      ]),
    code: (a, c) => [
      a.expected
        ? `await expect(page.getByRole('dialog', { name: ${c.quote(a.expected)} }).or(page.getByRole('dialog').filter({ hasText: ${c.quote(a.expected)} })).first()).${NOT(a)}toBeVisible();`
        : `await expect(page.getByRole('dialog').or(page.getByRole('alertdialog')).or(page.locator('dialog[open], .modal.show, [aria-modal="true"]')).first()).${NOT(a)}toBeVisible();`,
    ],
    passed: (a) => `The ${a.expected ? `"${a.expected}" ` : ''}dialog ${a.negated ? 'was closed' : 'was open'}`,
    examples: ['Confirm dialog opens', 'The dialog closes', 'A modal is displayed'],
  },
  {
    id: 'VAL-E05',
    type: 'dialog-content',
    title: 'Modal text and buttons',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:the\\s+)?${DIALOG}\\s+(?:says|shows|reads|contains|displays|asks)\\s+(?<v>"[^"]+"|.+?)(?:\\s+with\\s+(?<b>.+?)\\s+buttons?)?`),
          (g) => ({ expected: ctx.value(g.v!), options: g.b ? { list: toList(ctx, g.b) } : undefined }),
        ],
      ]),
    code: (a, c) => {
      const dialog = "page.getByRole('dialog').or(page.getByRole('alertdialog')).first()";
      return [
        `await expect(${dialog}).${NOT(a)}toContainText(${c.quote(a.expected ?? '')});`,
        ...(a.options?.list ?? []).map((b) => `await expect(${dialog}.getByRole('button', { name: ${c.quote(b)} })).toBeVisible();`),
      ];
    },
    passed: (a) => `The dialog said "${a.expected}"${a.options?.list?.length ? ` with ${a.options.list.join(' and ')} buttons` : ''}`,
    examples: ['Dialog says "Delete item?" with Yes and No buttons', 'The modal shows Are you sure'],
  },
  {
    id: 'VAL-E07',
    type: 'focus-in-dialog',
    title: 'Focus moves into the dialog',
    targets: 'none',
    parse: (ctx) => firstMatch(ctx.text, [[re(`focus\\s+(?:moves|goes|is|jumps|stays)\\s+(?:in)?to\\s+the\\s+${DIALOG}`), () => ({})]]),
    code: (a) => [`await expect(page.getByRole('dialog').first().locator(':focus')).${NOT(a)}toHaveCount(1);`],
    passed: (a) => `Focus ${a.negated ? 'was not' : 'was'} inside the dialog`,
    examples: ['Focus moves into the dialog'],
  },
  {
    id: 'VAL-E08',
    type: 'browser-dialog',
    title: 'Browser alert / confirm text',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:the\\s+)?browser\\s+(?:asks|shows|displays|says|alerts|prompts|confirms|warns)\\s+(?<v>.+)`), (g) => ({ expected: ctx.value(g.v!) })],
        [
          re(
            `(?:an?\\s+|the\\s+)?(?:browser\\s+)?(?:alert|confirm(?:ation)?|pop-?up)\\s+(?:box\\s+)?(?:saying|says|with the (?:message|text))\\s+(?<v>.+?)(?:\\s+${SHOWN})?`,
          ),
          (g) => ({ expected: ctx.value(g.v!) }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectBrowserDialog');
      return [`await expectBrowserDialog(page, ${c.quote(a.expected ?? '')});`];
    },
    passed: (a) => `The browser showed a pop-up saying "${a.expected}"`,
    examples: ['Browser asks Are you sure?', 'A browser alert saying "User Name not given!" is shown'],
  },
  {
    id: 'VAL-E09',
    type: 'loading-done',
    title: 'Loading has finished',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:the\\s+)?(?:spinner|loader|loading(?: indicator| icon| spinner| bar)?|progress bar|skeleton)\\s+(?:disappears?|goes away|is gone|is hidden|stops|finishes|ends|clears)`,
          ),
          () => ({}),
        ],
        [
          re(`(?:loading|the page|the results?|the data)\\s+(?:finishes|completes|is complete|is done|is finished|has finished|loads?|are loaded|is loaded)`),
          () => ({}),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectLoadingDone');
      return ['await expectLoadingDone(page);'];
    },
    passed: () => 'Loading had finished',
    examples: ['Spinner disappears', 'Loading finishes'],
  },
];

void BE;
