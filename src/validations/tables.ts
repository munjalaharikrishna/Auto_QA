import { BE, CMP, collectionCode, compareWords, firstMatch, NOT, NUM, re, toCompare, toList, toNumber } from './common.js';
import type { ValidationSpec } from './types.js';

/** G. Tables and lists (VALIDATIONS.md §3.G). Without a named table, the first table on the page is used. */

const TABLE = "page.locator('table, [role=table], [role=grid], [role=list]').first()";
const ASC = 'lowest|smallest|least|earliest|oldest|first|a-z|a to z|ascending';
const DESC = 'highest|largest|biggest|most|latest|newest|last|z-a|z to a|descending';

/** The table to look at: the one the tester named, or the first on the page. */
const scope = (a: { target?: string }, c: { target(): string }) => (a.target ? c.target() : TABLE);

export const tableSpecs: ValidationSpec[] = [
  {
    id: 'VAL-G01',
    type: 'table-headers',
    title: 'Column headers',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:the\\s+)?(?:[\\p{L}][\\p{L} ]*?\\s+)?(?:table\\s+)?columns?\\s+(?:are|is|include|contain)\\s+(?<list>.+)`),
          (g) => ({ expected: toList(ctx, g.list!).join(', '), options: { list: toList(ctx, g.list!) } }),
        ],
        [
          re(`(?:the\\s+)?(?:table\\s+)?headers\\s+(?:are|include|contain)\\s+(?<list>.+)`),
          (g) => ({ expected: toList(ctx, g.list!).join(', '), options: { list: toList(ctx, g.list!) } }),
        ],
      ]),
    code: (a, c) => [`await expect(${TABLE}).${NOT(a)}toHaveColumns([${(a.options?.list ?? []).map(c.quote).join(', ')}]);`],
    passed: (a) => `The table had the columns ${(a.options?.list ?? []).join(', ')}`,
    examples: ['Table columns are Name, Email, Status'],
  },
  {
    id: 'VAL-G02',
    type: 'row-count',
    title: 'Number of rows',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:the\\s+)?(?:table|list|grid)\\s+(?:shows?|has|have|contains?|displays?|lists?)\\s+(?:(?<cmp>${CMP})\\s+)?(?<n>${NUM})\\s+(?:data\\s+)?(?:rows|records|entries|results)`,
          ),
          (g) => ({ expected: String(toNumber(g.n!)), options: { compare: toCompare(g.cmp) } }),
        ],
        [
          re(`(?:(?<cmp>${CMP})\\s+)?(?<n>${NUM})\\s+(?:data\\s+)?(?:rows|records|entries)\\s+(?:are|is)\\s+(?:shown|displayed|listed)`),
          (g) => ({ expected: String(toNumber(g.n!)), options: { compare: toCompare(g.cmp) } }),
        ],
      ]),
    code: (a, c) => [`await expect(${TABLE}).${NOT(a)}toHaveRows(${c.quote(a.options?.compare ?? 'eq')}, ${Number(a.expected)});`],
    passed: (a) => `The table had ${compareWords(a.options?.compare)} ${a.expected} rows`,
    examples: ['Table shows 10 rows', '5 rows are shown'],
  },
  {
    id: 'VAL-G03',
    type: 'row-cell',
    title: 'A row or cell has a value',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        // "Row 2, column Price is $10": the cell by its place.
        [
          re(`(?:the\\s+)?row\\s+(?<n>\\d+),?\\s+column\\s+(?<c>[\\p{L}][\\p{L} ]*?)\\s+${BE}\\s+(?<v>.+)`),
          (g) => ({ expected: ctx.value(g.v!), options: { row: g.n, column: g.c!.trim(), mode: 'exact' } }),
        ],
        // "Row for Asha has Status Active": the row by a word in it.
        [
          re(
            `(?:the\\s+)?row\\s+(?:for|with|containing|of)\\s+(?<r>\\S+(?:\\s\\S+)??)\\s+(?:has|shows|contains|displays)\\s+(?:(?<c>[\\p{L}]+(?:\\s[\\p{L}]+)?)\\s+)?(?<v>\\S+)`,
          ),
          (g) => ({ expected: ctx.value(g.v!), options: { row: ctx.value(g.r!), column: g.c, mode: 'contains' } }),
        ],
      ]),
    code: (a, c) =>
      a.options?.mode === 'exact'
        ? [`await expect(${TABLE}).${NOT(a)}toHaveCellAt(${Number(a.options.row)}, ${c.quote(a.options.column ?? '')}, ${c.quote(a.expected ?? '')});`]
        : [
            `await expect(${TABLE}).${NOT(a)}toHaveRowWith(${c.quote(a.options?.row ?? '')}, ${c.quote(a.expected ?? '')}${a.options?.column ? `, ${c.quote(a.options.column)}` : ''});`,
          ],
    passed: (a) =>
      a.options?.mode === 'exact'
        ? `Row ${a.options.row}, ${a.options.column} was "${a.expected}"`
        : `The row for "${a.options?.row}" had ${a.options?.column ? `${a.options.column} ` : ''}"${a.expected}"`,
    examples: ['Row for Asha has Status Active', 'The row for "Asha" shows "Active"', 'Row 2, column Price is $10'],
  },
  {
    id: 'VAL-G05',
    type: 'sorted',
    title: 'Sorted',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:sorting|sorted)\\s+by\\s+(?<c>[\\p{L}][\\p{L} ]*?)\\s+(?:shows|gives|puts|lists|orders)\\s+(?:the\\s+)?(?:(?<asc>${ASC})|(?<desc>${DESC}))(?:\\s+first)?`,
          ),
          (g) => ({ options: { column: g.c!.trim(), order: g.asc ? 'asc' : 'desc' } }),
        ],
        [
          re(
            `(?:the\\s+)?(?:[\\p{L}]+\\s+)?(?:table\\s+|list\\s+)?${BE}\\s+sorted\\s+by\\s+(?<c>[\\p{L}][\\p{L} ]*?)(?:\\s+(?<asc>ascending|asc)|\\s+(?<desc>descending|desc))?`,
          ),
          (g) => ({ options: { column: g.c!.trim(), order: g.desc ? 'desc' : 'asc' } }),
        ],
      ]),
    code: (a, c) => [`await expect(${TABLE}).${NOT(a)}toBeSortedBy(${c.quote(a.options?.column ?? '')}, ${c.quote(a.options?.order ?? 'asc')});`],
    passed: (a) => `The table was sorted by ${a.options?.column}, ${a.options?.order === 'desc' ? 'highest' : 'lowest'} first`,
    examples: ['Sorting by Price shows lowest first', 'Table is sorted by Name ascending'],
  },
  {
    id: 'VAL-G06',
    type: 'every-row',
    title: 'Every row or result matches',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:after\\s+[^,]+,\\s*)?(?:every|each|all)\\s+(?:row|result|item|entry|record|product)s?\\s+(?:is|are|has|have|contains?|shows?|includes?)\\s+(?:a\\s+)?(?:(?<c>status|name|type|category|country|city|state)\\s+(?:of\\s+)?)?(?<v>"[^"]+"|.+)`,
          ),
          (g) => ({ expected: ctx.value(g.v!), options: g.c ? { column: g.c } : undefined }),
        ],
      ]),
    code: (a, c) => [
      `await expect(${TABLE}).${NOT(a)}toHaveEveryRowContaining(${c.quote(a.expected ?? '')}${a.options?.column ? `, ${c.quote(a.options.column)}` : ''});`,
    ],
    passed: (a) => `Every row ${a.negated ? 'did not contain' : 'contained'} "${a.expected}"`,
    examples: ['After filter Active, every row is Active', 'Every result contains shoe'],
  },
  {
    id: 'VAL-G08',
    type: 'pagination',
    title: 'Page of rows',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:page\\s+(?<p>\\d+)\\s+)?(?:shows?|displays?|lists?)\\s+(?:rows?|items?|results?|records?)\\s+(?<a>\\d+)\\s*(?:-|–|to)\\s*(?<b>\\d+)(?:\\s+of\\s+\\d+)?`,
          ),
          (g) => ({ expected: `${g.a}-${g.b}`, options: { name: g.p } }),
        ],
      ]),
    code: (a, c) => {
      const [from, to] = (a.expected ?? '').split('-');
      return [`await expect(page.getByText(new RegExp(${c.quote(`${from}\\s*(?:-|–|to)\\s*${to}`)})).first()).${NOT(a)}toBeVisible();`];
    },
    passed: (a) => `The page showed rows ${a.expected}`,
    examples: ['Page 2 shows rows 11-20'],
  },
  {
    id: 'VAL-G10',
    type: 'no-duplicates',
    title: 'Each appears once',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:each|every)\\s+(?<s>[\\p{L}][\\p{L} ]*?)\\s+(?:appears?|is shown|is listed|is displayed)\\s+(?:only\\s+)?once`),
          (g) => ({ options: { note: g.s!.trim() } }),
        ],
        [re(`no\\s+duplicate\\s+(?<s>[\\p{L}][\\p{L} ]*?)(?:\\s+(?:are|is)\\s+(?:shown|listed))?`), (g) => ({ options: { note: g.s!.trim() } })],
      ]),
    code: (a, c) => [`await expect(${collectionCode(a.options?.note ?? '', c.quote)}).${NOT(a)}toHaveNoDuplicates();`],
    passed: (a) => `Each ${a.options?.note} appeared once`,
    examples: ['Each product appears once', 'No duplicate items are listed'],
  },
];

void scope;
