import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compileCase } from '../index.js';
import { knowledgeFromRuns } from './from-runs.js';

/** D1: the application's own words reach understanding. */

const item = (role: string, name: string, page = 'PimPage') => ({
  id: 'S1',
  kind: 'step',
  raw: '',
  phase: 'test',
  status: 'done',
  warnings: [],
  element: { role, name },
  page: { name: page, path: '/x', title: 't' },
});

describe('D1: the application vocabulary from runs and rules', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-kb-'));
    await mkdir(path.join(dir, 'TC1'));
    await writeFile(
      path.join(dir, 'TC1', 'exploration.json'),
      JSON.stringify({
        baseUrl: 'http://app.test/x',
        items: [item('textbox', 'Code'), item('button', 'Save'), item('textbox', 'Other app field')],
        status: 'complete',
      }),
    );
    await mkdir(path.join(dir, 'TC2'));
    await writeFile(path.join(dir, 'TC2', 'exploration.json'), JSON.stringify({ baseUrl: 'http://other.test/', items: [item('button', 'Foreign')] }));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('lists the elements the explorations saw, with the class their role gives, and only this application', async () => {
    const kb = await knowledgeFromRuns('app', 'http://app.test/', dir, [{ word: 'employee id', means: 'Code' }]);
    const comps = kb?.pages.flatMap((p) => p.components) ?? [];
    assert.deepEqual(comps.map((c) => [c.name, c.ontology]).sort(), [
      ['Code', 'Field'],
      ['Other app field', 'Field'],
      ['Save', 'Button'],
    ]);
    assert.deepEqual(comps.find((c) => c.name === 'Code')?.aliases, ['employee id']);
  });

  it('lists an element once when two explorations name its page differently, so it is never "more than one component"', async () => {
    await mkdir(path.join(dir, 'TC3'), { recursive: true });
    await writeFile(
      path.join(dir, 'TC3', 'exploration.json'),
      JSON.stringify({ baseUrl: 'http://app.test/x', items: [item('button', 'Save', 'OtherNameForThePage')], status: 'complete' }),
    );
    const kb = await knowledgeFromRuns('app', 'http://app.test/', dir);
    assert.equal(kb?.pages.flatMap((p) => p.components).filter((c) => c.name === 'Save').length, 1);
    const c = await compileCase(
      { id: 'T', title: 'T', steps: '1. Open the Add Employee page\n2. Click the Save button', expected: 'The Save button is displayed' },
      { env: {}, knowledge: kb },
    );
    assert.equal(c.status, 'compiled', JSON.stringify(c.issues.map((i) => i.message)));
  });

  it('reads "Employee ID" as the field the application calls Code', async () => {
    const kb = await knowledgeFromRuns('app', 'http://app.test/', dir, [{ word: 'employee id', means: 'Code' }]);
    const raw = {
      id: 'T',
      title: 'T',
      steps: '1. Open the Add Employee page\n2. Enter Employee ID',
      expected: 'The Save button is displayed',
      testData: 'Employee ID: 7',
    };
    const without = await compileCase(raw, { env: {} });
    const withKb = await compileCase(raw, { env: {}, knowledge: kb });
    assert.equal(without.ir?.steps[1]?.target?.component, undefined);
    assert.equal(withKb.ir?.steps[1]?.target?.name, 'Employee ID', 'the words of the tester are kept');
    assert.equal(withKb.ir?.steps[1]?.target?.component, 'Code');
    assert.equal(withKb.ir?.expectations[0]?.condition.target?.ontology, 'Button');
    assert.ok(withKb.log.some((l) => l.message.includes('"Employee ID" is the component "Code"')));
  });
});
