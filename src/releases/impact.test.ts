import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addWorkingDays, daysBetween, type FeatureLike, isDate, suggestDate, summarize } from './impact.js';

const feature = (id: string, over: Partial<FeatureLike> = {}): FeatureLike => ({
  id,
  title: id,
  effortDays: 5,
  status: 'planned',
  addedAfterBaseline: false,
  removed: false,
  caseIds: [],
  ...over,
});

describe('release dates', () => {
  it('skips weekends when adding working days', () => {
    assert.equal(addWorkingDays('2026-10-09', 1), '2026-10-12'); // Friday → Monday
    assert.equal(addWorkingDays('2026-10-09', 5), '2026-10-16');
    assert.equal(addWorkingDays('2026-10-09', 0), '2026-10-09');
    assert.equal(addWorkingDays('2026-10-09', 0.5), '2026-10-12', 'part of a day counts as a day');
  });

  it('shares the added effort between the team', () => {
    assert.equal(suggestDate('2026-10-12', 10, 2), '2026-10-19');
    assert.equal(suggestDate('2026-10-12', 10, 1), '2026-10-26');
    assert.equal(suggestDate('2026-10-12', 10, 0), '2026-10-26', 'a team of nobody is a team of one');
  });

  it('counts calendar days and rejects dates that do not exist', () => {
    assert.equal(daysBetween('2026-10-01', '2026-10-11'), 10);
    assert.equal(daysBetween('2026-10-11', '2026-10-01'), -10);
    assert.ok(isDate('2026-02-28'));
    assert.ok(!isDate('2026-02-30'));
    assert.ok(!isDate('10/11/2026'));
  });
});

describe('release summary', () => {
  const release = { baselineDate: '2026-10-20', dueDate: '2026-10-27', teamSize: 1, status: 'in-progress' as const };

  it('shows the growth of the scope, the slip and the coverage', () => {
    const features = [
      feature('a', { effortDays: 6, caseIds: ['TC-1'] }),
      feature('b', { effortDays: 4 }),
      feature('c', { effortDays: 5, addedAfterBaseline: true, caseIds: ['TC-2'] }),
      feature('d', { effortDays: 3, removed: true }),
    ];
    const s = summarize(
      release,
      features,
      [
        { extId: 'TC-1', lastStatus: 'PASS', approved: true },
        { extId: 'TC-2', approved: false },
      ],
      '2026-10-11',
    );
    assert.equal(s.baselineFeatures, 2);
    assert.equal(s.addedFeatures, 1);
    assert.equal(s.removedFeatures, 1);
    assert.equal(s.baselineEffortDays, 13, 'the baseline counts the feature that was later removed');
    assert.equal(s.currentEffortDays, 15);
    assert.equal(s.scopeGrowthPercent, 15);
    assert.equal(s.slipDays, 7);
    assert.equal(s.daysLeft, 16);
    assert.equal(s.featuresWithCases, 2);
    assert.equal(s.featuresWithoutCases, 1);
    assert.equal(s.coveragePercent, 67);
    assert.deepEqual(s.cases, { total: 2, approved: 1, pass: 1, fail: 0, other: 0, notRun: 1 });
    assert.equal(s.health.level, 'ok');
  });

  it('says why a release is at risk', () => {
    const f = [feature('a', { caseIds: ['TC-1'] })];
    assert.equal(summarize(release, f, [{ extId: 'TC-1', lastStatus: 'FAIL', approved: true }], '2026-10-11').health.level, 'watch');
    assert.equal(summarize(release, f, [{ extId: 'TC-1', approved: true }], '2026-10-25').health.level, 'watch');
    assert.equal(summarize(release, f, [{ extId: 'TC-1', lastStatus: 'PASS', approved: true }], '2026-10-30').health.level, 'late');
    assert.equal(summarize({ ...release, status: 'released' }, f, [], '2026-12-01').health.level, 'done');
    assert.match(summarize(release, [feature('a')], [], '2026-10-11').health.reason, /No feature has a test case/);
  });

  it('has no growth to report before there is a baseline', () => {
    const s = summarize(release, [], [], '2026-10-11');
    assert.equal(s.scopeGrowthPercent, 0);
    assert.equal(s.coveragePercent, 0);
  });
});
