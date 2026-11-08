import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Status, TestVerdict } from '../results/verdict.js';
import { buildReviewCards, type DecisionView, questionOf, type StoredVerdict, sameSentence } from './cards.js';

/**
 * E0.19 step 2: one card per real question. A card is the sentence the engine could not decide and why; cases that ask the same are
 * one card, and the card's headline is that sentence, not the first check that happened not to run.
 */

const wording = (testId: string, actual: string): StoredVerdict => ({
  testId,
  status: 'NEEDS REVIEW',
  verdict: {
    executionId: 'E',
    testId,
    title: testId,
    automationId: testId,
    status: 'NEEDS REVIEW' as Status,
    reason: 'step 33 "Click on Employee Name": ambiguous wording: "Employee Name" names no employee',
    review: [{ id: 'step 33', raw: 'Click on Employee Name', headline: 'Not understood:', why: '"Employee Name" names no employee', todo: [] }],
    expected: 'Verify User should open browser',
    actual,
    steps: [{ id: 'S1', raw: 'Open the browser', result: 'passed' }],
    checks: [{ id: 'E1', raw: 'Verify User should open browser', expected: 'browser is open', actual, result: 'not run' }],
    durationMs: 1,
    evidence: { screenshots: [] },
  } as TestVerdict,
});

const unproven = (testId: string, sentence: string, actual: string): StoredVerdict => ({
  testId,
  status: 'NEEDS REVIEW',
  verdict: {
    executionId: 'E',
    testId,
    title: testId,
    automationId: testId,
    status: 'NEEDS REVIEW' as Status,
    reason: `E2 "${sentence}" is unproven: the box and the part around it are not in the same place`,
    review: [{ id: 'E2', raw: sentence, headline: 'Not proven:', why: 'the box and the part around it are not in the same place', todo: [] }],
    expected: sentence,
    actual,
    steps: [{ id: 'S1', raw: 'Open the login page', result: 'passed' }],
    checks: [{ id: 'E2', raw: sentence, expected: sentence, actual, result: 'not verified' }],
    durationMs: 1,
    evidence: { screenshots: ['a.png'] },
  } as TestVerdict,
});

describe('one card per real question (E0.19 step 2)', () => {
  it('cases with the same unclear sentence are one card, whatever each page showed, headed by that sentence', () => {
    const cards = buildReviewCards([wording('TC15', 'page A'), wording('TC16', 'page B'), wording('TC17', 'page C')], new Map());
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.clause, 'Click on Employee Name');
    assert.equal(cards[0]?.label?.name, 'wording');
    assert.deepEqual(
      cards[0]?.cases.map((c) => c.testId),
      ['TC15', 'TC16', 'TC17'],
    );
  });

  it('"Verify ..." and the same sentence without it are one question', () => {
    assert.equal(sameSentence('Verify  Login section should be middle of the page.'), 'login section should be middle of the page');
    const cards = buildReviewCards(
      [
        unproven('TC01', 'Login section should be middle of the page', 'off by 296 px'),
        unproven('TC02', 'Verify Login section should be middle of the page', 'off by 296 px'),
      ],
      new Map(),
    );
    assert.equal(cards.length, 1);
  });

  it('a check judged on the page stays apart when the pages showed different things: one PASS cannot cover both', () => {
    const cards = buildReviewCards(
      [unproven('TC01', 'Login section is in the middle', 'off by 296 px'), unproven('TC02', 'Login section is in the middle', 'off by 12 px')],
      new Map(),
    );
    assert.equal(cards.length, 2);
    assert.equal(questionOf('NEEDS REVIEW', unproven('X', 's', 'a').verdict).byPage, true);
    assert.equal(questionOf('NEEDS REVIEW', wording('X', 'a').verdict).byPage, false);
  });

  it('a decision made when cards were grouped another way still shows on its case', () => {
    const old: DecisionView = { id: 'RD-1', decision: 'FAIL', reviewer: 'Asha', note: '', decidedAt: '2026-11-07T10:00:00Z', engineStatus: 'NEEDS REVIEW' };
    const cards = buildReviewCards([wording('TC15', 'page A'), wording('TC16', 'page B')], new Map([['TC15', old]]));
    assert.equal(cards[0]?.cases.find((c) => c.testId === 'TC15')?.decision?.id, 'RD-1');
    assert.equal(cards[0]?.decided, false);
  });
});
