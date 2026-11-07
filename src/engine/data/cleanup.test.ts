import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { StepRecord } from '../execute/executor.js';
import { compileCase } from '../pipeline/compile.js';
import { type CleanupList, cleanupText, createdBy, writeCleanupList } from './cleanup.js';

/** E0.16 item 4 (audit P3, PD-15): unique names for created records, and a clean-up list per run. Nothing is deleted. */

const ADD = {
  id: 'TC_ADD',
  title: 'Add an employee',
  steps: [
    'Open the Add Employee page',
    'Enter valid First name in First name text box',
    'Enter valid Last name in Last name text box',
    'Enter password in Password field',
    'Click on Save',
  ].join('\n'),
  testData: 'Password: S3cret!pass',
  expected: 'User should see the added employee in the employee list',
};

const trace = (steps: Record<string, StepRecord['status']>): { steps: StepRecord[] } => ({
  steps: Object.entries(steps).map(([step, status]) => ({
    step,
    action: 'CLICK',
    original: step,
    status,
    calls: [],
    changes: [],
    dialogs: [],
    checksAfter: [],
    notes: [],
  })),
});

describe('clean-up list', () => {
  it('lists the record whose Save the run reached, with the values it was saved with', async () => {
    const compiled = await compileCase(ADD, { run: 'run-A' });
    assert.ok(compiled.ir);
    const records = createdBy(compiled.ir, compiled.values, trace({ S1: 'done', S2: 'done', S3: 'done', S4: 'done', S5: 'done' }));
    assert.equal(records.length, 1);
    const [r] = records;
    assert.equal(r?.entity, 'Employee');
    assert.equal(r?.kind, 'created');
    assert.equal(r?.status, 'saved');
    assert.equal(r?.savedBy, 'S5');
    assert.deepEqual(
      r?.values.map((v) => v.field),
      ['First name', 'Last name', 'Password'],
    );
    // The made-up names are the run's values, not data keys; a secret is never written.
    assert.ok(r?.values.slice(0, 2).every((v) => !v.value.startsWith('$') && v.value.length > 0));
    assert.equal(r?.values[2]?.value, '***');
  });

  it('a Save the run never reached created nothing; one it stopped on may have', async () => {
    const compiled = await compileCase(ADD, { run: 'run-A' });
    assert.ok(compiled.ir);
    assert.deepEqual(createdBy(compiled.ir, compiled.values, trace({ S1: 'done', S2: 'done', S3: 'failed' })), []);
    assert.deepEqual(createdBy(compiled.ir, compiled.values, trace({ S1: 'done', S5: 'skipped' })), []);
    assert.equal(createdBy(compiled.ir, compiled.values, trace({ S1: 'done', S5: 'failed' }))[0]?.status, 'maybe');
  });

  it('each run gives the records names of its own; the same seed gives the same names again', async () => {
    const names = async (run: string) => {
      const c = await compileCase(ADD, { run });
      assert.ok(c.ir);
      return createdBy(c.ir, c.values, trace({ S5: 'done' }))[0]
        ?.values.slice(0, 2)
        .map((v) => v.value);
    };
    const a = await names('run-A');
    assert.notDeepEqual(a, await names('run-B'));
    assert.deepEqual(a, await names('run-A'));
  });

  it('is written next to the run, as JSON and as text, and says that nothing was deleted', async () => {
    const compiled = await compileCase(ADD, { run: 'run-A' });
    assert.ok(compiled.ir);
    const list: CleanupList = {
      executionId: 'EXEC-0001',
      seed: 'run-A',
      createdAt: '2026-11-05T10:00:00.000Z',
      deletes: false,
      records: createdBy(compiled.ir, compiled.values, trace({ S5: 'done' })),
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-cleanup-'));
    try {
      const file = await writeCleanupList(dir, list);
      const json = JSON.parse(await readFile(file, 'utf8')) as CleanupList;
      assert.equal(json.deletes, false);
      assert.equal(json.records.length, 1);
      const text = await readFile(path.join(dir, 'cleanup.txt'), 'utf8');
      assert.ok(text.includes('Auto QA deleted nothing'));
      assert.ok(text.includes('TC_ADD D1: created an employee on "Add Employee", saved by S5'));
      assert.ok(!text.includes('S3cret!pass') && !JSON.stringify(json).includes('S3cret!pass'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an empty run says it created nothing', () => {
    assert.ok(cleanupText({ executionId: 'EXEC-2', seed: 's', createdAt: 'now', deletes: false, records: [] }).includes('This run created no records'));
  });
});
