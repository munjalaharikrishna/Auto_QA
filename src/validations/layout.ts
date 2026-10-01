import { BE, CMP, collectionCode, compareWords, firstMatch, NOT, NUM, nameOf, OBE, re, toCompare, toNumber, toRegion } from './common.js';
import type { ParseContext, Parsed, ValidationSpec } from './types.js';

/** F. Layout and visual (VALIDATIONS.md §3.F). Positions are measured on the page with a tolerance, never to the pixel. */

const SCREEN = '(?:page|screen|window|browser|viewport|display|form|application|app)';
const WHERE = '(?:placed\\s+|positioned\\s+|aligned\\s+|displayed\\s+|shown\\s+|located\\s+|seen\\s+|kept\\s+)?';
const COLOURS =
  '(?:red|green|blue|yellow|orange|purple|pink|brown|black|white|gr[ae]y|teal|cyan|navy|maroon|dark [a-z]+|light [a-z]+|#[0-9a-f]{3,6}|rgb\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*\\))';
const CONTAINER_WORDS =
  '(?:form|section|box|panel|area|block|card|container|widget|dialog|modal|popup|pop-up|menu|navigation|navbar|header|footer|sidebar|table|list|grid)';

function axisOf(text: string): 'x' | 'y' | 'both' {
  const t = text.toLowerCase();
  if (/exact|both|horizontally and vertically|vertically and horizontally/.test(t)) return 'both';
  if (/vertical/.test(t)) return 'y';
  return 'x';
}

/** The subject of a layout sentence: a part of the page ("login form"), or an element ("Logo"). */
const part = (ctx: ParseContext, raw: string) => ctx.container(raw);

/**
 * What "in the middle of the screen" is about. A bare name ("login", "the login section") is the part of the page
 * with that in it, not a single control called Login; a role word ("Login button") keeps it an ordinary element.
 */
const centre = (ctx: ParseContext, raw: string) => {
  const holder = ctx.container(raw);
  if (holder.container) return holder;
  const named = ctx.name(raw);
  return named.roleHint ? named : { ...named, container: true };
};

const SIDE: Record<string, 'width' | 'height'> = {
  high: 'height',
  tall: 'height',
  height: 'height',
  'in height': 'height',
  wide: 'width',
  width: 'width',
  'in width': 'width',
};

export const layoutSpecs: ValidationSpec[] = [
  {
    id: 'VAL-F01',
    type: 'centered',
    title: 'In the middle of the screen',
    targets: 'one',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?<s>.+?)\\s+(?:${BE}\\s+)?${WHERE}(?:(?:at|in|on|around|towards|to)\\s+)?(?:the\\s+)?(?<w>exact\\s+)?(?:middle|centre|center)\\s+of\\s+(?:the\\s+)?${SCREEN}(?<v>\\s+(?:vertically|horizontally))?`,
          ),
          (g) => ({ target: centre(ctx, g.s!), options: { axis: axisOf(`${g.w ?? ''} ${g.v ?? ''}`), tolerance: 0.05 } }),
        ],
        [
          re(
            `(?<s>.+?)\\s+${BE}\\s+(?<a>(?:horizontally|vertically|exactly)\\s+)?(?:centred|centered|center[- ]aligned|centre[- ]aligned)(?<b>\\s+(?:horizontally|vertically))?(?:\\s+(?:on|in)\\s+(?:the\\s+)?${SCREEN})?`,
          ),
          (g) => ({ target: centre(ctx, g.s!), options: { axis: axisOf(`${g.a ?? ''} ${g.b ?? ''}`), tolerance: 0.05 } }),
        ],
        [
          re(`(?<s>.+?)\\s+${BE}\\s+(?:in\\s+)?the\\s+(?<w>exact\\s+)?(?:middle|centre|center)(?<v>\\s+(?:vertically|horizontally))?`),
          (g) => ({ target: centre(ctx, g.s!), options: { axis: axisOf(`${g.w ?? ''} ${g.v ?? ''}`), tolerance: 0.05 } }),
        ],
      ]),
    code: (a, c) => [
      `await expect(${c.target()}).${NOT(a)}toBeCentered({ axis: ${c.quote(a.options?.axis ?? 'x')}, tolerance: ${a.options?.tolerance ?? 0.05} });`,
    ],
    passed: (a) =>
      `${nameOf(a)} ${a.negated ? 'was not' : 'was'} in the middle of the screen${a.options?.axis === 'y' ? ' vertically' : a.options?.axis === 'both' ? ' (exact centre)' : ' horizontally'}`,
    examples: [
      'Login form is in the middle of the screen',
      'login section at middle of the page',
      'login was middle of screen',
      'The login box is centered on the page',
      'Login form is centred vertically',
      'Login form is in the exact centre of the screen',
    ],
  },
  {
    id: 'VAL-F03',
    type: 'region',
    title: 'In a part of the screen',
    targets: 'one',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?<s>.+?)\\s+${BE}\\s+${WHERE}(?:(?:at|in|on)\\s+)?(?:the\\s+)?(?<r>(?:top|upper|bottom|lower)[ -](?:left|right|centre|center)|top|bottom|left|right)(?:\\s+(?:corner|side|part|area|half))?(?:\\s+of\\s+(?:the\\s+)?${SCREEN})?`,
          ),
          (g) => {
            const region = toRegion(g.r!);
            return region ? { target: part(ctx, g.s!), options: { region } } : undefined;
          },
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeInRegion(${c.quote(a.options?.region ?? 'center')});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was not' : 'was'} at the ${(a.options?.region ?? '').replace('-', ' ')} of the screen`,
    examples: ['Logo is at the top left', 'Chat icon is bottom right', 'Menu is on the left side of the screen'],
  },
  {
    id: 'VAL-F04',
    type: 'relative-position',
    title: 'Above, below, left or right of another element',
    targets: 'two',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?<s>.+?)\\s+${BE}\\s+(?<rel>below|under|beneath|above|over|(?:to\\s+)?(?:the\\s+)?left\\s+of|(?:to\\s+)?(?:the\\s+)?right\\s+of|on\\s+the\\s+left\\s+of|on\\s+the\\s+right\\s+of|before|after)\\s+(?:the\\s+)?(?<o>.+)`,
          ),
          (g) => {
            const r = g.rel!.toLowerCase();
            const relation = /below|under|beneath|after/.test(r) ? 'below' : /above|over|before/.test(r) ? 'above' : /left/.test(r) ? 'left-of' : 'right-of';
            return { target: ctx.name(g.s!), other: ctx.name(g.o!), options: { relation } };
          },
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBePlacedRelativeTo(${c.other()}, ${c.quote(a.options?.relation ?? 'below')});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was not' : 'was'} ${(a.options?.relation ?? '').replace('-', ' ')} "${a.other?.target}"`,
    examples: ['Error is below the Email field', 'Cancel is to the left of Save', 'Logo is above the menu'],
  },
  {
    id: 'VAL-F06',
    type: 'aligned',
    title: 'Lined up',
    targets: 'two',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:and|with)\\s+(?<o>.+?)\\s+(?:fields?\\s+|buttons?\\s+|boxes\\s+)?${BE}\\s+(?<e>left|right|top|bottom)[- ]aligned`),
          (g) => ({ target: ctx.name(g.s!), other: ctx.name(g.o!), options: { relation: `aligned-${g.e!.toLowerCase()}` as 'aligned-left', tolerance: 2 } }),
        ],
        [
          re(`(?<s>.+?)\\s+${BE}\\s+(?<e>left|right|top|bottom)[- ]aligned\\s+with\\s+(?:the\\s+)?(?<o>.+)`),
          (g) => ({ target: ctx.name(g.s!), other: ctx.name(g.o!), options: { relation: `aligned-${g.e!.toLowerCase()}` as 'aligned-left', tolerance: 2 } }),
        ],
      ]),
    code: (a, c) => [
      `await expect(${c.target()}).${NOT(a)}toBeAlignedWith(${c.other()}, ${c.quote((a.options?.relation ?? 'aligned-left').replace('aligned-', ''))}, { tolerance: ${a.options?.tolerance ?? 2} });`,
    ],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was not' : 'was'} ${(a.options?.relation ?? '').replace('aligned-', '')}-aligned with "${a.other?.target}"`,
    examples: ['Email and Password fields are left-aligned', 'Cancel is top-aligned with Save'],
  },
  {
    id: 'VAL-F07',
    type: 'overlap',
    title: 'Does not overlap',
    targets: 'two',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+(?:do|does)?\\s*overlaps?\\s+(?:with\\s+)?(?:the\\s+)?(?<o>.+)`),
          (g) => ({ target: ctx.name(g.s!), other: ctx.name(g.o!), negated: !ctx.negated }),
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toNotOverlap(${c.other()});`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'overlapped' : 'did not overlap'} "${a.other?.target}"`,
    examples: ['Labels do not overlap the fields'],
  },
  {
    id: 'VAL-F08',
    type: 'size',
    title: 'Size in pixels',
    targets: 'one',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+${BE}\\s+(?:(?<cmp>${CMP})\\s+)?(?<n>\\d+)\\s*(?:px|pixels?)\\s+(?<side>high|tall|wide|in height|in width)`),
          (g) => ({ target: part(ctx, g.s!), expected: g.n, options: { compare: toCompare(g.cmp), side: SIDE[g.side!.toLowerCase()] } }),
        ],
        [
          re(`(?<s>.+?)\\s+(?<side>height|width)\\s+${BE}\\s+(?:(?<cmp>${CMP})\\s+)?(?<n>\\d+)\\s*(?:px|pixels?)`),
          (g) => ({ target: part(ctx, g.s!), expected: g.n, options: { compare: toCompare(g.cmp), side: SIDE[g.side!.toLowerCase()] } }),
        ],
      ]),
    code: (a, c) => [
      `await expect(${c.target()}).${NOT(a)}toHaveSize(${c.quote(a.options?.side ?? 'height')}, ${c.quote(a.options?.compare ?? 'eq')}, ${Number(a.expected)});`,
    ],
    passed: (a) => `${nameOf(a)} ${a.options?.side} ${a.negated ? 'was not' : 'was'} ${compareWords(a.options?.compare)} ${a.expected} px`,
    examples: ['Button is at least 44 px high', 'Logo is 200 px wide', 'Banner height is at most 120 px'],
  },
  {
    id: 'VAL-F09',
    type: 'same-size',
    title: 'All the same size',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:all\\s+|every\\s+|each\\s+)?(?<s>[\\p{L}][\\p{L} ]*?)\\s+(?:have|has|are)\\s+the\\s+same\\s+(?<side>height|width)`),
          (g) => ({ options: { note: g.s!.trim(), side: g.side!.toLowerCase() } }),
        ],
      ]),
    code: (a, c) => [`await expect(${collectionCode(a.options?.note ?? '', c.quote)}).${NOT(a)}toHaveSameSize(${c.quote(a.options?.side ?? 'height')});`],
    passed: (a) => `All ${a.options?.note} ${a.negated ? 'were not' : 'were'} the same ${a.options?.side}`,
    examples: ['All product cards have the same height'],
  },
  {
    id: 'VAL-F10',
    type: 'css',
    title: 'Colour, bold, italic',
    targets: 'one',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?<s>.+?)\\s+${BE}\\s+(?:coloured\\s+|colored\\s+|shown in\\s+|displayed in\\s+|in\\s+)?(?<c>${COLOURS})(?:\\s+(?:in colou?r|coloured|colored))?`,
          ),
          (g) => {
            const subject = g.s!;
            const text = /\b(?:text|label|message|error|font|heading|title|link|caption)\s*$/i.test(subject);
            return { target: part(ctx, subject), expected: g.c, options: { name: text ? 'color' : 'background-color' } };
          },
        ],
        [
          re(`(?<s>.+?)\\s+(?:text\\s+|font\\s+|label\\s+)?${BE}\\s+(?<f>bold|italic|underlined|uppercase|lowercase)`),
          (g) => ({
            target: ctx.name(g.s!),
            expected: g.f!.toLowerCase(),
            options: {
              name: { bold: 'font-weight', italic: 'font-style', underlined: 'text-decoration-line', uppercase: 'text-transform', lowercase: 'text-transform' }[
                g.f!.toLowerCase()
              ],
            },
          }),
        ],
      ]),
    code: (a, c) => {
      const name = a.options?.name ?? 'color';
      const value =
        { bold: 'bold', italic: 'italic', underlined: 'underline', uppercase: 'uppercase', lowercase: 'lowercase' }[a.expected ?? ''] ?? a.expected ?? '';
      return name === 'color' || name === 'background-color' || name === 'border-color'
        ? [`await expect(${c.target()}).${NOT(a)}toHaveColour(${c.quote(name)}, ${c.quote(a.expected ?? '')});`]
        : [`await expect(${c.target()}).${NOT(a)}toHaveStyle(${c.quote(name)}, ${c.quote(value)});`];
    },
    passed: (a) => `${nameOf(a)} ${a.negated ? 'was not' : 'was'} ${a.expected}`,
    examples: ['Login button is blue', 'Error text is red', 'Selected tab is bold'],
  },
  {
    id: 'VAL-F12',
    type: 'sticky',
    title: 'Stays in place when scrolling',
    targets: 'one',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?<s>.+?)\\s+(?:stays?|remains?|is kept|is fixed|keeps)\\s+(?:fixed\\s+)?(?:at the (?:top|bottom)\\s+)?(?:when|while|after)\\s+(?:the page is\\s+)?scroll(?:ing|ed)?`,
          ),
          (g) => ({ target: part(ctx, g.s!) }),
        ],
        [re(`(?<s>.+?)\\s+${BE}\\s+(?:sticky|fixed)`), (g) => ({ target: part(ctx, g.s!) })],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toBeSticky();`],
    passed: (a) => `${nameOf(a)} ${a.negated ? 'moved' : 'stayed in place'} when the page was scrolled`,
    examples: ['Header stays at the top when scrolling', 'Header is sticky'],
  },
  {
    id: 'VAL-F13',
    type: 'images-loaded',
    title: 'Images load',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:all\\s+|the\\s+|every\\s+)?(?:[\\p{L}]+\\s+)?images?\\s+(?:are|is)\\s+(?:shown|displayed|loaded|visible|not broken)`), () => ({})],
        [re(`no\\s+broken\\s+images?`), () => ({})],
      ]),
    code: (a, c) => [`await expect(page.locator('body')).${NOT(a)}toHaveLoadedImages();`],
    passed: (a) => (a.negated ? 'Some images did not load' : 'Every image had loaded'),
    examples: ['Product images are shown', 'No broken images'],
  },
  {
    id: 'VAL-F16',
    type: 'structure',
    title: 'A part of the page contains these parts',
    targets: 'one',
    container: true,
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?<s>[\\p{L}][\\p{L} ]*?\\s${CONTAINER_WORDS})\\s+(?:has|have|contains?|includes?|shows?|displays?)\\s+(?<list>[^,]+(?:,\\s*(?:and\\s+)?[^,]+)+|[^,]+\\s+and\\s+[^,]+)`,
          ),
          (g) => {
            const list = g
              .list!.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
              .map((x) => ctx.value(x).trim())
              .filter(Boolean);
            return { target: part(ctx, g.s!), expected: list.join(', '), options: { list } };
          },
        ],
      ]),
    code: (a, c) => [`await expect(${c.target()}).${NOT(a)}toHaveParts([${(a.options?.list ?? []).map(c.quote).join(', ')}]);`],
    passed: (a) => `${nameOf(a)} contained ${(a.options?.list ?? []).join(', ')}`,
    examples: ['Login form has Email, Password and Login'],
  },
  {
    id: 'VAL-F17',
    type: 'layout-shift',
    title: 'Page does not jump while loading',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:the\\s+)?page\\s+(?:jumps?|shifts?|moves?|flickers?)(?:\\s+around)?\\s+(?:while|during|when)\\s+loading`), () => ({ negated: !ctx.negated })],
      ]),
    code: (a, c) => {
      c.helpers.add('expectWebVitals');
      return ['await expectWebVitals(page, { cls: 0.1 });'];
    },
    passed: () => 'The page did not jump while loading',
    examples: ['Page does not jump while loading'],
  },
];

void OBE;
void NUM;
void toNumber;
void ({} as Parsed);
