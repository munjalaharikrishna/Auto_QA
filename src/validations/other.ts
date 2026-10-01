import { BE, CMP, compareWords, firstMatch, NUM, re, toCompare, toList, toMilliseconds, toNumber, UNIT } from './common.js';
import type { ValidationSpec } from './types.js';

/** L. Accessibility, M. Performance, N. Files, O. Data, P. Timing (VALIDATIONS.md §3.L–P). */

export const otherSpecs: ValidationSpec[] = [
  {
    id: 'VAL-L02',
    type: 'fields-labelled',
    title: 'Every field has a label',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:every|each|all)\\s+(?:form\\s+)?(?:fields?|inputs?)\\s+(?:has|have|is|are)\\s+(?:a\\s+)?(?:label(?:l?ed|s)?)`), () => ({})],
      ]),
    code: (_a, c) => {
      c.helpers.add('expectFieldsLabelled');
      return ['await expectFieldsLabelled(page);'];
    },
    passed: () => 'Every field had a label',
    examples: ['Every field has a label'],
  },
  {
    id: 'VAL-L03',
    type: 'images-alt',
    title: 'Every image has alternative text',
    targets: 'none',
    parse: (ctx) => firstMatch(ctx.text, [[re(`(?:every|each|all)\\s+images?\\s+(?:has|have)\\s+(?:an?\\s+)?(?:alt|alternative)(?:\\s+text)?`), () => ({})]]),
    code: (_a, c) => {
      c.helpers.add('expectImagesHaveAlt');
      return ['await expectImagesHaveAlt(page);'];
    },
    passed: () => 'Every image had alternative text',
    examples: ['All images have alt text'],
  },
  {
    id: 'VAL-L04',
    type: 'tab-order',
    title: 'Keyboard order',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:pressing\\s+)?tab\\s+(?:goes|moves|navigates|order is|key goes|key moves)\\s+(?:through\\s+|in this order\\s*:?\\s*)?(?<list>.+)`),
          (g) => ({ expected: toList(ctx, g.list!).join(', '), options: { list: toList(ctx, g.list!) } }),
        ],
      ]),
    code: (_a, c) => {
      c.helpers.add('expectTabOrder');
      return [`await expectTabOrder(page, [${(_a.options?.list ?? []).map(c.quote).join(', ')}]);`];
    },
    passed: (a) => `Tab went ${(a.options?.list ?? []).join(' → ')}`,
    examples: ['Tab goes Email, Password, Login'],
  },
  {
    id: 'VAL-M01',
    type: 'load-time',
    title: 'Page load time',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:the\\s+)?(?:[\\p{L}][\\p{L} ]*?\\s+)?page\\s+loads?\\s+(?:in|within)\\s+(?:(?<cmp>${CMP})\\s+)?(?<n>${NUM})\\s*(?<u>${UNIT})`),
          (g) => ({ expected: String(toMilliseconds(g.n!, g.u!)), options: { compare: g.cmp ? toCompare(g.cmp) : 'lte' } }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectLoadTime');
      return [`await expectLoadTime(page, ${c.quote(a.options?.compare ?? 'lte')}, ${Number(a.expected)});`];
    },
    passed: (a) => `The page loaded ${compareWords(a.options?.compare === 'lt' ? 'lt' : 'lte')} ${Number(a.expected) / 1000} seconds`,
    examples: ['Home page loads in under 3 seconds'],
  },
  {
    id: 'VAL-M03',
    type: 'web-vitals',
    title: 'Page speed and stability',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:the\\s+)?(?:core\\s+)?web\\s+vitals?\\s+(?:pass|are good|are within limits|are ok)`), () => ({ options: { note: 'default' } })],
        [
          re(`(?:the\\s+)?(?:largest contentful paint|lcp)\\s+${BE}\\s+(?:under|below|less than|within)\\s+(?<n>${NUM})\\s*(?<u>${UNIT})`),
          (g) => ({ expected: String(toMilliseconds(g.n!, g.u!)), options: { note: 'lcp' } }),
        ],
        [re(`(?:the\\s+)?(?:layout shift|cls)\\s+${BE}\\s+(?:under|below|less than)\\s+(?<n>[\\d.]+)`), (g) => ({ expected: g.n, options: { note: 'cls' } })],
      ]),
    code: (a, c) => {
      c.helpers.add('expectWebVitals');
      return [
        `await expectWebVitals(page, ${a.options?.note === 'lcp' ? `{ lcpMs: ${a.expected} }` : a.options?.note === 'cls' ? `{ cls: ${a.expected} }` : '{ cls: 0.1, lcpMs: 2500 }'});`,
      ];
    },
    passed: (a) => `The page speed was within the limit${a.expected ? ` (${a.expected})` : ''}`,
    examples: ['Web vitals pass', 'Largest contentful paint is under 2.5 seconds'],
  },
  {
    id: 'VAL-N01',
    type: 'download',
    title: 'File downloads',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:.+?\\s+)?downloads?\\s+(?:an?\\s+|the\\s+)?(?:file\\s+)?(?:named\\s+|called\\s+)?(?<v>\\S+\\.\\w{2,5})`),
          (g) => ({ expected: ctx.value(g.v!) }),
        ],
        [re(`(?<v>\\S+\\.\\w{2,5})\\s+${BE}\\s+downloaded`), (g) => ({ expected: ctx.value(g.v!) })],
        [re(`an?\\s+file\\s+${BE}\\s+downloaded`), () => ({ expected: '' })],
        [
          re(`(?:the\\s+)?(?:csv|xlsx|excel|file|download)\\s+has\\s+(?<n>${NUM})\\s+(?:data\\s+)?rows?(?:\\s+and\\s+(?:the\\s+)?header\\s+(?<h>.+))?`),
          (g) => ({ expected: '', options: { compare: 'eq', row: String(toNumber(g.n!)), list: g.h ? toList(ctx, g.h) : undefined, note: 'content' } }),
        ],
        [re(`(?:the\\s+)?(?:pdf|file|download)\\s+${BE}\\s+not\\s+empty`), () => ({ expected: '', options: { note: 'not-empty' } })],
      ]),
    code: (a, c) => {
      c.helpers.add('expectDownload');
      const parts = [
        a.expected ? `name: ${c.quote(a.expected)}` : '',
        a.options?.row ? `rows: ${Number(a.options.row)}` : '',
        a.options?.list?.length ? `header: [${a.options.list.map(c.quote).join(', ')}]` : '',
        a.options?.note === 'not-empty' ? 'notEmpty: true' : '',
      ].filter(Boolean);
      return [`await expectDownload(page, { ${parts.join(', ')} });`];
    },
    passed: (a) => (a.expected ? `${a.expected} was downloaded` : 'A file was downloaded'),
    examples: ['Clicking Export downloads report.csv', 'A file is downloaded', 'The CSV has 10 rows and the header Name, Email'],
  },
  {
    id: 'VAL-O01',
    type: 'sum',
    title: 'Total equals the sum of the items',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:the\\s+)?(?<s>[\\p{L}][\\p{L} ]*?\\s+total)\\s+(?:equals|is equal to|matches|is)\\s+the\\s+sum\\s+of\\s+(?:the\\s+)?(?<o>[\\p{L}][\\p{L} ]*)`),
          (g) => ({ expected: g.s!.trim(), options: { note: g.o!.trim() } }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectSum');
      const word = (a.options?.note ?? '').split(' ').at(-1) ?? '';
      const total = (a.expected ?? '').split(' ')[0];
      const attrs = (w: string) => ['class', 'id', 'data-testid', 'data-test'].map((x) => `[${x}*="${w.replace(/s$/, '')}" i]`).join(', ');
      return [`await expectSum(page.locator(${c.quote(attrs(word))}), page.locator(${c.quote(attrs(total))}).last());`];
    },
    passed: (a) => `The ${a.expected} equalled the sum of the ${a.options?.note}`,
    examples: ['Cart total equals the sum of item prices'],
  },
  {
    id: 'VAL-O03',
    type: 'matches-count',
    title: 'A counter matches the number of items',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:the\\s+)?(?<s>[\\p{L}][\\p{L} ]*?)\\s+(?:count\\s+)?(?:equals|matches|is equal to)\\s+the\\s+number\\s+of\\s+(?<o>[\\p{L}][\\p{L} ]*)`),
          (g) => ({ expected: g.s!.trim(), options: { note: g.o!.trim() } }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectCountMatches');
      const attrs = (w: string) => ['class', 'id', 'data-testid', 'data-test'].map((x) => `[${x}*="${w}" i]`).join(', ');
      const counter = (a.expected ?? '').split(' ')[0].toLowerCase();
      const noun = (a.options?.note ?? '').replace(/s$/, '');
      const role: Record<string, string> = { row: 'row', item: 'listitem', link: 'link', button: 'button' };
      const items = role[noun] ? `page.getByRole(${c.quote(role[noun])})` : `page.locator(${c.quote(attrs(noun))})`;
      return [`await expectCountMatches(page.locator(${c.quote(attrs(counter))}).first(), ${items});`];
    },
    passed: (a) => `The ${a.expected} matched the number of ${a.options?.note}`,
    examples: ['Badge count equals the number of rows'],
  },
  {
    id: 'VAL-P03',
    type: 'value-changes',
    title: 'Value changes over time',
    targets: 'one',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<s>.+?)\\s+changes?\\s+from\\s+(?<a>.+?)\\s+to\\s+(?<b>.+?)(?:\\s+(?:within|in|after)\\s+(?<n>${NUM})\\s*(?<u>${UNIT}))?`),
          (g) => ({
            target: ctx.name(g.s!),
            expected: ctx.value(g.b!),
            options: { note: ctx.value(g.a!), timeoutMs: g.n ? toMilliseconds(g.n, g.u!) : 30000 },
          }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectEventually');
      return [`await expectEventually(() => ${c.target()}.textContent(), ${c.quote(a.expected ?? '')}, ${a.options?.timeoutMs ?? 30000});`];
    },
    passed: (a) => `${a.target ? `"${a.target}"` : 'The value'} changed from ${a.options?.note} to ${a.expected}`,
    examples: ['Status changes from Pending to Done within 30 seconds'],
  },
];

void BE;
void toList;
