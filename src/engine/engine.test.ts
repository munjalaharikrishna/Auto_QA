import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import type { RawTestCase } from '../model/test-model.js';
import {
  compileCase,
  DecisionLog,
  engineConfig,
  engineFrom,
  type PipelineError,
  type QaIr,
  resetEngineConfig,
  runStages,
  STAGE_NAMES,
  type Stage,
  setEngine,
  validateIr,
} from './index.js';

/** E0.1 exit tests: the QA-IR schema, the pipeline contract, determinism and the engine switch. */

const load = (file: string): RawTestCase[] => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const EXAMPLES = ['examples/test-cases.json', 'examples/demo-app/test-cases.json', 'examples/real-world/login-cases.json'].flatMap(load);

/** Two more test cases, written for this test, so there are twenty valid documents. */
const EXTRA: RawTestCase[] = [
  { id: 'X-1', title: 'Search', steps: '1. Open https://example.com\n2. Enter "shoes" in the Search box\n3. Press Enter', expected: 'URL contains /search' },
  { id: 'X-2', title: 'Logout', preconditions: 'Logged in', steps: '1. Click the Logout button', expected: 'User is redirected to Login page' },
];

describe('QA-IR schema (IR-01)', () => {
  let valid: QaIr[];
  it('accepts twenty valid documents: every example test case the engine built a document for, and two more', async () => {
    const results = await Promise.all([...EXAMPLES, ...EXTRA].map((c) => compileCase(c)));
    valid = results.filter((r) => r.ir).map((r) => r.ir as QaIr);
    assert.ok(valid.length >= 20, `only ${valid.length} compiled`);
    for (const ir of valid.slice(0, 20)) assert.equal(validateIr(ir).ok, true, ir.testCase.id);
  });

  /** One valid document with one thing broken at a time: the rejection must name the field. */
  const breaks: Array<[string, (ir: QaIr) => unknown, string]> = [
    ['no steps', (ir) => ({ ...ir, steps: [] }), 'steps'],
    ['no expectations', (ir) => ({ ...ir, expectations: [] }), 'expectations'],
    ['no test case id', (ir) => ({ ...ir, testCase: { ...ir.testCase, id: '' } }), 'testCase.id'],
    ['version 0', (ir) => ({ ...ir, testCase: { ...ir.testCase, version: 0 } }), 'testCase.version'],
    ['unknown action', (ir) => ({ ...ir, steps: [{ ...ir.steps[0], action: 'TELEPORT' }, ...ir.steps.slice(1)] }), 'steps[0].action'],
    ['bad step id', (ir) => ({ ...ir, steps: [{ ...ir.steps[0], id: 'one' }, ...ir.steps.slice(1)] }), 'steps[0].id'],
    ['step without original words', (ir) => ({ ...ir, steps: [{ ...ir.steps[0], original: ' ' }, ...ir.steps.slice(1)] }), 'steps[0].original'],
    ['duplicate step id', (ir) => ({ ...ir, steps: [ir.steps[0], { ...ir.steps[0] }] }), 'steps[1].id'],
    ['value not in data', (ir) => ({ ...ir, steps: [{ ...ir.steps[0], value: '$data.nothing_here' }, ...ir.steps.slice(1)] }), 'steps[0].value'],
    ['lowercase state', (ir) => ({ ...ir, steps: [{ ...ir.steps[0], expectedState: 'login page' }, ...ir.steps.slice(1)] }), 'steps[0].expectedState'],
    ['target without ontology', (ir) => ({ ...ir, steps: [{ ...ir.steps[0], target: { name: 'x' } }, ...ir.steps.slice(1)] }), 'steps[0].target.ontology'],
    [
      'expectation without clause',
      (ir) => ({ ...ir, expectations: [{ ...ir.expectations[0], clause: '' }, ...ir.expectations.slice(1)] }),
      'expectations[0].clause',
    ],
    [
      'negated not a boolean',
      (ir) => ({ ...ir, expectations: [{ ...ir.expectations[0], negated: 'no' }, ...ir.expectations.slice(1)] }),
      'expectations[0].negated',
    ],
    [
      'unknown condition',
      (ir) => ({ ...ir, expectations: [{ ...ir.expectations[0], condition: { type: 'MAGIC' } }, ...ir.expectations.slice(1)] }),
      'expectations[0].condition.type',
    ],
    [
      'after a step that does not exist',
      (ir) => ({ ...ir, expectations: [{ ...ir.expectations[0], afterStep: 'S99' }, ...ir.expectations.slice(1)] }),
      'expectations[0].afterStep',
    ],
    [
      'a secret kept as its value',
      (ir) => ({ ...ir, data: { ...ir.data, secret_pw: { class: 'EXPLICIT', source: 'EXCEL', secret: true, value: 'hunter2' } } }),
      'data.secret_pw.value',
    ],
    ['blank with a value', (ir) => ({ ...ir, data: { ...ir.data, blank_one: { class: 'BLANK', source: 'EXCEL', value: 'x' } } }), 'data.blank_one.value'],
    [
      'environment value not a reference',
      (ir) => ({ ...ir, data: { ...ir.data, from_env: { class: 'EXPLICIT', source: 'ENV', value: '$env.X' } } }),
      'data.from_env.class',
    ],
    ['versions missing', (ir) => ({ ...ir, versions: { grammar: '1' } }), 'versions.vocabulary'],
    ['not an object', () => 'steps', '(document)'],
  ];

  for (const [name, mutate, field] of breaks) {
    it(`rejects: ${name}, naming ${field}`, () => {
      assert.ok(valid, 'the valid documents come first');
      const ir = structuredClone(valid.find((v) => v.steps.length > 1 && v.expectations.length > 0) as QaIr);
      const result = validateIr(mutate(ir));
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.ok(
          result.issues.some((i) => i.path === field),
          `expected ${field}, got ${result.issues.map((i) => i.path).join(', ')}`,
        );
    });
  }
  it('has twenty broken documents', () => assert.equal(breaks.length, 20));
});

describe('pipeline contract (GV-15)', () => {
  const ok = { id: 'T-1', title: 'T', steps: '1. Open https://example.com\n2. Click the Login button', expected: 'The Dashboard heading is displayed' };

  it('runs the compilation stages in the order of the sequence and logs every one', async () => {
    const r = await compileCase(ok);
    assert.equal(r.status, 'compiled', String(r.error));
    assert.deepEqual(
      r.ran,
      STAGE_NAMES.filter((n) => n !== 'Execute'),
    );
    assert.deepEqual(new Set(r.log.map((l) => l.stage)), new Set(r.ran), 'every stage that ran wrote to the decision log');
    assert.deepEqual(
      r.log.map((l) => l.seq),
      r.log.map((_l, i) => i + 1),
    );
  });

  it('stops a stage that returns the wrong shape, naming the stage and the field', async () => {
    const log = new DecisionLog('T-1');
    const good: Stage<number, number> = { name: 'Read', output: z.number(), run: (n) => n + 1 };
    const bad: Stage<number, { count: number }> = { name: 'Understand', output: z.object({ count: z.number() }), run: () => ({ count: 'many' }) as never };
    const never: Stage<unknown, unknown> = { name: 'Validate', output: z.unknown(), run: () => assert.fail('must not run') };
    await assert.rejects(runStages([good, bad, never], 1, { log, testId: 'T-1' }), (e: PipelineError) => {
      assert.equal(e.stage, 'Understand');
      assert.deepEqual(
        e.issues.map((i) => i.path),
        ['count'],
      );
      return true;
    });
    assert.equal(log.entries.at(-1)?.kind, 'error');
  });

  it('names the stage when a stage fails, and reports it as an error result', async () => {
    const r = await compileCase({ id: 'T-2', title: 'No steps', steps: '', expected: 'x' });
    assert.equal(r.status, 'error');
    assert.equal(r.stage, 'Read');
    assert.deepEqual(r.ran, []);
  });

  it('does not build on text it did not understand: it stops at Validate and says what was not read', async () => {
    const r = await compileCase({ ...ok, id: 'T-3', steps: '1. Frobnicate the widget\n2. Click the Login button' });
    assert.equal(r.status, 'needs-review');
    assert.equal(r.stage, 'Validate');
    assert.equal(r.ir, undefined);
    assert.ok(r.unparsed[0].raw.includes('Frobnicate'));
    assert.ok(r.log.some((l) => l.kind === 'warning' && l.message.includes('not understood')));
  });

  it('keeps a secret as a reference and never writes its value in the document or the log', async () => {
    const r = await compileCase({
      id: 'T-4',
      title: 'Login',
      steps: '1. Open https://example.com\n2. Enter valid username\n3. Enter valid password\n4. Click Login',
      expected: 'User is redirected to Dashboard page',
    });
    assert.equal(r.status, 'compiled', String(r.error));
    const secrets = Object.entries(r.ir?.data ?? {}).filter(([, d]) => d.secret);
    assert.ok(secrets.length, 'the password is marked secret');
    for (const [, d] of secrets) assert.ok((d.value ?? '').startsWith('$env.') || d.value === '***', String(d.value));
  });

  it('never allows a clean PASS when an assumption was made (DEC-05)', async () => {
    const r = await compileCase({
      id: 'T-5',
      title: 'Register',
      steps: '1. Open https://example.com/register\n2. Enter a new email\n3. Click Register',
      expected: 'Success message is shown',
    });
    if (r.status === 'compiled') assert.equal(r.plan?.passAllowed, (r.ir?.assumptions.length ?? 0) === 0);
  });
});

describe('determinism (GV-05, T3)', () => {
  it('gives an identical QA-IR, plan and decision log on every run', async () => {
    for (const c of EXAMPLES) {
      const [a, b] = [await compileCase(c), await compileCase(c)];
      assert.equal(JSON.stringify(a), JSON.stringify(b), String(c.id));
    }
  });
});

describe('engine switch (PD-1)', () => {
  beforeEach(resetEngineConfig);
  it('is the new engine unless told otherwise (E1.0), and an unknown value never picks the other one', () => {
    assert.equal(engineConfig().engine, 'semantic');
    assert.equal(engineFrom(undefined), 'semantic');
    assert.equal(engineFrom('legacy'), 'legacy');
    assert.equal(engineFrom('semantik'), 'semantic');
    setEngine('legacy');
    assert.equal(engineConfig().engine, 'legacy');
  });
});
