import { BE, firstMatch, NOT, nameOf, re } from './common.js';
import type { ValidationSpec } from './types.js';

/** D. Forms and input (VALIDATIONS.md §3.D). Error text shown, values, enabled/disabled and keyboard submit are older and live in the parser. */

export const formSpecs: ValidationSpec[] = [
  {
    id: 'VAL-D03',
    type: 'invalid',
    title: 'Field marked invalid',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+${BE}\\s+(?:marked\\s+|flagged\\s+|shown\\s+)?(?:as\\s+)?(?:invalid|in error|highlighted in red|flagged)`),
          (g) => ({ target: ctx.name(g.s!) }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeMarkedInvalid();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was not marked invalid' : 'was marked invalid'}`,
    examples: ['Email field is marked invalid', 'Password field is highlighted in red'],
  },
  {
    id: 'VAL-D04',
    type: 'field-error',
    title: 'Error belongs to this field',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:an?\\s+)?(?:error\\s+|message\\s+)?(?<v>[^ ]*\\S|.+?)\\s+(?:${BE}\\s+)?(?:shown|displayed|visible|appears?)\\s+(?:for|next to|under|below|beside)\\s+(?:the\\s+)?(?<s>.+)`,
          ),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveFieldError(${c.quote(a.expected ?? '')});`],
    passed: (a) => `The error "${a.expected}" ${a.negated ? 'was not' : 'was'} shown for ${nameOf(a)}`,
    examples: ['Error "Required" is shown for Email', 'Error "Enter a valid email" is shown below the Email field'],
  },
  {
    id: 'VAL-D05',
    type: 'validation-message',
    title: "Browser's own validation message",
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:the\\s+)?browser\\s+(?:asks|prompts|requires|tells you)\\s+(?:to\\s+|you to\\s+)?(?:fill(?: in| out)?|enter|complete|provide)\\s+(?:in\\s+)?(?:the\\s+)?(?<s>.+?)(?:\\s+field)?`,
          ),
          (g) => ({ target: ctx.name(g.s!) }),
        ],
        [
          re(`(?:the\\s+)?browser(?:'s)?\\s+validation\\s+message\\s+(?<v>"[^"]+"|.+?)\\s+${BE}\\s+(?:shown|displayed)\\s+(?:for|on)\\s+(?:the\\s+)?(?<s>.+)`),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveBrowserMessage(${a.expected ? c.quote(a.expected) : ''});`],
    passed: (a) => `The browser asked for ${nameOf(a)}${a.expected ? ` ("${a.expected}")` : ''}`,
    examples: ['Browser asks to fill the Email field'],
  },
  {
    id: 'VAL-D06',
    type: 'max-length',
    title: 'Maximum length',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:accepts?|allows?|takes?)\\s+(?:at most|a maximum of|up to|max(?:imum)?(?: of)?|no more than)\\s+(?<n>\\d+)\\s+characters?`),
          (g) => ({ target: ctx.name(g.s!), expected: g.n }),
        ],
        [re(`(?:the\\s+)?max(?:imum)?\\s+length\\s+of\\s+(?<s>.+?)\\s+${BE}\\s+(?<n>\\d+)`), (g) => ({ target: ctx.name(g.s!), expected: g.n })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toLimitLengthTo(${Number(a.expected)});`],
    passed: (a) => `${nameOf(a)} accepted at most ${a.expected} characters`,
    examples: ['Username accepts at most 20 characters', 'The maximum length of Username is 20'],
  },
  {
    id: 'VAL-D12',
    type: 'suggestions',
    title: 'Autocomplete suggestions',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:typing|entering|writing)\\s+.+?\\s+(?:suggests?|shows?|offers?|lists?)\\s+(?<v>.+)`), (g) => ({ expected: ctx.value(g.v!) })],
        [
          re(`(?:suggestions?|autocomplete(?: list)?|the suggestions)\\s+(?:include|show|contain|list|offer)s?\\s+(?<v>.+)`),
          (g) => ({ expected: ctx.value(g.v!) }),
        ],
      ]),
    code: (a, c) => [`await expect(page.getByRole('option', { name: ${c.quote(a.expected ?? '')} }).first()).${NOT(a)}toBeVisible();`],
    passed: (a) => `The suggestion "${a.expected}" ${a.negated ? 'was not offered' : 'was offered'}`,
    examples: ['Typing Ban suggests Bangalore', 'Suggestions include Bangalore'],
  },
];
