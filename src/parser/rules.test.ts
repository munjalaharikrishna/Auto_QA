import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reviewGroups } from '../server/review-groups.js';
import { withRules } from './config.js';
import { defaultParserConfig, parseTestCase } from './index.js';
import { applyWording, ruleKey, rulesFor } from './rules.js';

describe('project rules (FR-RULE)', () => {
  const rules = rulesFor([
    { kind: 'step', pattern: '"Sign me in"', meaning: 'Click the Login button', enabled: true },
    { kind: 'check', pattern: 'It Works Fine.', meaning: 'Dashboard heading is displayed', enabled: true },
    { kind: 'element', pattern: 'Account', meaning: 'Login Name', enabled: true },
    { kind: 'step', pattern: 'switched off', meaning: 'Click Login', enabled: false },
    { kind: 'approved', pattern: 'S3: something', meaning: '', enabled: true },
  ]);

  it('compares wording without case, quotes, spaces or a final full stop', () => {
    assert.equal(ruleKey('  “Sign   me IN”. '), 'sign me in');
    assert.deepEqual(applyWording('SIGN ME IN', rules.step), { text: 'Click the Login button', rule: { from: 'SIGN ME IN', to: 'Click the Login button' } });
    assert.deepEqual(applyWording('Click Login', rules.step), { text: 'Click Login' });
  });

  it('uses only the rules that are on, and none of the accepted values', () => {
    assert.deepEqual(Object.keys(rules.step), ['sign me in']);
    assert.deepEqual(rules.element, { account: 'Login Name' });
  });

  it('reads a step the way the project explained it, and says so', () => {
    const config = withRules(defaultParserConfig(), rules);
    const m = parseTestCase({ title: 'T', steps: '1. Open Login page\n2. Sign me in', expected: 'It works fine' }, config);
    assert.deepEqual(
      m.steps.map((s) => [s.action, s.target, s.status]),
      [
        ['navigate', undefined, 'parsed'],
        ['click', 'Login', 'parsed'],
      ],
    );
    assert.equal(m.steps[1].raw, 'Sign me in', "the tester's own wording is kept");
    assert.ok(m.warnings.some((w) => w.code === 'PROJECT_RULE' && w.at === 'S2'));
    assert.ok(m.warnings.some((w) => w.code === 'PROJECT_RULE' && w.at === 'A1'));
    assert.equal(m.assertions[0].status, 'parsed');
    // Without the rule the same wording cannot be read.
    const without = parseTestCase({ title: 'T', steps: '1. Open Login page\n2. Sign me in', expected: 'It works fine' });
    assert.equal(without.steps[1].status, 'unparsed');
  });
});

describe('grouped review (FR-RV-09, FR-RV-10)', () => {
  const reason = (id: string, raw: string) => ({
    id,
    raw,
    headline: `I cannot tell what to do in "${raw}".`,
    why: 'No action word.',
    todo: ['Start with an action word.'],
  });
  const row = (testId: string, review: ReturnType<typeof reason>[], assumptions: string[] = []) => ({
    testId,
    status: 'NEEDS REVIEW',
    verdict: { review, assumptions },
  });

  it('groups the same wording across test cases and ignores case', () => {
    const g = reviewGroups(
      [
        row('TC-1', [reason('S3', 'Do the needful')]),
        row('TC-2', [reason('S4', 'do the needful.'), reason('A1', 'It works')]),
        row('TC-3', [reason('S2', 'Do the needful')]),
      ],
      new Set(),
    );
    assert.deepEqual(
      g.questions.map((q) => [q.kind, q.raw, q.cases.length]),
      [
        ['step', 'Do the needful', 3],
        ['check', 'It works', 1],
      ],
    );
  });

  it('lists learned values once for all the test cases, and not again once approved', () => {
    const text = 'the error message "Invalid credentials" was learned from the application.';
    const rows = [row('TC-2', [], [`A2: ${text}`]), row('TC-3', [], [`A2: ${text}`]), row('TC-4', [], ['S3: "x" was made up'])];
    const g = reviewGroups(rows, new Set());
    assert.deepEqual(
      g.assumptions.map((a) => [a.text, a.testIds]),
      [
        [text, ['TC-2', 'TC-3']],
        ['"x" was made up', ['TC-4']],
      ],
    );
    assert.deepEqual(
      reviewGroups(rows, new Set([ruleKey(text)])).assumptions.map((a) => a.text),
      ['"x" was made up'],
    );
  });
});
