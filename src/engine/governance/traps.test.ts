import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '../../importer/workbook.js';
import type { RawTestCase } from '../../model/test-model.js';
import { AnswerKeySchema } from './benchmark.js';
import { runTrap, TrapFileSchema } from './traps.js';

/** T5: the wrong-PASS traps (test/traps/), read with no browser. They run in every `npm test`. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = TrapFileSchema.parse(JSON.parse(readFileSync(path.join(root, 'test/traps/compile-traps.json'), 'utf8')));

describe('T5: wrong-PASS traps', async () => {
  const books = new Map<string, RawTestCase[]>();
  for (const t of file.traps) {
    if (!('workbook' in t.case) || books.has(t.case.workbook)) continue;
    books.set(
      t.case.workbook,
      (await readWorkbook(path.join(root, 'test/fixtures', t.case.workbook))).cases.map((c) => c.raw),
    );
  }
  const lookup = (workbook: string, id: string) => books.get(workbook)?.find((c) => c.id === id);

  for (const trap of file.traps) {
    it(`${trap.id}: ${trap.origin}`, async () => {
      const outcome = await runTrap(trap, lookup);
      assert.deepEqual(outcome.problems, []);
    });
  }

  it('catches a reading that is wrong (the runner is not blind)', async () => {
    const outcome = await runTrap(
      {
        id: 'x',
        origin: 'x',
        case: { steps: '1. Open the Login page\n2. Click Login', expected: 'Verify the Employee Information is not displayed' },
        expect: { status: ['needs-review'], expectations: [{ type: 'VISIBILITY', negated: false }] },
      },
      lookup,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problems.length, 2);
  });
});

describe('GV-06: the answer key for the real OrangeHRM cases', () => {
  const key = AnswerKeySchema.parse(JSON.parse(readFileSync(path.join(root, 'test/benchmark/orangehrm.answer-key.json'), 'utf8')));

  it('lists every case of both workbooks, once, and no case that is not there', async () => {
    for (const workbook of ['OrangeHRM_Login_Test_Cases_Updated.xlsx', 'Add_Employee.xlsx']) {
      const ids = (await readWorkbook(path.join(root, 'test/fixtures', workbook))).cases.map((c) => c.raw.id).sort();
      assert.deepEqual(
        key.cases
          .filter((c) => c.module === workbook)
          .map((c) => c.id)
          .sort(),
        ids,
        workbook,
      );
    }
    assert.equal(key.cases.length, 29);
  });

  it('is a draft until a person signs it, and the traps of the compile file are in it as traps', () => {
    assert.equal(key.signedOff, false, 'a key nobody ran by hand is never trusted: signing is done by a person, in the file');
    for (const id of ['TC_LOGIN_003', 'TC_LOGIN_004', 'TC_LOGIN_005', 'TC_LOGIN_006', 'TC_LOGIN_007']) assert.ok(key.cases.find((c) => c.id === id)?.trap, id);
  });

  it('says why a case is NEEDS_REVIEW', () => {
    for (const c of key.cases.filter((x) => x.expected === 'NEEDS_REVIEW')) assert.ok(c.note, `${c.module}/${c.id} has no reason`);
  });
});
