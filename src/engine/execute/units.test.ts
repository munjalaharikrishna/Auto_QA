import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { RawTestCase } from '../../model/test-model.js';
import { compileCase } from '../pipeline/compile.js';
import { diff } from './delta.js';
import { observed } from './observe.js';
import { planActions } from './planner.js';

/** E0.7 tests that need no browser: waits never sleep (UI-09), the grammar of waits and rows, and the before/after diff. */

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : p.endsWith('.ts') ? [p] : [];
  });

const compile = async (steps: string[]) => {
  const raw: RawTestCase = { id: 'T', title: 't', steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), expected: 'The Controls heading is displayed' };
  const c = await compileCase(raw, { env: {} });
  assert.ok(c.ir && c.plan, `it compiles: ${JSON.stringify(c.issues.filter((i) => i.severity === 'blocking'))}`);
  return planActions(c.ir, c.plan);
};

describe('UI-09: nothing in the engine sleeps', () => {
  it('has no timer, no fixed wait and no timed MCP wait outside the tests', () => {
    // The words are built from parts so that this file does not match itself.
    const banned = ['set' + 'Timeout', 'set' + 'Interval', 'waitFor' + 'Timeout', 'sle' + 'ep(', 'del' + 'ay(', 'ti' + 'me:'];
    const found: string[] = [];
    for (const f of filesUnder(path.join(process.cwd(), 'src', 'engine'))) {
      if (f.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const b of banned) if (text.includes(b) && (b !== 'ti' + 'me:' || f.includes('execute'))) found.push(`${path.relative(process.cwd(), f)}: ${b}`);
    }
    assert.deepEqual(found, []);
  });
});

describe('waits and rows in the grammar', () => {
  it('turns "Wait 5 seconds" into a WAIT of 5000 ms, and a bare wait into an idle wait', async () => {
    const plan = await compile(['Open http://localhost:3000/x', 'Wait 5 seconds', 'Wait']);
    assert.deepEqual(
      plan.chains.map((c) => c.action),
      ['NAVIGATE', 'WAIT', 'WAIT'],
    );
    assert.equal(plan.chains[1]?.value, '5000');
    assert.equal(plan.chains[2]?.value, undefined);
  });
  it('reads "Click Edit for John Smith" as the Edit of the row that holds John Smith', async () => {
    const plan = await compile(['Open http://localhost:3000/x', 'Click Edit for John Smith']);
    assert.deepEqual(plan.chains[1]?.target?.row, ['John Smith']);
    assert.equal(plan.chains[1]?.target?.name, 'Edit');
    assert.ok(plan.chains[1]?.ops.some((o) => o.op === 'find-row'));
  });
  it('keeps the row of "in the row for X", "of the row with X" and "in the X row", which used to be dropped (E6)', async () => {
    for (const [line, action] of [
      ['Click Edit in the row for John Smith', 'CLICK'],
      ['Click the Edit button in the row of John Smith', 'CLICK'],
      ['Check the checkbox in the row for John Smith', 'CHECK'],
      ['Select the checkbox in the John Smith row', 'CHECK'],
    ] as const) {
      const plan = await compile(['Open http://localhost:3000/x', line]);
      assert.equal(plan.chains[1]?.action, action, line);
      assert.deepEqual(plan.chains[1]?.target?.row?.map((r) => r.toLowerCase()), ['john smith'], line);
    }
  });
});

describe('EX-05: the diff', () => {
  const link = { id: 'a', role: 'link', ariaName: 'Home', text: 'Home', labels: [], placeholder: '', nameAttr: '', visible: true, xpath: '/a' } as never;
  it('is empty when nothing changed, and lists what appeared, went and moved', () => {
    const a = observed('http://x/a', 'A', ['One', 'Two'], [link]);
    assert.deepEqual(diff(a, a).textAdded, []);
    const b = observed('http://x/b', 'B', ['Two', 'Three'], []);
    const d = diff(a, b);
    assert.deepEqual(d.url, { from: 'http://x/a', to: 'http://x/b' });
    assert.deepEqual(d.title, { from: 'A', to: 'B' });
    assert.deepEqual(d.textAdded, ['Three']);
    assert.deepEqual(d.textRemoved, ['One']);
    assert.deepEqual(d.disappeared, ['link "Home"']);
  });
});
