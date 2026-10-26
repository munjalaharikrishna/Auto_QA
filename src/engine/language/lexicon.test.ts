import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DATA_CLASS_DEFS } from '../data/classes.js';
import { understandCase } from './case.js';
import { DATA_CLASS_CHECK_WORDS, DATA_WORDS, STATE_WORDS } from './lexicon.js';
import { SYNONYM_SETS } from './synonyms.js';

/** D2: one list of words. The copies that used to disagree are built from it, and a new copy that drifts fails here. */

describe('D2: one vocabulary', () => {
  it('the synonym sets for states and data are the lexicon, word for word', () => {
    const entries = (category: 'State' | 'Data') => SYNONYM_SETS[category].entries.map((e) => [e.canonical, ...e.phrases]);
    // The State set also holds the layout words ("centered"), which are not a state of a control.
    assert.deepEqual(
      entries('State').slice(0, Object.keys(STATE_WORDS).length),
      Object.values(STATE_WORDS).map((w) => [...w]),
    );
    assert.deepEqual(
      entries('Data'),
      Object.values(DATA_WORDS).map((w) => [...w]),
    );
  });

  it('the data classes use the lexicon words, and a word belongs to one class only', () => {
    const owner = new Map<string, string>();
    for (const [cls, words] of Object.entries(DATA_WORDS)) {
      assert.deepEqual([...(DATA_CLASS_DEFS.find((d) => d.cls === cls)?.words ?? [])], [...words], cls);
      for (const w of words) {
        // "empty" and "blank" are both a state and a kind of data on purpose; no word is two kinds of data.
        if (cls !== 'BLANK') assert.equal(owner.get(w), undefined, `"${w}" is in ${owner.get(w)} and ${cls}`);
        owner.set(w, cls);
      }
    }
    assert.equal(DATA_CLASS_DEFS.find((d) => d.cls === 'EXISTING')?.words.includes('duplicate'), false, '"duplicate" is a copy, not an existing value');
  });

  it('the words a check may end on to name a kind of data are valid or invalid words', () => {
    const known = new Set<string>([...DATA_WORDS.VALID, ...DATA_WORDS.INVALID]);
    for (const w of DATA_CLASS_CHECK_WORDS) assert.ok(known.has(w), w);
  });

  it('a state word of the lexicon is read as that state in a check', () => {
    const kind = (word: string) =>
      understandCase({ id: 'T', title: 'T', steps: '1. Open the Login page', expected: `The Password field is ${word}` }).ir?.expectations[0]?.condition;
    assert.equal(kind('masked')?.type, 'MASKED');
    assert.equal(kind('obscured')?.type, 'MASKED');
    assert.equal(kind('hidden characters')?.type, 'MASKED');
    assert.equal(kind('usable')?.expect, 'ENABLED');
    assert.equal(kind('grayed out')?.expect, 'DISABLED');
  });
});

describe('D2: word forms, adjectives and verbs the grammar did not have', () => {
  const read = (steps: string[], expected: string) =>
    understandCase({ id: 'T', title: 'T', steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), expected });
  const last = (steps: string[]) => read(['Open the Add Employee page', ...steps], 'The Employee List heading is displayed').ir?.steps.at(-1);

  it('"hides characters" and "masks" are the masked check', () => {
    for (const sentence of ['The password field hides the characters', 'The password hides characters', 'The password masks the characters'])
      assert.equal(read(['Open the Login page'], sentence).ir?.expectations[0]?.condition.type, 'MASKED', sentence);
  });
  it('"Return to X" goes to the page X', () => {
    const step = last(['Return to the Employee List page']);
    assert.deepEqual([step?.action, step?.target?.name], ['NAVIGATE', 'Employee List']);
  });
  it('how an element looks is not a part of its name: "the big green Save button" is Save', () => {
    assert.equal(last(['Click the big green Save button'])?.target?.name, 'Save');
    assert.equal(last(['Click the New Employee button'])?.target?.name, 'New Employee', 'a word that can be a name stays one');
  });
  it('"Scroll down to the Save button" scrolls to Save, and "Log out of the application" names no element', () => {
    const scroll = last(['Scroll down to the Save button']);
    assert.deepEqual([scroll?.action, scroll?.target?.name], ['SCROLL', 'Save']);
    const out = last(['Log out of the application']);
    assert.deepEqual([out?.action, out?.target?.name], ['LOGOUT', undefined]);
  });
});
