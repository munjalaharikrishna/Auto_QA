// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the text of a test step or a variable token contains a literal ${…}, which is what is being tested
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * RX-01, the isolation policy: regular expressions live only in `src/engine/patterns/`. This reads every file of
 * `src/engine/` with a small lexer that skips comments, strings and template text (so a sentence that looks like a
 * regex is not one) and tells a regex literal from a division by the token before the slash. It fails on a regex
 * literal, on `RegExp`, and on `.match(` / `.matchAll(` / `.search(`, which turn a string into one.
 */

const ENGINE = fileURLToPath(new URL('../', import.meta.url));
const ISOLATED = `${join(ENGINE, 'patterns')}${sep}`;

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return name.endsWith('.ts') ? [path] : [];
  });

/** After one of these a `/` starts a regular expression; after anything else (a name, a number, `)` or `]`) it divides. */
const REGEX_AFTER_PUNCT = new Set([...'(,=:[!&|?{;+-*%<>~^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'of', 'in', 'instanceof', 'void', 'delete', 'throw', 'new', 'else', 'do', 'yield', 'await']);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

export function regexUses(source: string): string[] {
  const found: string[] = [];
  let code = '';
  let line = 1;
  let i = 0;
  let last = ''; // the previous significant token: a punctuation character or a word
  const stack: Array<{ kind: 'template' } | { kind: 'expr'; depth: number }> = [];
  const keep = (text: string): void => {
    code += text;
  };
  const advance = (n: number, blank: boolean): void => {
    for (let k = 0; k < n; k++) {
      const c = source[i + k] as string;
      if (c === '\n') line++;
      keep(blank && c !== '\n' ? ' ' : c);
    }
    i += n;
  };
  while (i < source.length) {
    const c = source[i] as string;
    const top = stack[stack.length - 1];
    if (top?.kind === 'template') {
      if (c === '\\') advance(2, true);
      else if (c === '`') {
        advance(1, true);
        stack.pop();
        last = '"';
      } else if (c === '$' && source[i + 1] === '{') {
        advance(2, true);
        stack.push({ kind: 'expr', depth: 0 });
        last = '(';
      } else advance(1, true);
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance(1, true);
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      advance((end < 0 ? source.length : end + 2) - i, true);
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      advance(j + 1 - i, true);
      last = '"';
    } else if (c === '`') {
      advance(1, true);
      stack.push({ kind: 'template' });
    } else if (c === '/') {
      const regexHere = last === '' || REGEX_AFTER_PUNCT.has(last) || REGEX_AFTER_WORD.has(last);
      if (regexHere) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
          if (source[j] === '\\') j++;
          else if (source[j] === '[') inClass = true;
          else if (source[j] === ']') inClass = false;
          j++;
        }
        let end = j + 1;
        while (end < source.length && /[a-z]/.test(source[end] as string)) end++;
        found.push(`line ${line}: regex literal ${source.slice(i, end)}`);
        advance(end - i, true);
        last = '"';
      } else {
        advance(1, false);
        last = '/';
      }
    } else if (isWordChar(c)) {
      let j = i;
      while (j < source.length && isWordChar(source[j] as string)) j++;
      last = source.slice(i, j);
      advance(j - i, false);
    } else {
      if (top?.kind === 'expr') {
        if (c === '{') top.depth++;
        else if (c === '}') {
          if (top.depth === 0) {
            advance(1, true);
            stack.pop();
            continue;
          }
          top.depth--;
        }
      }
      if (c.trim()) last = c;
      advance(1, false);
    }
  }
  // What is left of the code once comments, strings and regex literals are blanked.
  let n = 1;
  for (const row of code.split('\n')) {
    if (/\bRegExp\b/.test(row)) found.push(`line ${n}: RegExp`);
    for (const m of row.matchAll(/\.(match|matchAll|search)\s*\(/g)) found.push(`line ${n}: .${m[1]}(…)`);
    n++;
  }
  return found;
}

describe('regex isolation (RX-01)', () => {
  it('no regular expression outside src/engine/patterns/', () => {
    const files = filesUnder(ENGINE).filter((f) => !f.startsWith(ISOLATED));
    assert.ok(files.length >= 15, `scanned only ${files.length} files`);
    const problems = files.flatMap((f) => regexUses(readFileSync(f, 'utf8')).map((u) => `${relative(ENGINE, f)} ${u}`));
    assert.deepEqual(problems, []);
  });
  it('the scan really sees a regex, a RegExp and a string match, and ignores comments and strings', () => {
    assert.deepEqual(regexUses('const a = /x+/g;'), ['line 1: regex literal /x+/g']);
    assert.deepEqual(regexUses('const a = s.split(/[/]+/);'), ['line 1: regex literal /[/]+/']);
    assert.deepEqual(regexUses('const b = new RegExp("x");'), ['line 1: RegExp']);
    assert.deepEqual(regexUses('"a".match("a");'), ['line 1: .match(…)']);
    assert.deepEqual(regexUses('x = [/a/, /b/];'), ['line 1: regex literal /a/', 'line 1: regex literal /b/']);
    assert.deepEqual(regexUses('// /x+/ and RegExp\nconst s = "/y+/ .match(";\nconst d = 4 / 2 / 1;\nconst e = (a) / 2;'), []);
    assert.deepEqual(regexUses('const t = `a /b+/ ${x / 2} c`;'), []);
    assert.deepEqual(regexUses('const t = `${s.replace(/q/g, "")}`;'), ['line 1: regex literal /q/g']);
  });
  it('the patterns folder does hold regular expressions, so the scan has something to protect', () => {
    const inside = filesUnder(ISOLATED)
      .filter((f) => !f.endsWith('.test.ts'))
      .flatMap((f) => regexUses(readFileSync(f, 'utf8')));
    assert.ok(inside.length > 20, `${inside.length}`);
  });
});
