import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '../db/store.js';
import { learnedForRun } from './adapter.js';
import { labelConflict, readingConflict } from './conflicts.js';
import type { ReadingPayload } from './entries.js';
import { exampleProblem, readsAs } from './examples.js';
import { EntryRefused, LearningService } from './service.js';

/**
 * E0.18 step 6: learned entries with a worked example and a conflict check. A reading keeps what the engine read its new sentence as;
 * a run sets it aside when the engine reads it otherwise later. An entry that would chain with or undo an active one is refused.
 */

const reading = (from: string, to: string): Pick<ReadingPayload, 'from' | 'to'> => ({ from, to });

describe('E0.18 step 6: readings that would not mean one thing', () => {
  const active = [reading('Click on the sign in', 'Click the Login button')];

  it('a chain is refused: the new sentence is itself rewritten, or the sentence is what another reading produces', () => {
    assert.ok(readingConflict(reading('Press sign in', 'Click on the sign in'), active)?.includes('itself read as'));
    assert.ok(readingConflict(reading('Click the Login button', 'Click Submit'), active)?.includes("that reading's result"));
  });

  it('two readings that undo each other are refused', () => {
    assert.ok(readingConflict(reading('Click the Login button', 'Click on the sign in'), active)?.includes('each other'));
  });

  it('the same sentence again is a replacement, not a conflict; an unrelated reading is fine', () => {
    assert.equal(readingConflict(reading('Click on the sign in', 'Click the Sign in button'), active), undefined);
    assert.equal(readingConflict(reading('Tap Save', 'Click the Save button'), active), undefined);
  });
});

describe('E0.18 step 6: labels that would not mean one thing', () => {
  it('a chain or a cycle in the same place is refused; another screen, or a pick of the same word, is not', () => {
    const active = [{ label: 'sign in', means: 'Login' }];
    assert.ok(labelConflict({ label: 'enter', means: 'sign in' }, active)?.includes('itself a word'));
    assert.ok(labelConflict({ label: 'login', means: 'sign in' }, active)?.includes('each other'));
    assert.equal(labelConflict({ label: 'enter', means: 'sign in', screen: '/other' }, active), undefined);
    assert.equal(
      labelConflict({ label: 'edit', means: 'Edit', screen: '/emp', element: '|/a' }, [{ label: 'edit', means: 'Edit', screen: '/emp', element: '|/b' }]),
      undefined,
    );
  });
});

describe('E0.18 step 6: the worked example of a reading', () => {
  it('what the engine reads a sentence as is kept, and compared on every run', async () => {
    const now = await readsAs('step', 'Click the Login button');
    assert.ok(now?.startsWith('CLICK|'), String(now));
    const p: ReadingPayload = { readingKind: 'step', from: 'Click on the sign in', to: 'Click the Login button', readsAs: now };
    assert.equal(await exampleProblem(p), undefined);
    const changed = await exampleProblem({ ...p, readsAs: 'CLICK|Button|Sign in||' });
    assert.ok(changed?.includes('a person checks the reading again'), String(changed));
  });

  it('a check keeps its kind, target, expected value and negation', async () => {
    const shown = await readsAs('check', 'The Dashboard heading is displayed');
    const notShown = await readsAs('check', 'The Dashboard heading is not displayed');
    assert.ok(shown && notShown && shown !== notShown, `${shown} / ${notShown}`);
  });
});

describe('E0.18 step 6: saving and running with the learning service', () => {
  const setup = async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-e018-')), 'l.db');
    const store = await Store.open(file);
    await store.createProject({
      id: 'p',
      name: 'p',
      baseUrl: 'http://127.0.0.1:1',
      testIdAttribute: 'data-testid',
      browser: 'chromium',
      workspace: path.join(tmpdir(), 'p'),
    });
    return { store, service: new LearningService(store) };
  };

  it('a reading is saved with its example; one that undoes it is refused with the reason', async () => {
    const { store, service } = await setup();
    const saved = await service.saveReading('p', { readingKind: 'step', from: 'Click on the sign in', to: 'Click the Login button' }, 'test', 'tester');
    assert.ok((saved.payload as unknown as ReadingPayload).readsAs?.startsWith('CLICK|'));
    await assert.rejects(
      service.saveReading('p', { readingKind: 'step', from: 'Click the Login button', to: 'Click on the sign in' }, 'test', 'tester'),
      (e: unknown) => e instanceof EntryRefused && e.message.includes('each other'),
    );
    assert.equal((await learnedForRun(store, 'p')).rejected.length, 0, 'the saved reading still reads as it did');
  });

  it('a reading whose example the engine reads otherwise now is set aside by the run, with the reason', async () => {
    const { store, service } = await setup();
    const saved = await service.saveReading('p', { readingKind: 'step', from: 'Click on the sign in', to: 'Click the Login button' }, 'test', 'tester');
    // As if the engine had read it otherwise when it was saved: the run sees the two differ.
    await store.saveLearnedEntry('p', { ...saved, payload: { ...saved.payload, readsAs: 'CLICK|Button|Sign in||' } }, 'test');
    const run = await learnedForRun(store, 'p');
    assert.equal(run.rejected.length, 1);
    assert.ok(run.rejected[0]?.why.includes('a person checks the reading again'), run.rejected[0]?.why);
  });
});
