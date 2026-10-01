import { BE, CMP, collectionCode, compareWords, firstMatch, NOT, NUM, nameOf, OBE, re, timeoutArg, toCompare, toNumber } from './common.js';
import type { ValidationSpec } from './types.js';

/** B. Element presence and state (VALIDATIONS.md §3.B). Visible, hidden, enabled, disabled, checked are older and live in the parser. */

const SHOWN = '(?:shown|displayed|visible|listed|present|found|available|returned|on the page|in the list|appear|appears)';

export const elementSpecs: ValidationSpec[] = [
  {
    id: 'VAL-B03',
    type: 'attached',
    title: 'Exists in the page, or was removed',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+${BE}\\s+(?:removed|deleted|gone|absent|missing|dropped)(?:\\s+(?:from|in)\\s+.+)?`),
          (g) => ({ target: ctx.name(g.s!), negated: !ctx.negated }),
        ],
        [re(`(?<s>.+?)\\s+(?:no longer|not)\\s+(?:exists?|in the (?:page|list|table|dom))`), (g) => ({ target: ctx.name(g.s!), negated: true })],
        [re(`(?<s>.+?)\\s+exists?(?:\\s+in\\s+the\\s+(?:page|list|table|dom))?`), (g) => ({ target: ctx.name(g.s!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeAttached();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was removed from the page' : 'was in the page'}`,
    examples: ['Item is removed from the list', 'Row was deleted', 'Banner exists in the page'],
  },
  {
    id: 'VAL-B06',
    type: 'editable',
    title: 'Editable or read-only',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?<s>.+?)\\s+${BE}\\s+(?:read[- ]?only|uneditable|non[- ]editable|locked)`), (g) => ({ target: ctx.name(g.s!), negated: !ctx.negated })],
        [re(`(?<s>.+?)\\s+${BE}\\s+editable`), (g) => ({ target: ctx.name(g.s!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeEditable();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was read-only' : 'was editable'}`,
    examples: ['Email field is read-only', 'Name field is editable'],
  },
  {
    id: 'VAL-B08',
    type: 'focused',
    title: 'Has the focus',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:the\\s+)?(?:cursor|focus|caret)\\s+${BE}\\s+(?:in|on|at)\\s+(?:the\\s+)?(?<s>.+)`), (g) => ({ target: ctx.name(g.s!) })],
        [re(`(?<s>.+?)\\s+(?:${BE}\\s+)?(?:focused|in focus|has (?:the )?focus|gets (?:the )?focus)`), (g) => ({ target: ctx.name(g.s!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeFocused();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'did not have' : 'had'} the focus`,
    examples: ['Cursor is in the Email field', 'Email field is focused'],
  },
  {
    id: 'VAL-B09',
    type: 'count',
    title: 'Number of elements',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:(?<cmp>${CMP})\\s+)?(?<n>${NUM})\\s+(?<s>[\\p{L}][\\p{L} ]*?)\\s+(?:${BE}\\s+)?${SHOWN}(?:\\s+.*)?`),
          (g) => ({ expected: String(toNumber(g.n!)), options: { compare: toCompare(g.cmp), note: g.s!.trim() } }),
        ],
        [
          re(`there\\s+(?:is|are)\\s+(?:(?<cmp>${CMP})\\s+)?(?<n>${NUM})\\s+(?<s>[\\p{L}][\\p{L} ]*?)(?:\\s+(?:on the page|in the list|shown|displayed))?`),
          (g) => ({ expected: String(toNumber(g.n!)), options: { compare: toCompare(g.cmp), note: g.s!.trim() } }),
        ],
        [
          re(`(?:the\\s+)?number of\\s+(?<s>[\\p{L}][\\p{L} ]*?)\\s+${BE}\\s+(?:(?<cmp>${CMP})\\s+)?(?<n>${NUM})`),
          (g) => ({ expected: String(toNumber(g.n!)), options: { compare: toCompare(g.cmp), note: g.s!.trim() } }),
        ],
        [
          re(`(?<s>[\\p{L}][\\p{L} ]*?)\\s+count\\s+${BE}\\s+(?:(?<cmp>${CMP})\\s+)?(?<n>${NUM})`),
          (g) => ({ expected: String(toNumber(g.n!)), options: { compare: toCompare(g.cmp), note: g.s!.trim() } }),
        ],
      ]),
    code: (a, c) => [
      `await expect(${collectionCode(a.options?.note ?? '', c.quote)}).${NOT(a)}toHaveCountThat(${c.quote(a.options?.compare ?? 'eq')}, ${Number(a.expected)});`,
    ],
    passed: (a) => `There ${a.negated ? 'were not' : 'were'} ${compareWords(a.options?.compare)} ${a.expected} ${a.options?.note}`,
    examples: ['6 products are shown', 'At least 1 result is displayed', 'There are 3 rows in the list', 'The number of items is 5'],
  },
  {
    id: 'VAL-B10',
    type: 'empty',
    title: 'Empty',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+${BE}\\s+(?:empty|blank|cleared|has no content|shows nothing)`),
          // A field that is empty is the older value check ("Search box is empty"); this is for the rest ("Cart is empty").
          (g) => (/\b(?:field|textbox|text box|input|box|textarea)$/i.test(g.s!) ? undefined : { target: ctx.name(g.s!) }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeEmpty();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was not empty' : 'was empty'}`,
    examples: ['Cart is empty', 'Results list is empty'],
  },
  {
    id: 'VAL-B11',
    type: 'in-viewport',
    title: 'Visible without scrolling',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+${BE}\\s+(?:visible|shown|displayed|seen|in view|on screen)\\s+(?:without|with no)\\s+scrolling`),
          (g) => ({ target: ctx.name(g.s!) }),
        ],
        [re(`(?<s>.+?)\\s+${BE}\\s+(?:above the fold|in the viewport|within the viewport)`), (g) => ({ target: ctx.name(g.s!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeInViewport();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'needed scrolling' : 'was visible without scrolling'}`,
    examples: ['Login button is visible without scrolling'],
  },
  {
    id: 'VAL-B12',
    type: 'clickable',
    title: 'Can be clicked',
    targets: 'one',
    parse: (ctx) => firstMatch(ctx.text, [[re(`(?<s>.+?)\\s+${BE}\\s+(?:clickable|clicked|pressable|tappable|usable)`), (g) => ({ target: ctx.name(g.s!) })]]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeClickable();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'could not be clicked' : 'could be clicked'}`,
    examples: ['Login button can be clicked', 'Submit is clickable'],
  },
  {
    id: 'VAL-B13',
    type: 'expanded',
    title: 'Expanded or collapsed',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?<s>.+?)\\s+${BE}\\s+expanded`), (g) => ({ target: ctx.name(g.s!) })],
        [re(`(?<s>.+?)\\s+${BE}\\s+collapsed`), (g) => ({ target: ctx.name(g.s!), negated: !ctx.negated })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).toHaveAttribute('aria-expanded', ${a.negated ? "'false'" : "'true'"});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was collapsed' : 'was expanded'}`,
    examples: ['FAQ answer is expanded', 'Details section is collapsed'],
  },
  {
    id: 'VAL-B14',
    type: 'attribute',
    title: 'Hides characters / element type / attribute value',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:hides|masks)\\s+(?:the\\s+)?(?:characters|text|input|typed text|what you type)`),
          (g) => ({ target: ctx.name(g.s!), expected: 'password', options: { name: 'type' } }),
        ],
        [re(`(?<s>.+?)\\s+(?:input\\s+)?type\\s+${BE}\\s+(?<v>\\w+)`), (g) => ({ target: ctx.name(g.s!), expected: g.v, options: { name: 'type' } })],
        [
          re(`(?<s>.+?)\\s+(?<k>alt|href|src|aria-[\\w-]+|data-[\\w-]+|target|rel|maxlength|lang)\\s*(?:text\\s+|attribute\\s+)?${BE}\\s+(?<v>.+)`),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!), options: { name: g.k!.toLowerCase() } }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveAttribute(${c.quote(a.options?.name ?? '')}, ${c.quote(a.expected ?? '')});`],
    passed: (a) => `${nameOf(a)} ${a.options?.name} ${a.negated ? 'was not' : 'was'} "${a.expected}"`,
    examples: ['Password field hides characters', 'Logo alt text is Company logo', 'Password field type is password'],
  },
  {
    id: 'VAL-P02',
    type: 'visible',
    title: 'Disappears',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:disappears?|goes away|vanishes|is gone|is dismissed)`),
          (g) => ({ type: 'visible', target: ctx.name(g.s!), negated: !ctx.negated }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeVisible(${timeoutArg(a)});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was gone' : 'was visible'}`,
    examples: ['The banner goes away', 'The confirmation message disappears'],
  },
  {
    id: 'VAL-M02',
    type: 'visible',
    title: 'Appears within a time',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?<s>.+?)\\s+(?:${BE}\\s+)?(?:appears?|shown|displayed|visible|loads?|available|ready|opens?)\\s+(?:in|within)\\s+(?:under\\s+)?(?<n>${NUM})\\s*(?<u>seconds?|secs?|s|ms|milliseconds?|minutes?)`,
          ),
          (g) => ({
            target: ctx.name(g.s!),
            options: { timeoutMs: Math.round(toNumber(g.n!) * (/^m(?!s|illi)/i.test(g.u!) ? 60000 : /^(?:ms|milli)/i.test(g.u!) ? 1 : 1000)) },
          }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeVisible(${timeoutArg(a)});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'did not appear' : 'appeared'} within ${(a.options?.timeoutMs ?? 0) / 1000} seconds`,
    examples: ['Report appears within 30 seconds', 'Search results are shown in 2 seconds'],
  },
];
