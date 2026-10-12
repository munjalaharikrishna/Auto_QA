import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUILTIN_PATTERNS, PatternError, PatternSet, patterns } from './index.js';

const make = (name: string, priority: number, source: string) => ({
  name,
  req: 'RX-99',
  version: '1.0.0',
  priority,
  source,
  flags: '',
  examples: { match: [], noMatch: [] },
});

describe('pattern suite (RX-24)', () => {
  // The examples test what a pattern matches, not how fast: a generous limit keeps a busy machine from failing them.
  const patientSet = new PatternSet(BUILTIN_PATTERNS, { limitMs: 2000 });
  for (const def of BUILTIN_PATTERNS) {
    it(`${def.req} ${def.name}: every example behaves`, () => {
      const set = patientSet;
      assert.ok(def.examples.match.length >= 5, `${def.name} needs at least 5 matching examples`);
      assert.ok(def.examples.noMatch.length >= 5, `${def.name} needs at least 5 non-matching examples`);
      for (const [text, first] of def.examples.match) {
        const found = set.scan(text, [def.name], { resolve: false });
        assert.equal(found.timeouts.length, 0, `${def.name} timed out on ${JSON.stringify(text)}`);
        assert.equal(found.matches[0]?.text, first, `${def.name} on ${JSON.stringify(text)}`);
      }
      for (const text of def.examples.noMatch) {
        const found = set.scan(text, [def.name], { resolve: false });
        assert.deepEqual(
          found.matches.map((m) => m.text),
          [],
          `${def.name} must not match ${JSON.stringify(text)}`,
        );
      }
    });
  }
  it('every pattern has a version and a requirement, and the names are unique', () => {
    const names = new Set<string>();
    for (const def of BUILTIN_PATTERNS) {
      assert.equal(def.version.split('.').length, 3);
      assert.ok(def.req);
      assert.ok(!names.has(def.name), def.name);
      names.add(def.name);
    }
    assert.deepEqual(Object.keys(patterns().versions).sort(), [...names].sort());
  });
  it('covers RX-02 to RX-09 and RX-12 to RX-20 (RX-10 and RX-11 come later)', () => {
    const reqs = new Set(BUILTIN_PATTERNS.map((d) => d.req));
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19, 20]) assert.ok(reqs.has(`RX-${String(n).padStart(2, '0')}`), `RX-${n}`);
  });
});

describe('invalid pattern detection (RX-22)', () => {
  it('a broken pattern stops loading and the error names it', () => {
    assert.throws(
      () => new PatternSet([make('brokenOne', 1, '(unclosed')]),
      (e: unknown) => e instanceof PatternError && e.pattern === 'brokenOne' && e.message.includes('brokenOne'),
    );
  });
  it('a name used twice is refused', () => {
    const one = make('same', 1, 'a');
    assert.throws(() => new PatternSet([one, one]), /used twice/);
  });
  it('asking for a pattern that does not exist names it', () => {
    assert.throws(() => patterns().scan('x', ['nope']), /"nope"/);
  });
});

describe('regex safety and timeouts (RX-21)', () => {
  it('a catastrophic pattern on a 10 kB string is stopped at the limit and reported, and the others still answer', () => {
    const set = new PatternSet([make('evil', 1, '(a+)+$'), make('fine', 1, 'b+')], { limitMs: 50 });
    const text = `${'a'.repeat(10_000)}!bbb`;
    const started = Date.now();
    const result = set.scan(text);
    const took = Date.now() - started;
    assert.deepEqual(result.timeouts, [{ pattern: 'evil', limitMs: 50, inputLength: text.length }]);
    assert.deepEqual(
      result.matches.map((m) => m.text),
      ['bbb'],
    );
    assert.ok(took < 1500, `took ${took} ms`);
  });
  it('the set keeps working after a timeout', () => {
    const set = new PatternSet([make('evil', 1, '(a+)+$')], { limitMs: 50 });
    assert.equal(set.scan(`${'a'.repeat(5000)}!`).timeouts.length, 1);
    assert.equal(set.scan('aaa').matches[0]?.text, 'aaa');
  });
});

describe('priority and conflicts (RX-23)', () => {
  it('the higher priority wins and the conflict is listed', () => {
    const set = new PatternSet([make('low', 1, '\\d+'), make('high', 9, '\\d+')]);
    const r = set.scan('code 123');
    assert.deepEqual(
      r.matches.map((m) => m.pattern),
      ['high'],
    );
    assert.deepEqual(r.conflicts, [{ winner: { pattern: 'high', start: 5, end: 8 }, loser: { pattern: 'low', start: 5, end: 8 } }]);
  });
  it('the result does not depend on the order patterns are given', () => {
    const a = new PatternSet([make('x', 5, 'ab+'), make('y', 5, 'b+c')]).scan('abbbc');
    const b = new PatternSet([make('y', 5, 'b+c'), make('x', 5, 'ab+')]).scan('abbbc');
    assert.deepEqual(a, b);
  });
  it('a date beats the numbers inside it, and an email beats its words', () => {
    const r = patterns().scan('Born 21/02/2024, mail a@b.com', ['date', 'number', 'email', 'word']);
    assert.deepEqual(
      r.matches.filter((m) => m.pattern !== 'word').map((m) => `${m.pattern}:${m.text}`),
      ['date:21/02/2024', 'email:a@b.com'],
    );
  });
});
