import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AnswerKeySchema,
  type BenchmarkResult,
  benchmarkText,
  checkGate,
  type GateBaseline,
  gateText,
  type Measure,
  reviewReduction,
  reviewReductionBy,
  runBenchmark,
} from './index.js';
import { measureWorkbooks } from './measure.js';

/** E0.10 (minimum engine): GV-06 benchmark runner, GV-08 review reduction, GV-09 wrong-PASS KPI, GV-13 protection gate. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const measure = (over: Partial<Measure> = {}): Measure => ({
  testCases: 10,
  ready: 8,
  reviews: 2,
  steps: { understood: 38, total: 40 },
  expectations: { understood: 19, total: 20 },
  ...over,
});
const baseline = (m: Measure = measure()): GateBaseline => ({ version: 'E0.9', modules: { 'login.xlsx': m } });

describe('GV-08: review reduction', () => {
  it('is 1 - current reviews / baseline reviews, and says where it stands against 90% and 80%', () => {
    const r = reviewReduction({ reviews: 20, testCases: 29 }, { reviews: 2, testCases: 29 });
    assert.equal(r.reduction, 0.9);
    assert.ok(r.meetsTarget && r.meetsMinimum);
    const low = reviewReduction({ reviews: 20, testCases: 29 }, { reviews: 5, testCases: 29 });
    assert.equal(low.reduction, 0.75);
    assert.ok(!low.meetsMinimum);
    assert.ok(reviewReduction({ reviews: 20, testCases: 29 }, { reviews: 4, testCases: 29 }).meetsMinimum);
  });
  it('is negative when there are more reviews than before, and not defined when the baseline had none', () => {
    assert.equal(reviewReduction({ reviews: 4, testCases: 10 }, { reviews: 6, testCases: 10 }).reduction, -0.5);
    const none = reviewReduction({ reviews: 0, testCases: 10 }, { reviews: 0, testCases: 10 });
    assert.equal(none.reduction, undefined);
    assert.ok(!none.meetsMinimum && !none.meetsTarget);
  });
  it('is shown for each module and for all of them together', () => {
    const r = reviewReductionBy(
      { a: { reviews: 10, testCases: 10 }, b: { reviews: 10, testCases: 10 } },
      { a: { reviews: 0, testCases: 10 }, b: { reviews: 10, testCases: 10 } },
    );
    assert.equal(r.byGroup.a?.reduction, 1);
    assert.equal(r.byGroup.b?.reduction, 0);
    assert.equal(r.total.reduction, 0.5);
  });
});

describe('GV-06, GV-09: the benchmark and the wrong-PASS KPI', () => {
  const key = AnswerKeySchema.parse({
    checkedBy: 'owner',
    checkedOn: '2026-10-13',
    cases: [
      { id: 'TC_LOGIN_001', module: 'login', expected: 'PASS' },
      { id: 'TC_LOGIN_004', module: 'login', expected: 'FAIL', trap: '5 Oct: a check that cannot fail' },
      { id: 'TC_LOGIN_005', module: 'login', expected: 'NEEDS_REVIEW' },
      { id: 'TC_ADD_001', module: 'add', expected: 'PASS' },
    ],
  });
  const result = (id: string, module: string, verdict: BenchmarkResult['verdict'], source?: BenchmarkResult['source']): BenchmarkResult => ({
    id,
    module,
    verdict,
    ...(source ? { source } : {}),
  });

  it('matches a run with the key: all matched, no wrong PASS, and the build is OK', () => {
    const r = runBenchmark(key, [
      result('TC_LOGIN_001', 'login', 'PASS'),
      result('TC_LOGIN_004', 'login', 'FAIL'),
      result('TC_LOGIN_005', 'login', 'NEEDS_REVIEW'),
      result('TC_ADD_001', 'add', 'PASS'),
    ]);
    assert.equal(r.matched, 4);
    assert.equal(r.wrongPass, 0);
    assert.ok(r.ok);
    assert.deepEqual(r.byModule, { login: { cases: 3, matched: 3, wrongPass: 0 }, add: { cases: 1, matched: 1, wrongPass: 0 } });
  });
  it('a PASS where the key says anything else is a wrong PASS: counted by source, and the build fails', () => {
    const r = runBenchmark(key, [
      result('TC_LOGIN_001', 'login', 'PASS'),
      result('TC_LOGIN_004', 'login', 'PASS', 'assertion'),
      result('TC_LOGIN_005', 'login', 'PASS'),
      result('TC_ADD_001', 'add', 'PASS'),
    ]);
    assert.equal(r.wrongPass, 2);
    assert.equal(r.wrongPassBySource.assertion, 1);
    assert.equal(r.wrongPassBySource.unknown, 1, 'a wrong PASS with no source is counted, not hidden');
    assert.ok(!r.ok);
    const text = benchmarkText(r);
    assert.ok(text.includes('WRONG PASS login/TC_LOGIN_004'), text);
    assert.ok(text.includes('trap: 5 Oct'), text);
  });
  it('a different verdict that is not a PASS is a difference, not a wrong PASS; a case that was not run is listed, not ignored', () => {
    const r = runBenchmark(key, [result('TC_LOGIN_001', 'login', 'NEEDS_REVIEW'), result('TC_LOGIN_004', 'login', 'FAIL'), result('X', 'other', 'PASS')]);
    assert.equal(r.mismatched, 1);
    assert.equal(r.notRun, 2);
    assert.equal(r.wrongPass, 0);
    assert.deepEqual(r.notInKey, ['other/X']);
    assert.ok(r.ok);
  });
  it('rejects a key with the same case twice, no checker, or a verdict that does not exist', () => {
    const base = { checkedBy: 'owner', checkedOn: '2026-10-13' };
    assert.ok(
      !AnswerKeySchema.safeParse({
        ...base,
        cases: [
          { id: 'a', module: 'm', expected: 'PASS' },
          { id: 'a', module: 'm', expected: 'FAIL' },
        ],
      }).success,
    );
    assert.ok(!AnswerKeySchema.safeParse({ checkedOn: 'x', cases: [{ id: 'a', module: 'm', expected: 'PASS' }] }).success);
    assert.ok(!AnswerKeySchema.safeParse({ ...base, cases: [{ id: 'a', module: 'm', expected: 'MAYBE' }] }).success);
  });
});

describe('GV-13: the protection gate', () => {
  it('passes when nothing is worse, and shows what got better without moving the bar', () => {
    const better = measure({ ready: 9, reviews: 1, steps: { understood: 40, total: 40 } });
    const r = checkGate(baseline(), { 'login.xlsx': better });
    assert.ok(r.ok);
    assert.ok(r.improvements.length >= 2);
    assert.ok(gateText(r).includes('--update'));
  });
  it('blocks a change that lowers the understood rate of steps or checks', () => {
    const steps = checkGate(baseline(), { 'login.xlsx': measure({ steps: { understood: 36, total: 40 } }) });
    assert.ok(!steps.ok);
    assert.ok(steps.problems[0]?.what.includes('steps understood went down'), JSON.stringify(steps.problems));
    const checks = checkGate(baseline(), { 'login.xlsx': measure({ expectations: { understood: 15, total: 20 } }) });
    assert.ok(!checks.ok);
    assert.ok(gateText(checks).includes('BLOCKED'));
  });
  it('blocks when a test case that was ready is not any more', () => {
    const r = checkGate(baseline(), { 'login.xlsx': measure({ ready: 7, reviews: 3 }) });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => p.what.includes('ready went down')));
  });
  it('blocks when a measured workbook is missing, and on any wrong PASS in the benchmark', () => {
    assert.ok(!checkGate(baseline(), {}).ok);
    const key = AnswerKeySchema.parse({ checkedBy: 'owner', checkedOn: 'today', cases: [{ id: 'a', module: 'm', expected: 'FAIL' }] });
    const bench = runBenchmark(key, [{ id: 'a', module: 'm', verdict: 'PASS', source: 'locator' }]);
    const r = checkGate(baseline(), { 'login.xlsx': measure() }, bench);
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => p.what.includes('wrong PASS on a') && p.what.includes('locator')));
  });
  it('blocks a review reduction below the owner minimum even when nothing got worse, and passes at it', () => {
    const base = { reviews: 10, testCases: 10 };
    const low = checkGate(baseline(), { 'login.xlsx': measure() }, undefined, { total: reviewReduction(base, { reviews: 9, testCases: 10 }), minimum: 0.8 });
    assert.ok(!low.ok);
    assert.ok(
      low.problems.some((p) => p.what.includes('below the minimum of 80.0%')),
      JSON.stringify(low.problems),
    );
    const met = checkGate(baseline(), { 'login.xlsx': measure() }, undefined, { total: reviewReduction(base, { reviews: 2, testCases: 10 }), minimum: 0.8 });
    assert.ok(met.ok, gateText(met));
  });
  it('a baseline with no reviews cannot show the bar is met, so it blocks', () => {
    const r = checkGate(baseline(), { 'login.xlsx': measure() }, undefined, {
      total: reviewReduction({ reviews: 0, testCases: 10 }, { reviews: 0, testCases: 10 }),
      minimum: 0.8,
    });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => p.what.includes('not defined')));
  });
  it('the numbers recorded in test/baseline/gate.json hold on the real workbooks: a vocabulary or grammar change that makes them worse is blocked', async () => {
    const recorded = JSON.parse(readFileSync(path.join(root, 'test/baseline/gate.json'), 'utf8')) as GateBaseline;
    const now = await measureWorkbooks(['OrangeHRM_Login_Test_Cases_Updated.xlsx', 'Add_Employee.xlsx'].map((f) => path.join(root, 'test/fixtures', f)));
    const r = checkGate(recorded, now);
    assert.ok(r.ok, gateText(r));
  });
  it('measures the same numbers twice (determinism, GV-05)', async () => {
    const files = [path.join(root, 'test/fixtures/OrangeHRM_Login_Test_Cases_Updated.xlsx')];
    assert.deepEqual(await measureWorkbooks(files), await measureWorkbooks(files));
  });
});
