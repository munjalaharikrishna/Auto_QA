import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AnswerKeySchema } from '../engine/governance/index.js';
import type { TestVerdict } from '../results/verdict.js';
import { type KpiBaseline, KpiBaselineSchema, runGateProblems, runKpiOf } from './kpi.js';

/**
 * E0.19 step 6: the gate reads saved live runs. A wrong PASS against the answer key blocks, draft or not; the owner's 80% minimum of
 * fewer questions blocks only once the minimum engine is declared, and can be waived only out loud.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseline: KpiBaseline = {
  version: 't',
  frozenOn: '2026-11-08',
  modules: {
    shop: { label: 'Shop', workbook: 's.xlsx', engine: 'legacy', testCases: 2, steps: 10, caseIds: ['T1', 'T2'], setAside: 2, questions: 10, statuses: {} },
  },
};
const key = AnswerKeySchema.parse({
  checkedBy: 'draft',
  checkedOn: '2026-11-08',
  cases: [
    { id: 'T1', module: 'shop', expected: 'NEEDS_REVIEW' },
    { id: 'T2', module: 'shop', expected: 'PASS' },
  ],
});
const verdict = (testId: string, status: string): { testId: string; status: string; verdict: TestVerdict } => ({
  testId,
  status,
  verdict: {
    executionId: 'E',
    testId,
    title: testId,
    automationId: testId,
    status,
    reason: status === 'NEEDS REVIEW' ? 'E1 "x" is unproven' : '',
    review: status === 'NEEDS REVIEW' ? [{ id: 'E1', raw: 'x is shown', headline: '', why: 'unproven', todo: [] }] : [],
    expected: 'x',
    actual: 'y',
    steps: [{ id: 'S1', raw: 'Open', result: 'passed' }],
    checks: [],
    durationMs: 1,
    evidence: { screenshots: [] },
  } as TestVerdict,
});

describe('the gate on saved live runs (E0.19 step 6)', () => {
  it('a wrong PASS blocks, before and after the declaration, and against a draft key too', () => {
    const k = runKpiOf({ run: 'r', rows: [verdict('T1', 'PASS'), verdict('T2', 'PASS')], baseline, key });
    for (const declared of [false, true]) {
      const problems = runGateProblems([k], { declared, minimum: 0.8, draftKey: true });
      assert.ok(problems.some((p) => p.what === 'wrong PASS on T1 against the answer key (draft)'));
    }
  });

  it('below the minimum is shown, not blocked, until the minimum engine is declared; then it blocks unless waived', () => {
    const k = runKpiOf({ run: 'r', rows: [verdict('T1', 'NEEDS REVIEW'), verdict('T2', 'PASS')], baseline, key });
    assert.equal(k.vsBaseline?.questions.reduction, 0.9);
    assert.deepEqual(runGateProblems([k], { declared: true, minimum: 0.8 }), []);
    assert.equal(runGateProblems([k], { declared: true, minimum: 0.95 }).length, 1);
    assert.deepEqual(runGateProblems([k], { declared: false, minimum: 0.95 }), []);
    assert.deepEqual(runGateProblems([k], { declared: true, minimum: 0.95, waived: true }), []);
  });

  it('declared with no saved run to measure on blocks', () => {
    assert.equal(runGateProblems([], { declared: true, minimum: 0.8 }).length, 1);
  });

  it('the saved live runs of the repository have no wrong PASS against the answer key', () => {
    const kb = KpiBaselineSchema.parse(JSON.parse(readFileSync(path.join(root, 'test/baseline/kpi-baseline.json'), 'utf8')));
    const answers = AnswerKeySchema.parse(JSON.parse(readFileSync(path.join(root, 'test/benchmark/orangehrm.answer-key.json'), 'utf8')));
    const dir = path.join(root, 'test/baseline/runs');
    const kpis = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const data = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { verdicts: Record<string, TestVerdict> };
        return runKpiOf({
          run: f,
          rows: Object.values(data.verdicts).map((v) => ({ testId: v.testId, status: v.status, verdict: v })),
          baseline: kb,
          key: answers,
        });
      });
    assert.ok(kpis.length >= 2);
    assert.deepEqual(runGateProblems(kpis, { declared: false, minimum: 0.8, draftKey: true }), []);
  });
});
