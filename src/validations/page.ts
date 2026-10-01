import { BE, firstMatch, NOT, nameOf, OBE, re } from './common.js';
import type { ValidationSpec } from './types.js';

/** A. Page and navigation (VALIDATIONS.md §3.A). The URL checks (A01–A03) are older and live in the parser. */

export const pageSpecs: ValidationSpec[] = [
  {
    id: 'VAL-A04',
    type: 'title',
    title: 'Page title',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        // "The page" is taken off the front as the subject, so "The page title is X" arrives as "title is X".
        [
          re(`(?:the\\s+)?(?:(?:page|browser|window|tab)\\s+)?title\\s+(?:contains|includes|has|shows)\\s+(?<v>.+)`),
          (g) => ({ expected: ctx.value(g.v!), options: { mode: 'contains' } }),
        ],
        [
          re(`(?:the\\s+)?(?:(?:page|browser|window|tab)\\s+)?title\\s+(?:${BE}|equals)\\s+(?<v>.+)`),
          (g) => ({ expected: ctx.value(g.v!), options: { mode: 'exact' } }),
        ],
      ]),
    code: (a, c) =>
      a.options?.mode === 'contains'
        ? [`await expect(page).${NOT(a)}toHaveTitle(new RegExp(${c.quote(c.escapeRegex(a.expected ?? ''))}, 'i'));`]
        : [`await expect(page).${NOT(a)}toHaveTitle(${c.quote(a.expected ?? '')});`],
    passed: (a) => `The page title ${a.negated ? 'was not' : a.options?.mode === 'contains' ? 'contained' : 'was'} "${a.expected}"`,
    examples: ['Page title is Swag Labs', 'Page title is "Swag Labs"', 'The page title contains Dashboard'],
  },
  {
    id: 'VAL-A06',
    type: 'query-param',
    title: 'Query parameter',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:the\\s+)?(?:url|address|page address|link)\\s+(?:has|contains|includes|shows)\\s+(?:the\\s+)?(?:query\\s+)?(?:param(?:eter)?\\s+)?[?&]?(?<k>[\\w.-]+)=(?<v>\\S+)`,
          ),
          (g) => ({ expected: g.v, options: { name: g.k } }),
        ],
        [
          re(`(?:the\\s+)?(?:query\\s+)?param(?:eter)?\\s+(?<k>[\\w.-]+)\\s+${BE}\\s+(?<v>\\S+)\\s+in\\s+(?:the\\s+)?(?:url|address)`),
          (g) => ({ expected: g.v, options: { name: g.k } }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectQueryParam');
      return [`await expectQueryParam(page, ${c.quote(a.options?.name ?? '')}, ${c.quote(a.expected ?? '')});`];
    },
    passed: (a) => `The address had ${a.options?.name}=${a.expected}`,
    examples: ['URL has ?tab=profile', 'The address contains the query parameter tab=profile'],
  },
  {
    id: 'VAL-A08',
    type: 'new-tab',
    title: 'Opens in a new tab',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+opens?\\s+in\\s+a\\s+new\\s+(?:tab|window)(?:\\s+with\\s+(?:the\\s+)?(?:url\\s+|address\\s+)?(?<v>\\S+))?`),
          (g) => ({ expected: g.v }),
        ],
        [
          re(`a\\s+new\\s+(?:tab|window)\\s+${OBE}(?:opened|opens|appears)(?:\\s+with\\s+(?:the\\s+)?(?:url\\s+|address\\s+)?(?<v>\\S+))?`),
          (g) => ({ expected: g.v }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectNewTab');
      return [`await expectNewTab(page${a.expected ? `, ${c.quote(a.expected)}` : ''});`];
    },
    passed: (a) => `A new tab opened${a.expected ? ` with ${a.expected}` : ''}`,
    examples: ['Help opens in a new tab with URL /help', 'A new tab is opened'],
  },
  {
    id: 'VAL-A09',
    type: 'href',
    title: 'Link target',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:points?\\s+to|links?\\s+to|leads?\\s+to|goes?\\s+to|has\\s+(?:the\\s+)?(?:href|link|url|target)\\s+(?:of\\s+)?)\\s*(?<v>\\S+)`),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveAttribute('href', new RegExp(${c.quote(c.escapeRegex(a.expected ?? ''))}));`],
    passed: (a) => `${nameOf(a)} pointed to ${a.expected}`,
    examples: ['Terms link points to /terms', 'The Help link leads to /help'],
  },
  {
    id: 'VAL-A10',
    type: 'link-safe',
    title: 'External link opens safely',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [[re(`(?<s>.+?)\\s+opens?\\s+(?:safely|securely)(?:\\s+in\\s+a\\s+new\\s+tab)?`), (g) => ({ target: ctx.name(g.s!) })]]),
    code: (a, c) => [`await expect(${c.target()}).toHaveAttribute('target', '_blank');`, `await expect(${c.target()}).toHaveAttribute('rel', /noopener/);`],
    passed: (a) => `${nameOf(a)} opens in a new tab with rel="noopener"`,
    examples: ['External link opens safely'],
  },
  {
    id: 'VAL-A13',
    type: 'selected',
    title: 'Selected tab or menu item',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?\\s(?:tab|menu item|menu|link|step|row|item|page link))\\s+${BE}\\s+(?:selected|active|current|highlighted)`),
          (g) => ({ target: ctx.name(g.s!) }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeSelectedItem();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was not' : 'was'} selected`,
    examples: ['Profile tab is selected', 'Settings menu item is active'],
  },
];
