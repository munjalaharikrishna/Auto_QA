import { BE, CMP, firstMatch, NUM, OBE, re, toCompare, toMilliseconds, toNumber, UNIT } from './common.js';
import type { ValidationSpec } from './types.js';

/** H. Network, I. Health, J.-K. Session and storage (VALIDATIONS.md §3.H–K). The page's requests, console and cookies are recorded while the test runs. */

const METHOD = '(?:GET|POST|PUT|PATCH|DELETE|HEAD)';

export const networkSpecs: ValidationSpec[] = [
  {
    id: 'VAL-H03',
    type: 'request',
    title: 'A request was sent (or not), its body and answer',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        // "Search responds in under 2 seconds"
        [
          re(`(?:[\\p{L}][\\p{L} ]*?\\s+)?responds?\\s+(?:in|within)\\s+(?<cmp>under|less than|within|at most)?\\s*(?<n>${NUM})\\s*(?<u>${UNIT})`),
          (g) => ({ expected: '', options: { timeoutMs: toMilliseconds(g.n!, g.u!), compare: 'lte', note: 'timing' } }),
        ],
        // "Clicking Save calls POST /api/users with email a@b.com and gets 201"
        [
          re(
            `(?:.+?\\s+)?(?:calls?|sends?|triggers?|makes?|fires?)\\s+(?:an?\\s+)?(?:(?<m>${METHOD})\\s+)?(?:request\\s+|call\\s+)?(?:to\\s+)?(?<p>/\\S*)(?:\\s+with\\s+(?<b>.+?))?(?:\\s+and\\s+(?:gets?|returns?|receives?|answers?)\\s+(?:status\\s+)?(?<st>\\d{3}))?`,
          ),
          (g) => ({
            expected: g.p,
            options: { method: g.m?.toUpperCase(), status: g.st ? Number(g.st) : undefined, list: g.b ? [ctx.value(g.b)] : undefined },
            negated: ctx.negated,
          }),
        ],
        [
          re(
            `(?:an?\\s+)?(?:(?<m>${METHOD})\\s+)?request\\s+(?:to\\s+)?(?<p>/\\S*)\\s+${BE}\\s+(?:sent|made)(?:\\s+with\\s+(?<b>.+?))?(?:\\s+and\\s+(?:gets?|returns?|receives?)\\s+(?:status\\s+)?(?<st>\\d{3}))?`,
          ),
          (g) => ({
            expected: g.p,
            options: { method: g.m?.toUpperCase(), status: g.st ? Number(g.st) : undefined, list: g.b ? [ctx.value(g.b)] : undefined },
          }),
        ],
        [
          re(`(?:the\\s+)?(?:response|server|api)\\s+(?:status\\s+)?${BE}\\s+(?<st>\\d{3})\\s+(?:for|from|to)\\s+(?:(?<m>${METHOD})\\s+)?(?<p>/\\S+)`),
          (g) => ({ expected: g.p, options: { method: g.m?.toUpperCase(), status: Number(g.st) } }),
        ],
        [
          re(`(?:the\\s+)?(?:invalid |empty |incomplete )?(?:form|page|app)\\s+sends?\\s+nothing\\s+to\\s+the\\s+server`),
          () => ({ expected: '', negated: true }),
        ],
        [re(`no\\s+(?:request|call)s?\\s+${OBE}(?:sent|made)(?:\\s+to\\s+(?<p>/\\S*))?`), (g) => ({ expected: g.p ?? '', negated: true })],
      ]),
    code: (a, c) => {
      if (a.negated) {
        c.helpers.add('expectNoRequest');
        return [
          `await expectNoRequest(page, { ${a.options?.method ? `method: ${c.quote(a.options.method)}, ` : ''}${a.expected ? `path: ${c.quote(a.expected)}` : ''} });`,
        ];
      }
      c.helpers.add('expectRequest');
      const parts = [
        a.options?.method ? `method: ${c.quote(a.options.method)}` : '',
        `path: ${c.quote(a.expected ?? '')}`,
        a.options?.status ? `status: ${a.options.status}` : '',
        a.options?.list?.length ? `body: [${a.options.list.map(c.quote).join(', ')}]` : '',
        a.options?.note === 'timing' ? `withinMs: ${a.options.timeoutMs}` : '',
      ].filter(Boolean);
      return [`await expectRequest(page, { ${parts.join(', ')} });`];
    },
    passed: (a) =>
      a.negated
        ? `No ${a.options?.method ?? ''} request${a.expected ? ` to ${a.expected}` : ''} was sent`.replace('  ', ' ')
        : `The page sent ${a.options?.method ?? 'a'} ${a.expected || 'request'}${a.options?.status ? ` and got ${a.options.status}` : ''}`,
    examples: [
      'Clicking Save calls POST /api/users',
      'Clicking Save calls POST /api/users with a@b.com and gets 201',
      'The response is 201 for POST /api/users',
      'Invalid form sends nothing to the server',
      'Search responds in under 2 seconds',
    ],
  },
  {
    id: 'VAL-I04',
    type: 'console-clean',
    title: 'No console errors',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`(?:there\\s+(?:are|is)\\s+)?no\\s+(?:errors?\\s+in\\s+the\\s+)?(?:browser\\s+)?console(?:\\s+errors?)?`), () => ({})],
        [re(`(?:the\\s+)?(?:browser\\s+)?console\\s+(?:has|shows|contains|logs)\\s+no\\s+errors?`), () => ({})],
        [re(`(?:the\\s+)?(?:browser\\s+)?console\\s+(?:has|shows|contains|logs)\\s+(?:any\\s+)?errors?`), () => ({ negated: !ctx.negated })],
      ]),
    code: (_a, c) => {
      c.helpers.add('expectNoConsoleErrors');
      return ['await expectNoConsoleErrors(page);'];
    },
    passed: () => 'The browser console had no errors',
    examples: ['No console errors', 'The browser console has no errors'],
  },
  {
    id: 'VAL-I05',
    type: 'not-blank',
    title: 'Page is not blank',
    targets: 'none',
    // "The page" is taken off the front as the subject, so it can arrive as just "is blank".
    parse: (ctx) => firstMatch(ctx.text, [[re(`(?:(?:the\\s+)?page\\s+)?${BE}\\s+(?:blank|white)`), () => ({ negated: !ctx.negated })]]),
    code: (_a, c) => {
      c.helpers.add('expectNotBlank');
      return ['await expectNotBlank(page);'];
    },
    passed: () => 'The page was not blank',
    examples: ['Page is not blank'],
  },
  {
    id: 'VAL-I06',
    type: 'no-mixed-content',
    title: 'Nothing loaded over plain http',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [re(`no\\s+mixed\\s+content`), () => ({})],
        [re(`(?:all\\s+|every\\s+)?(?:resources?|requests?|content)\\s+(?:are|is|load|loads|loaded)\\s+(?:over|via|using)\\s+https`), () => ({})],
      ]),
    code: (_a, c) => {
      c.helpers.add('expectNoMixedContent');
      return ['await expectNoMixedContent(page);'];
    },
    passed: () => 'Everything loaded over https',
    examples: ['No mixed content', 'All resources load over https'],
  },
  {
    id: 'VAL-J05',
    type: 'cookie',
    title: 'Cookie is set, removed or has a value',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?:an?\\s+|the\\s+)?(?<n>[\\w.-]+)\\s+cookie\\s+${BE}\\s+(?<w>removed|deleted|cleared|missing|gone|absent|expired)(?:\\s+.*)?`),
          (g) => ({ expected: g.n, options: { flags: ['absent'] }, negated: ctx.negated }),
        ],
        [re(`(?:an?\\s+|the\\s+)?(?<n>[\\w.-]+)\\s+cookie\\s+${BE}\\s+(?:set|present|created|stored|saved|issued)(?:\\s+.*)?`), (g) => ({ expected: g.n })],
        [re(`(?:an?\\s+|the\\s+)?(?<n>[\\w.-]+)\\s+cookie\\s+${BE}\\s+(?<v>\\S+)`), (g) => ({ expected: g.n, options: { note: ctx.value(g.v!) } })],
      ]),
    code: (a, c) => {
      c.helpers.add('expectCookie');
      const absent = (a.options?.flags ?? []).includes('absent') !== a.negated && (a.options?.flags ?? []).includes('absent');
      if (absent) return [`await expectCookie(page, ${c.quote(a.expected ?? '')}, { absent: true });`];
      return [`await expectCookie(page, ${c.quote(a.expected ?? '')}${a.options?.note ? `, { value: ${c.quote(a.options.note)} }` : ''});`];
    },
    passed: (a) =>
      (a.options?.flags ?? []).includes('absent')
        ? `The ${a.expected} cookie was removed`
        : `The ${a.expected} cookie was set${a.options?.note ? ` to ${a.options.note}` : ''}`,
    examples: ['Session cookie is set after login', 'Language cookie is de', 'Session cookie is removed'],
  },
  {
    id: 'VAL-J06',
    type: 'cookie-flags',
    title: 'Cookie security flags',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(
            `(?:an?\\s+|the\\s+)?(?<n>[\\w.-]+)\\s+cookie\\s+(?:is|has)\\s+(?<f>(?:secure|http-?only|samesite(?:\\s+\\w+)?)(?:\\s*(?:,|and)\\s*(?:secure|http-?only|samesite(?:\\s+\\w+)?))*)`,
          ),
          (g) => ({
            expected: g.n,
            options: {
              flags: g
                .f!.toLowerCase()
                .split(/\s*(?:,|and)\s*/)
                .map((f) => f.replace('http-only', 'httponly')),
            },
          }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectCookie');
      const flags = a.options?.flags ?? [];
      const parts = [
        flags.includes('secure') ? 'secure: true' : '',
        flags.includes('httponly') ? 'httpOnly: true' : '',
        ...flags.filter((f) => f.startsWith('samesite')).map((f) => `sameSite: ${c.quote(f.replace('samesite', '').trim() || 'lax')}`),
      ].filter(Boolean);
      return [`await expectCookie(page, ${c.quote(a.expected ?? '')}, { ${parts.join(', ')} });`];
    },
    passed: (a) => `The ${a.expected} cookie was ${(a.options?.flags ?? []).join(', ')}`,
    examples: ['Session cookie is secure and httponly'],
  },
  {
    id: 'VAL-K01',
    type: 'storage',
    title: 'Local / session storage value',
    targets: 'none',
    parse: (ctx) =>
      firstMatch(ctx.text, [
        [
          re(`(?<k>[\\w.-]+)\\s+(?<v>\\S+)\\s+${BE}\\s+(?:remembered|saved|stored|kept|persisted)(?:\\s+in\\s+(?<a>local|session)\\s*storage)?`),
          (g) => ({ expected: ctx.value(g.v!), options: { name: g.k, area: (g.a?.toLowerCase() as 'local' | 'session') ?? 'local' } }),
        ],
        [
          re(`(?<a>local|session)\\s*storage\\s+(?:has|contains|shows|keeps)\\s+(?<k>[\\w.-]+)(?:\\s*(?:=|as|is)\\s*(?<v>.+))?`),
          (g) => ({ expected: g.v ? ctx.value(g.v) : '', options: { name: g.k, area: g.a!.toLowerCase() as 'local' | 'session' } }),
        ],
      ]),
    code: (a, c) => {
      c.helpers.add('expectStorage');
      return [
        `await expectStorage(page, ${c.quote(a.options?.area ?? 'local')}, ${c.quote(a.options?.name ?? '')}${a.expected ? `, ${c.quote(a.expected)}` : ''});`,
      ];
    },
    passed: (a) => `${a.options?.area} storage kept ${a.options?.name}${a.expected ? ` as "${a.expected}"` : ''}`,
    examples: ['Theme dark is remembered', 'Local storage has token'],
  },
];

void CMP;
void toCompare;
void toNumber;
