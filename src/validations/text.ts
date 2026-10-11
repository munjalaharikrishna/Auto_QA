import { BE, firstMatch, NOT, nameOf, OBE, re, toList } from './common.js';
import type { ValidationSpec } from './types.js';

/** C. Text and content (VALIDATIONS.md §3.C). Text shown / not shown and field values are older and live in the parser. */

const FORMATS: Array<[RegExp, string, string]> = [
  [/^DD[/.-]MM[/.-]YYYY$/i, 'date-dmy', 'a date as DD/MM/YYYY'],
  [/^MM[/.-]DD[/.-]YYYY$/i, 'date-mdy', 'a date as MM/DD/YYYY'],
  [/^YYYY-MM-DD$/i, 'date-iso', 'a date as YYYY-MM-DD'],
  [/^(?:a\s+)?(?:valid\s+)?email(?:\s+address)?$/i, 'email', 'an email address'],
  [/^(?:a\s+)?(?:valid\s+)?phone(?:\s+number)?$/i, 'phone', 'a phone number'],
  [/^(?:a\s+)?currency(?:\s+amount)?$/i, 'currency', 'a currency amount'],
  [/^(?:a\s+)?number$/i, 'number', 'a number'],
  [/^(?:a\s+)?time(?:\s+format)?$/i, 'time', 'a time'],
];

export const textSpecs: ValidationSpec[] = [
  {
    id: 'VAL-C03',
    type: 'exact-text',
    title: 'Element has exactly this text',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:the\\s+)?text\\s+of\\s+(?<s>.+?)\\s+${BE}\\s+(?<v>.+)`), (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) })],
        [
          re(`(?<s>.+?)\\s+(?:text|label|caption|content)\\s+(?:${BE}|equals|reads|says)\\s+(?:exactly\\s+)?(?<v>.+)`),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveText(${c.quote(a.expected ?? '')});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'did not say' : 'said'} "${a.expected}"`,
    examples: ['Heading text is Products', 'The text of Welcome banner is "Welcome back"'],
  },
  {
    id: 'VAL-C04',
    type: 'contains-text',
    title: 'Element contains this text',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:contains|includes|has the text|shows the text|displays the text|mentions)\\s+(?:the\\s+)?(?:text\\s+)?(?<v>.+)`),
          // A field that holds a value is the older value check; a quoted text is the older text check.
          (g) =>
            /\b(?:field|textbox|text box|input|box|textarea)$/i.test(g.s!) || ctx.quoted(g.v!)
              ? undefined
              : { target: ctx.name(g.s!), expected: ctx.value(g.v!) },
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toContainText(${c.quote(a.expected ?? '')});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'did not contain' : 'contained'} "${a.expected}"`,
    examples: ['Banner contains 50% off', 'The offer banner includes free shipping'],
  },
  {
    id: 'VAL-C14',
    type: 'text-pattern',
    title: 'Text pattern or format',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?<s>.+?)\\s+${BE}\\s+(?:in\\s+(?:the\\s+)?)?(?:format\\s+)?(?<f>[A-Za-z/.-]{8,10}|(?:a\\s+)?(?:valid\\s+)?(?:email|phone|currency|number|time)(?:\\s+(?:address|number|amount|format))?)(?:\\s+format)?`,
          ),
          (g) => {
            const hit = FORMATS.find(([pattern]) => pattern.test(g.f!.trim()));
            return hit ? { target: ctx.name(g.s!), expected: hit[1], options: { mode: 'pattern' } } : undefined;
          },
        ],
        [
          re(`(?<s>.+?)\\s+(?:looks?\\s+like|${BE}\\s+like|matches|follows the pattern)\\s+(?<v>.*#.*)`),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!), options: { mode: 'pattern', name: 'hash' } }),
        ],
      ]),
    code: (a, c) => {
      if (a.options?.name === 'hash') {
        const pattern = `^${(a.expected ?? '')
          .split('#')
          .map((p) => c.escapeRegex(p))
          .join('\\d')}$`.replace(/(\\d)+/g, (m) => m);
        return [`await expect(${c.target()}).${NOT(a)}toHaveText(new RegExp(${c.quote(pattern)}));`];
      }
      return [`await expect(${c.target()}).${NOT(a)}toHaveFormat(${c.quote(a.expected ?? '')});`];
    },
    passed: (a) =>
      `${nameOf(a)} ${a.negated ? 'was not' : 'was'} ${a.options?.name === 'hash' ? `like ${a.expected}` : (FORMATS.find(([, k]) => k === a.expected)?.[2] ?? a.expected)}`,
    examples: ['Order number looks like ORD-######', 'Date is DD/MM/YYYY', 'Contact email is a valid email'],
  },
  {
    id: 'VAL-C09',
    type: 'options',
    title: 'Dropdown offers these options',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:options|choices|values)\\s+(?:are|include|contain)\\s+(?<list>.+)`),
          (g) => ({ target: ctx.name(g.s!), expected: toList(ctx, g.list!).join(', '), options: { list: toList(ctx, g.list!) } }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveOptionsList([${(a.options?.list ?? []).map(c.quote).join(', ')}]);`],
    passed: (a) => `${nameOf(a)} offered ${(a.options?.list ?? []).join(', ')}`,
    examples: ['Country options are India, USA, UK'],
  },
  {
    id: 'VAL-C06',
    type: 'text-list',
    title: 'List of texts',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>[\\p{L}][\\p{L} ]*?)\\s+(?:are|is)\\s+(?<list>[^,]+(?:,\\s*(?:and\\s+)?[^,]+)+)`),
          (g) => ({ target: ctx.name(g.s!), expected: toList(ctx, g.list!).join(', '), options: { list: toList(ctx, g.list!) } }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveTextList([${(a.options?.list ?? []).map(c.quote).join(', ')}]);`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'were not' : 'were'} ${(a.options?.list ?? []).join(', ')}`,
    examples: ['Menu items are Home, About, Contact', 'Footer links are Terms, Privacy and Help'],
  },
  {
    id: 'VAL-C08',
    type: 'selected-option',
    title: 'Dropdown shows this option',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:dropdown\\s+|drop-down\\s+|select\\s+|list\\s+)(?:shows|displays|has|defaults? to|is set to)\\s+(?<v>.+)`),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) }),
        ],
        [
          re(`(?<s>.+?)\\s+(?:defaults? to|is (?:set|preset) to|is preselected as|selected option is)\\s+(?<v>.+)`),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) }),
        ],
        [re(`(?<v>"[^"]+"|\\S+)\\s+${BE}\\s+selected\\s+in\\s+(?:the\\s+)?(?<s>.+)`), (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveSelectedOption(${c.quote(a.expected ?? '')});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'did not show' : 'showed'} "${a.expected}"`,
    examples: ['Country dropdown shows India', 'Country defaults to India'],
  },
  {
    id: 'VAL-C10',
    type: 'placeholder',
    title: 'Placeholder',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?<s>.+?)\\s+placeholder\\s+(?:text\\s+)?${BE}\\s+(?<v>.+)`), (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveAttribute('placeholder', ${c.quote(a.expected ?? '')});`],
    passed: (a) => `${nameOf(a)} placeholder ${a.negated ? 'was not' : 'was'} "${a.expected}"`,
    examples: ['Email placeholder is Enter email'],
  },
  {
    id: 'VAL-C11',
    type: 'tooltip',
    title: 'Tooltip',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:hovering|hover|hovers)\\s+(?:over\\s+|on\\s+)?(?:the\\s+)?(?<s>.+?)\\s+shows?\\s+(?:a\\s+)?(?:tooltip\\s+)?(?<v>.+)`),
          (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) }),
        ],
        [re(`(?<s>.+?)\\s+(?:has|shows)\\s+(?:a\\s+)?tooltip\\s+(?<v>.+)`), (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveTooltip(${c.quote(a.expected ?? '')});`],
    passed: (a) => `${nameOf(a)} showed the tooltip "${a.expected}"`,
    examples: ['Hovering Info shows Your data is safe', 'Info icon has a tooltip Your data is safe'],
  },
  {
    id: 'VAL-C13',
    type: 'accessible-name',
    title: 'Accessible name',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?<s>.+?)\\s+${BE}\\s+(?:named|called|labell?ed)\\s+(?<v>.+)`), (g) => ({ target: ctx.name(g.s!), expected: ctx.value(g.v!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveAccessibleName(${c.quote(a.expected ?? '')});`],
    passed: (a) => `${nameOf(a)} was named "${a.expected}"`,
    examples: ['Close button is named Close'],
  },
  {
    id: 'VAL-C15',
    type: 'today',
    title: "Today's date",
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [[re(`(?<s>.+?)\\s+${BE}\\s+(?:today|today's date|the current date|the date of today)`), (g) => ({ target: ctx.name(g.s!) })]]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toShowToday();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was not' : 'was'} today's date`,
    examples: ['Order date is today'],
  },
  {
    id: 'VAL-C17',
    type: 'truncated',
    title: 'Text is not cut off',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?<s>.+?)\\s+${BE}\\s+(?:truncated|cut off|clipped|cropped)`), (g) => ({ target: ctx.name(g.s!), negated: !ctx.negated })],
        [
          re(
            `(?<s>.+?)\\s+${BE}\\s+(?:fully\\s+)?(?:visible|readable|shown in full)\\s+(?:and\\s+)?(?:without|with no)\\s+(?:being\\s+)?(?:truncat\\w+|cut off)`,
          ),
          (g) => ({ target: ctx.name(g.s!), negated: ctx.negated }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toShowAllText();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was cut off' : 'was not cut off'}`,
    examples: ['Product name is not truncated'],
  },
];

void OBE;
