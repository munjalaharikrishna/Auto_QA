// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the text of a test step or a variable token contains a literal ${…}, which is what is being tested
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { findCompounds, normalize, originalSpan, originalText, quotedValues, sameCompound, spaced, splitIdentifier, tokenize, touchesData } from './index.js';

/** E0.3 exit tests for the text layers: normalization (NM), tokenization (TK) and their data-protection rules. */

const CORPUS = new URL('../../../test/corpus/', import.meta.url);
const sentences: string[] = JSON.parse(readFileSync(new URL('sentences.json', CORPUS), 'utf8'));
const GOLDEN = new URL('tokens.golden.json', CORPUS);

const norm = (s: string): string => normalize(s).text;
const kinds = (s: string): string[] => tokenize(normalize(s)).map((t) => `${t.kind}:${t.text}`);

describe('NM-01 to NM-10: characters and spaces', () => {
  it('NM-01 lower-cases language, never data', () => {
    assert.equal(norm('Click LOGIN'), 'click login');
    assert.equal(norm("Enter 'Cypress' as Username"), "enter 'Cypress' as username");
  });
  it('NM-02 keeps the raw text byte for byte', () => {
    const raw = '  Click\tLOGIN \u00A0 “now”…  ';
    assert.equal(normalize(raw).raw, raw);
  });
  it('NM-03 trims, NM-04 collapses spaces, NM-05 turns tabs and newlines into spaces', () => {
    assert.equal(norm('  Enter username   in field  '), 'enter username in field');
    assert.equal(norm('Click\tthe\nLogin\r\nbutton'), 'click the login button');
  });
  it('NM-06 punctuation variants', () => {
    assert.equal(norm('Wait… then go'), 'wait... then go');
    assert.equal(norm('one‚ two'), 'one, two');
  });
  it('NM-07 quotation marks and NM-08 apostrophes become straight', () => {
    assert.equal(norm('Enter “Login” and ‘x’'), 'enter "Login" and \'x\'');
    assert.equal(norm('Do not click `Save´ twice'), "do not click 'save' twice");
    assert.equal(norm('The user’s page'), "the user's page");
  });
  it('NM-09 dashes', () => {
    assert.equal(norm('sign–in and log—in and e‑mail'), 'sign-in and log-in and e-mail');
  });
  it('NM-10 Unicode variants: no-break space, full-width letters, hidden characters', () => {
    assert.equal(norm('Click\u00A0Login'), 'click login');
    assert.equal(norm('Ｃｌｉｃｋ ＬＯＧＩＮ'), 'click login');
    assert.equal(norm('Click\u200B Login\uFEFF'), 'click login');
  });
});

describe('NM-11 and NM-12: abbreviations and contractions', () => {
  it('NM-11 expands common abbreviations', () => {
    assert.equal(norm('Enter pwd'), 'enter password');
    assert.equal(norm('Click the Login btn'), 'click the login button');
    assert.equal(norm('Type in the txt box'), 'type in the text box');
    assert.equal(norm('Select from DDL'), 'select from dropdown');
  });
  it('NM-12 contractions become fixed forms', () => {
    assert.equal(norm("It can't be empty"), 'it cannot be empty');
    assert.equal(norm("The user doesn't see it"), 'the user does not see it');
    assert.equal(norm('Error shouldn’t appear'), 'error should not appear');
    assert.equal(norm("Login won't work"), 'login will not work');
  });
  it('an abbreviation inside data is left alone', () => {
    assert.equal(norm('Enter "pwd" as value'), 'enter "pwd" as value');
    assert.equal(norm('Use EMP-pwd-01'), 'use EMP-pwd-01');
  });
});

describe('NM-13 to NM-18: what must stay as written', () => {
  it('NM-13 technical terms', () => {
    assert.equal(norm('Use getByRole and data-testid'), 'use getByRole and data-testid');
  });
  it('NM-14 case-sensitive data and NM-15 passwords', () => {
    assert.equal(norm('Enter Admin123 as password'), 'enter Admin123 as password');
    assert.equal(norm('Enter Pa$$w0rd! now'), 'enter Pa$$w0rd! now');
    assert.equal(norm('Type "P a  s s" here'), 'type "P a  s s" here');
  });
  it('NM-16 IDs', () => {
    assert.equal(norm('Run TC_LOGIN_001 and EMP-0042'), 'run TC_LOGIN_001 and EMP-0042');
  });
  it('NM-17 URLs', () => {
    assert.equal(norm('Open https://x.com/Path?A=1 now'), 'open https://x.com/Path?A=1 now');
  });
  it('NM-18 exact expected messages', () => {
    const n = normalize('Verify “Invalid  Credentials” is shown');
    assert.equal(n.text, 'verify "Invalid  Credentials" is shown');
    assert.deepEqual(quotedValues('Verify “Invalid  Credentials” is shown'), ['Invalid  Credentials']);
  });
});

describe('NM-19: every normalized character points back to its original', () => {
  it('maps spans back, also through expansions, collapsed spaces and replaced quotes', () => {
    const raw = 'Enter  PWD in the “Login Name” box';
    const n = normalize(raw);
    assert.equal(n.text, 'enter password in the "Login Name" box');
    const at = (needle: string) => {
      const i = n.text.indexOf(needle);
      return originalText(n, { start: i, end: i + needle.length });
    };
    assert.equal(at('enter'), 'Enter');
    assert.equal(at('password'), 'PWD');
    assert.equal(at('Login Name'), 'Login Name');
    assert.equal(at('box'), 'box');
  });
  it('every token of every corpus sentence points at the right original characters', () => {
    for (const s of sentences) {
      const n = normalize(s);
      assert.equal(n.map.length, n.text.length, s);
      let before = 0;
      for (const t of tokenize(n)) {
        const o = t.original;
        assert.ok(o && o.start >= 0 && o.end <= s.length && o.start <= o.end, `${s} → ${t.text}`);
        assert.ok(o.start >= before - 1, `${s}: tokens must follow the original's order`);
        before = o.start;
        const original = s.slice(o.start, o.end);
        if (original.toLowerCase() !== t.text.toLowerCase()) {
          // Only a recorded change may explain a difference between what a token says and the words behind it.
          assert.ok(
            n.changes.some((c) => c.at.start < o.end && o.start < c.at.end),
            `${s}: "${t.text}" came from "${original}" with no change recorded`,
          );
        }
      }
    }
  });
  it('originalSpan of the whole text is the whole original, trimmed', () => {
    const n = normalize('  a  b  ');
    assert.deepEqual(originalSpan(n, { start: 0, end: n.text.length }), { start: 2, end: 6 });
  });
});

/** A small deterministic generator, so the 500 values are the same on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function testDataValues(): string[] {
  const fixed = [
    'Admin123',
    'admin',
    'ADMIN',
    'Pa$$ w0rd!',
    'P@ssw0rd#2024',
    '  leading and trailing  ',
    'two  spaces',
    'tab\there',
    'line\nbreak',
    'EMP-0042',
    'TC_LOGIN_001',
    'John.Doe+test@Example.COM',
    'https://Example.com/Path?Q=1&R=Two',
    'ünïcödé',
    '日本語のテスト',
    'naïve café',
    'emoji 🙂 ok',
    'Ｆｕｌｌｗｉｄｔｈ',
    'non\u00A0breaking',
    'zero\u200Bwidth',
    'bom\uFEFFchar',
    '“curly” and ‘single’',
    'it’s',
    'a–b—c',
    'wait…',
    "O'Brien",
    'pwd',
    "can't",
    'txt box',
    '',
    ' ',
    '***',
    'a*b',
    '<script>x</script>',
    '${USER}',
    '{{email}}',
    'C:\\data\\photo.jpg',
    '21/02/2024',
    '$29.99',
    '100%',
    'Click LOGIN',
  ];
  const alphabet = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t_-.,:;!?@#$%^&*()[]{}<>/\\|~+=é日🙂“”‘’…–—\u00A0\u200BＡ\'"'];
  const next = lcg(20240221);
  const values = [...fixed];
  while (values.length < 500) {
    const length = 1 + Math.floor(next() * 24);
    let v = '';
    for (let i = 0; i < length; i++) v += alphabet[Math.floor(next() * alphabet.length)];
    values.push(v);
  }
  return values;
}

describe('NM-20 data protection: 500 test-data values come out byte-identical', () => {
  const values = testDataValues();
  it('has 500 values', () => assert.equal(values.length, 500));

  it('as data: the text is returned exactly and the whole value is marked protected', () => {
    for (const v of values) {
      const n = normalize(v, { kind: 'data' });
      assert.equal(n.text, v, JSON.stringify(v));
      assert.equal(n.raw, v);
      if (v) assert.ok(touchesData(n, { start: 0, end: v.length }), JSON.stringify(v));
    }
  });

  it('inside a sentence, between quotes: the value is untouched and marked protected', () => {
    let tested = 0;
    for (const v of values) {
      const q = !v.includes('"') ? '"' : !v.includes("'") ? "'" : undefined;
      if (!q) continue;
      const sentence = `Enter ${q}${v}${q} as Password`;
      const n = normalize(sentence);
      const from = n.text.indexOf(`${q}${v}${q}`);
      assert.ok(from >= 0, `lost ${JSON.stringify(v)} in ${JSON.stringify(n.text)}`);
      assert.equal(n.text, `enter ${q}${v}${q} as password`, JSON.stringify(v));
      if (v) assert.ok(touchesData(n, { start: from + 1, end: from + 1 + v.length }));
      assert.equal(quotedValues(sentence)[0], v);
      tested++;
    }
    assert.ok(tested >= 480, `only ${tested} values could be embedded`);
  });

  it('a value written without quotes survives when it looks like data', () => {
    for (const v of ['Admin123', 'Pa$$w0rd!', 'OrangeHRM', 'EMP-0042', 'TC_LOGIN_001', 'user@Example.COM', 'https://x.com/A?B=1', 'getByRole', 'aB3']) {
      assert.ok(norm(`Enter ${v} now`).includes(v), v);
    }
  });
});

describe('TK-01 to TK-10: tokens', () => {
  it('TK-01 words', () => assert.deepEqual(kinds('Click the Login button'), ['WORD:click', 'WORD:the', 'WORD:login', 'WORD:button']));
  it('TK-02 numbers', () => assert.deepEqual(kinds('Enter 5 items and 1,000.50'), ['WORD:enter', 'NUMBER:5', 'WORD:items', 'WORD:and', 'NUMBER:1,000.50']));
  it('TK-03 symbols', () =>
    assert.deepEqual(kinds('Home > Admin / Users → PIM'), ['WORD:home', 'SYMBOL:>', 'WORD:admin', 'SYMBOL:/', 'WORD:users', 'SYMBOL:→', 'WORD:pim']));
  it('TK-04 quoted text is one literal, whatever is inside', () => {
    const t = tokenize(normalize('Enter \'cypress\' as username and "Hello, world! (1/2)"'));
    const literals = t.filter((x) => x.kind === 'LITERAL');
    assert.deepEqual(
      literals.map((x) => x.value),
      ['cypress', 'Hello, world! (1/2)'],
    );
    assert.equal(t.filter((x) => x.kind === 'SYMBOL').length, 0);
  });
  it('TK-05 variables', () => assert.deepEqual(kinds('Enter ${user} and {{email}}'), ['WORD:enter', 'VARIABLE:${user}', 'WORD:and', 'VARIABLE:{{email}}']));
  it('TK-06 placeholders', () =>
    assert.deepEqual(kinds('Enter <username> and [password]'), ['WORD:enter', 'PLACEHOLDER:<username>', 'WORD:and', 'PLACEHOLDER:[password]']));
  it('TK-07 URLs', () => assert.deepEqual(kinds('Open https://x.com/Path?A=1 now'), ['WORD:open', 'URL:https://x.com/Path?A=1', 'WORD:now']));
  it('TK-08 emails', () => assert.deepEqual(kinds('Enter a@b.com now'), ['WORD:enter', 'EMAIL:a@b.com', 'WORD:now']));
  it('TK-09 dates', () => assert.deepEqual(kinds('On 21/02/2024 and 2024-02-21'), ['WORD:on', 'DATE:21/02/2024', 'WORD:and', 'DATE:2024-02-21']));
  it('TK-10 masks and hidden characters', () => {
    assert.deepEqual(kinds('Password shows ****'), ['WORD:password', 'WORD:shows', 'SPECIAL:****']);
    const hidden = tokenize('a\u200Bb');
    assert.deepEqual(
      hidden.map((t) => [t.kind, t.special]),
      [
        ['WORD', undefined],
        ['SPECIAL', 'hidden'],
        ['WORD', undefined],
      ],
    );
  });
  it('a word with a digit is one word, not a word and a number', () => assert.deepEqual(kinds('Type Admin123'), ['WORD:type', 'WORD:Admin123']));
});

describe('TK-14 and TK-15: flat and compound words', () => {
  it('writes of one name are the same compound', () => {
    for (const other of ['Login Name', 'loginname', 'login_name', 'loginName', 'LOGIN-NAME']) assert.ok(sameCompound('login name', other), other);
    assert.ok(sameCompound('username', 'user name'));
    assert.ok(!sameCompound('user name', 'user id'));
  });
  it('finds a known term written as one word, several words or joined', () => {
    for (const text of ['Enter Login Name here', 'Enter loginname here', 'Enter login_name here']) {
      const tokens = tokenize(normalize(text));
      const found = findCompounds(tokens, ['login name']);
      assert.equal(found.length, 1, text);
      assert.equal(found[0]?.term, 'login name');
    }
    const tokens = tokenize(normalize('Enter user name in the username box'));
    assert.equal(findCompounds(tokens, ['username']).length, 2);
  });
  it('the longest reading wins', () => {
    const tokens = tokenize(normalize('Click Login Name'));
    const found = findCompounds(tokens, ['login', 'login name']);
    assert.deepEqual(
      found.map((f) => f.term),
      ['login name'],
    );
  });
});

describe('TK-11 to TK-13: case styles', () => {
  it('TK-11 camelCase and PascalCase are cut at the capitals', () => {
    assert.deepEqual(splitIdentifier('userName'), { style: 'camel', words: ['user', 'name'] });
    assert.deepEqual(splitIdentifier('UserName'), { style: 'pascal', words: ['user', 'name'] });
    assert.deepEqual(splitIdentifier('employeeIdNumber').words, ['employee', 'id', 'number']);
  });
  it('TK-11 an acronym stays together', () => {
    assert.deepEqual(splitIdentifier('userID').words, ['user', 'id']);
    assert.deepEqual(splitIdentifier('HTMLParser').words, ['html', 'parser']);
  });
  it('TK-12 snake_case', () => {
    assert.deepEqual(splitIdentifier('user_name'), { style: 'snake', words: ['user', 'name'] });
    assert.deepEqual(splitIdentifier('__first_name_').words, ['first', 'name']);
  });
  it('TK-13 kebab-case', () => assert.deepEqual(splitIdentifier('user-name'), { style: 'kebab', words: ['user', 'name'] }));
  it('every style of one name reads as the same words', () => {
    for (const text of ['userName', 'UserName', 'user_name', 'user-name', 'User Name', 'USER NAME']) assert.equal(spaced(text), 'user name', text);
  });
  it('a single word, an empty text and digits are not cut wrongly', () => {
    assert.deepEqual(splitIdentifier('username'), { style: 'plain', words: ['username'] });
    assert.deepEqual(splitIdentifier(''), { style: 'plain', words: [] });
    assert.deepEqual(splitIdentifier('address2'), { style: 'plain', words: ['address2'] });
  });
});

describe('golden set: the real sentences of the project', () => {
  const rows = sentences.map((s) => {
    const n = normalize(s);
    return { sentence: s, normalized: n.text, tokens: tokenize(n).map((t) => `${t.kind}:${t.text}`) };
  });
  it('has at least 200 real sentences', () => assert.ok(sentences.length >= 200, `${sentences.length}`));
  it('every sentence gives the approved tokens', () => {
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${JSON.stringify(rows, null, 2)}\n`);
    const approved = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(rows, approved);
  });
  it('is deterministic: two runs give byte-identical output (GV-05)', () => {
    const again = sentences.map((s) => {
      const n = normalize(s);
      return { sentence: s, normalized: n.text, tokens: tokenize(n).map((t) => `${t.kind}:${t.text}`) };
    });
    assert.equal(JSON.stringify(again), JSON.stringify(rows));
    const a = sentences.map((s) => JSON.stringify(normalize(s)));
    const b = sentences.map((s) => JSON.stringify(normalize(s)));
    assert.deepEqual(a, b);
  });
});
