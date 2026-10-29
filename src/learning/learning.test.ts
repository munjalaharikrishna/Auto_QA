import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '../db/store.js';
import type { ManifestTest } from '../generator/plan.js';
import { parseAssertions } from '../parser/assertions.js';
import { defaultParserConfig } from '../parser/config.js';
import { type ProjectRule, ruleKey, rulesFor } from '../parser/rules.js';
import { verdictFor } from '../results/verdict.js';
import { learnedForRun } from './adapter.js';
import { planRuleMigration, summarize } from './plan.js';
import { EntryRefused, LearningService } from './service.js';
import { approvalParts, norm, validateApproval, validateLabel, validateReading } from './validate.js';

/**
 * GV-01 on real data: the checks an entry passes, the migration of the project rules, what a run reads, and the proof that the wrong
 * PASS of 5 Oct cannot come back through a learned sentence. The rules below are the ones found in the development database on
 * 29 Oct 2026 (the wording is theirs; the ids and projects are kept so the plan can be compared with the real run).
 */

const FIVE_OCT = {
  from: 'login is rejected and an appropriate authentication error message is displayed',
  to: 'Appropriate user name  Password not given should shown',
};

const rule = (id: string, projectId: string, kind: ProjectRule['kind'], pattern: string, meaning: string, enabled = true): ProjectRule => ({
  id,
  projectId,
  kind,
  pattern,
  meaning,
  source: 'grouped review',
  enabled,
  createdAt: '2026-10-03T00:00:00.000Z',
});

/** The 21 rules of the development database: the four that judge nothing, the two stale approvals, and the rest. */
const REAL: ProjectRule[] = [
  rule(
    'RULE-130236e3cb',
    'orangehrm-bulk',
    'check',
    'login is rejected and an appropriate invalid username/password error message is displayed',
    'password text box',
    false,
  ),
  rule('RULE-8a8e68d624', 'orangehrm-bulk', 'check', FIVE_OCT.from, FIVE_OCT.to),
  rule('RULE-1de25c83d8', 'updated-bookcart', 'check', 'user should able to see mtech and mba buttons', 'User should see the MBA Button and MTech Button'),
  rule('RULE-5b1672bb7e', 'updated-bookcart', 'check', 'preffered stream should be selected', 'click on EEE button', false),
  rule('RULE-4cbdd3d28c', 'updated-bookcart', 'step', 'click the preffered eee button', 'Click on EEE button'),
  rule('RULE-edcf91585f', 'updated-bookcart', 'step', 'enter network analysis in search box', 'Add book name in the textbox', false),
  rule('RULE-cae629fa8c', 'orangehrm-bulk', 'approved', 'orangehrm home/dashboard is either page: the one the application goes to is used', ''),
  rule(
    'RULE-9158fa21d2',
    'orangehrm-bulk',
    'approved',
    'invalid password was entered as a made-up value that is not valid. add invalid password=… to test data to use a particular one',
    '',
  ),
  rule(
    'RULE-8b332c3ce5',
    'orangehrm-bulk',
    'approved',
    'login is rejected and an appropriate invalid username/password error message is displayed. is read as password text box (a project rule)',
    '',
  ),
  rule('RULE-59f43eaeb5', 'orangehrm-bulk', 'approved', `${FIVE_OCT.from}. is read as ${ruleKey(FIVE_OCT.to)} (a project rule)`, ''),
  rule('RULE-b9f6f6b88e', 'add-enployee', 'element', 'add button below employee information section', 'Add'),
  rule('RULE-1598a5e5e1', 'add-enployee', 'element', 'save', 'Edit'),
  rule('RULE-0478815c96', 'add-enployee', 'element', 'edit', 'Shandi Ms. Cruz Balistreri Keebler Marquardt'),
  rule('RULE-145d653764', 'add-enployee', 'element', 'first name text box. note: text box should accept only alphabets', 'First Name'),
  rule('RULE-9c4e2a1f86', 'updated-bookcart', 'element', 'search box', 'Search books'),
];

const SEEN = new Map([
  ['add-enployee', new Set(['add', 'first name', 'last name', 'edit'].map(norm))],
  ['updated-bookcart', new Set(['search books'].map(norm)).add('')],
]);
const knownNames = (projectId: string) => SEEN.get(projectId);

const checksOf = (sentence: string, rules?: ReturnType<typeof rulesFor>) =>
  parseAssertions(sentence, { ...defaultParserConfig(), ...(rules ? { rules } : {}) }, false);

describe('the checks an entry passes', () => {
  it('quarantines the rewrite of 5 Oct: it turns a sentence that expects a message into a "not shown" check', () => {
    const outcome = validateReading({ readingKind: 'check', from: FIVE_OCT.from, to: FIVE_OCT.to });
    assert.equal(outcome.status, 'quarantined');
    assert.ok(outcome.validation.problem?.includes('NOT shown'), outcome.validation.problem ?? '');
  });
  it('quarantines a rewrite that judges only by absence, and one that is not a check at all', () => {
    assert.equal(
      validateReading({ readingKind: 'check', from: 'the page is fine', to: 'Error "Boom" is not displayed' }).status,
      'quarantined',
      'it adds an absence the tester did not ask for',
    );
    assert.equal(
      validateReading({ readingKind: 'check', from: 'error is not displayed', to: 'Error "Boom" is not displayed' }).status,
      'active',
      'an absence the tester asked for',
    );
    assert.equal(validateReading({ readingKind: 'check', from: 'login is rejected', to: 'password text box' }).status, 'quarantined');
    assert.equal(validateReading({ readingKind: 'step', from: 'do it', to: 'Add book name in the textbox' }).status, 'quarantined');
  });
  it('keeps a sound reading', () => {
    const outcome = validateReading({ readingKind: 'check', from: 'login is rejected', to: 'Error "Invalid credentials" is shown' });
    assert.equal(outcome.status, 'active');
  });
  it('a label for an action cannot name a different action; an unseen name waits for a person; a seen one is active', () => {
    assert.equal(validateLabel({ label: 'save', means: 'Edit' }, new Set([norm('Edit')])).status, 'quarantined');
    assert.equal(validateLabel({ label: 'employee id', means: 'Code' }, new Set()).status, 'pending');
    assert.equal(validateLabel({ label: 'employee id', means: 'Code' }, undefined).status, 'pending');
    assert.equal(validateLabel({ label: 'employee id', means: 'Code' }, new Set([norm('Code')])).status, 'active');
    assert.equal(validateLabel({ label: 'Code', means: 'code' }, new Set([norm('code')])).status, 'quarantined', 'it says the same thing');
    assert.equal(validateLabel({ label: 'name', means: 'a b c d e f g h' }, new Set()).status, 'quarantined');
  });
  it('an approval of a project rule needs that rule to be active; one of a platform assumption does not', () => {
    const accepted = approvalParts(`${FIVE_OCT.from}. is read as ${ruleKey(FIVE_OCT.to)} (a project rule)`);
    assert.ok(accepted.dependsOnReading);
    assert.equal(validateApproval({ assumption: 'x', ...accepted }, []).status, 'quarantined');
    assert.equal(validateApproval({ assumption: 'x', ...accepted }, [{ from: FIVE_OCT.from, to: FIVE_OCT.to }]).status, 'active');
    assert.equal(validateApproval({ assumption: 'the error message "X" was learned from the application.' }, []).status, 'active');
    assert.equal(validateApproval({ assumption: '  ' }, []).status, 'quarantined');
  });
});

describe('the migration of the 21 project rules found on 29 Oct 2026', () => {
  const plan = planRuleMigration(REAL, { knownNames });
  const byId = (id: string) => plan.find((e) => e.legacyRuleId === id);
  it('quarantines every reading that judges nothing, including the rule of 5 Oct, even though that one was switched on', () => {
    for (const id of ['RULE-130236e3cb', 'RULE-8a8e68d624', 'RULE-5b1672bb7e', 'RULE-edcf91585f']) assert.equal(byId(id)?.status, 'quarantined', id);
    assert.ok(byId('RULE-8a8e68d624')?.validation.problem?.includes('NOT shown'));
  });
  it('keeps the sound readings active', () => {
    for (const id of ['RULE-1de25c83d8', 'RULE-4cbdd3d28c']) assert.equal(byId(id)?.status, 'active', id);
  });
  it('voids the approvals of the two rewrites, keeps the two that accept a platform assumption', () => {
    assert.equal(byId('RULE-8b332c3ce5')?.status, 'quarantined');
    assert.equal(byId('RULE-59f43eaeb5')?.status, 'quarantined');
    assert.equal(byId('RULE-cae629fa8c')?.status, 'active');
    assert.equal(byId('RULE-9158fa21d2')?.status, 'active');
  });
  it('quarantines "save" meaning Edit, leaves the unverifiable "edit" meaning a person\'s name pending, and activates only what was seen', () => {
    assert.equal(byId('RULE-1598a5e5e1')?.status, 'quarantined');
    assert.equal(byId('RULE-0478815c96')?.status, 'pending');
    assert.equal(byId('RULE-b9f6f6b88e')?.status, 'active');
    assert.equal(byId('RULE-145d653764')?.status, 'active');
    assert.equal(byId('RULE-9c4e2a1f86')?.status, 'active');
  });
  it('a rule that was switched off never becomes active, and every entry says why when it is not', () => {
    assert.ok(plan.filter((e) => REAL.find((r) => r.id === e.legacyRuleId)?.enabled === false).every((e) => e.status !== 'active'));
    const summary = summarize(plan);
    assert.equal(summary.total, REAL.length);
    assert.ok(summary.notActive.every((n) => n.reason.length > 0));
  });
});

const openStore = async (): Promise<Store> => {
  const store = await Store.open(path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-learning-')), 'test.db'));
  for (const id of ['orangehrm-bulk', 'updated-bookcart', 'add-enployee'])
    await store.createProject({
      id,
      name: id,
      baseUrl: 'http://127.0.0.1:1/app',
      testIdAttribute: 'data-testid',
      browser: 'chromium',
      workspace: path.join(tmpdir(), id),
    });
  return store;
};
const refuses = (text: string) => (e: unknown) => e instanceof EntryRefused && e.message.includes(text);

describe('the store, the service and what a run reads', () => {
  it('saves a reading, replaces it with history when it is answered again, and refuses one that judges nothing', async () => {
    const store = await openStore();
    const svc = new LearningService(store);
    const first = await svc.saveReading(
      'orangehrm-bulk',
      { readingKind: 'check', from: '  "Login is Rejected". ', to: 'Error "Invalid credentials" is shown' },
      'grouped review',
      'tester',
    );
    assert.equal(first.status, 'active');
    assert.equal((first.payload as { from: string }).from, 'login is rejected', 'kept in the form that is compared');
    const second = await svc.saveReading(
      'orangehrm-bulk',
      { readingKind: 'check', from: 'login is rejected', to: 'Error "Wrong password" is shown' },
      'grouped review',
      'tester',
    );
    assert.equal(second.id, first.id, 'the same wording is changed, not added');
    assert.deepEqual(
      (await store.learnedHistory(first.id)).map((h) => h.action),
      ['save', 'replace'],
    );
    await assert.rejects(
      () => svc.saveReading('orangehrm-bulk', { readingKind: 'check', from: FIVE_OCT.from, to: FIVE_OCT.to }, 'written by hand', 'tester'),
      refuses('NOT shown'),
    );
    assert.equal((await store.learnedEntries('orangehrm-bulk')).length, 1, 'nothing was saved for the refused one');
    const audit = (await store.auditLog('orangehrm-bulk')).map((a) => a.action);
    assert.ok(audit.includes('learning.save') && audit.includes('learning.replace'));
    await store.close();
  });

  it('a quarantined entry cannot be switched on; a pending one can, with a reason, by a person', async () => {
    const store = await openStore();
    const svc = new LearningService(store);
    await svc.applyMigration(); // no project rules in this database: nothing to move
    const bad = await store.saveLearnedEntry(
      'orangehrm-bulk',
      {
        kind: 'reading',
        status: 'quarantined',
        key: 'check|x',
        payload: { readingKind: 'check', from: FIVE_OCT.from, to: FIVE_OCT.to },
        source: 'test',
        author: 'test',
        validation: { ok: false, checks: [], problem: 'x', validator: 't' },
      },
      'test',
    );
    await assert.rejects(() => svc.activate('orangehrm-bulk', bad.id, 'tester', 'looks fine to me'), refuses('cannot be switched on'));
    const pending = await svc.saveLabel('add-enployee', { label: 'employee id', means: 'Code' }, 'written by hand', 'tester');
    assert.equal(pending.status, 'pending');
    await assert.rejects(() => svc.activate('add-enployee', pending.id, 'tester', ' '), refuses('Say why'));
    const on = await svc.activate('add-enployee', pending.id, 'tester', 'I looked at the Add Employee page: the field is called Code');
    assert.equal(on.status, 'active');
    assert.deepEqual(
      (await store.learnedHistory(pending.id)).map((h) => [h.action, h.actor, h.statusAfter]),
      [
        ['save', 'tester', 'pending'],
        ['status', 'tester', 'active'],
      ],
    );
    await store.close();
  });

  it('a run reads only active entries, and checks each again: a row switched on by hand with a bad content is not used', async () => {
    const store = await openStore();
    const svc = new LearningService(store);
    await svc.saveReading('orangehrm-bulk', { readingKind: 'check', from: 'login is rejected', to: 'Error "Invalid credentials" is shown' }, 'test', 'tester');
    const tampered = await store.saveLearnedEntry(
      'orangehrm-bulk',
      {
        kind: 'reading',
        status: 'active',
        key: 'check|tampered',
        payload: { readingKind: 'check', from: FIVE_OCT.from, to: FIVE_OCT.to },
        source: 'edited in the database',
        author: 'someone',
        validation: { ok: true, checks: [], validator: 'none' },
      },
      'someone',
    );
    const pending = await svc.saveLabel('orangehrm-bulk', { label: 'employee id', means: 'Code' }, 'test', 'tester');
    const disabled = await svc.saveLabel('orangehrm-bulk', { label: 'x', means: 'Y' }, 'test', 'tester', { seenOnScreen: true });
    await svc.disable('orangehrm-bulk', disabled.id, 'tester', 'wrong');
    const run = await learnedForRun(store, 'orangehrm-bulk');
    assert.deepEqual(Object.keys(run.rules.check), ['login is rejected'], 'only the sound one');
    assert.deepEqual(run.rules.element, {}, 'a pending and a disabled label change nothing');
    assert.deepEqual(
      run.rejected.map((r) => r.id),
      [tampered.id],
    );
    assert.ok(run.rejected[0]?.why.includes('NOT shown'));
    assert.ok(![pending.id, disabled.id].some((id) => run.rejected.some((r) => r.id === id)), 'they were never asked for');
    await store.close();
  });

  it('an approval is void when the reading it accepts is switched off', async () => {
    const store = await openStore();
    const svc = new LearningService(store);
    const reading = await svc.saveReading(
      'orangehrm-bulk',
      { readingKind: 'check', from: 'login is rejected', to: 'Error "Invalid credentials" is shown' },
      'test',
      'tester',
    );
    await svc.approve('orangehrm-bulk', 'login is rejected is read as Error "Invalid credentials" is shown (a project rule)', 'approved in review', 'tester');
    assert.equal((await learnedForRun(store, 'orangehrm-bulk')).approvedAssumptions.size, 1);
    await svc.disable('orangehrm-bulk', reading.id, 'tester', 'wrong');
    assert.equal((await learnedForRun(store, 'orangehrm-bulk')).approvedAssumptions.size, 0, 'what it accepted is no longer active');
    await assert.rejects(
      () => svc.approve('orangehrm-bulk', 'nothing is read as Error "X" is shown (a project rule)', 'approved in review', 'tester'),
      refuses('not active'),
    );
    await store.close();
  });

  it('the migration is idempotent, never undoes a person, and rolls back to nothing active', async () => {
    const store = await openStore();
    for (const r of REAL) await store.upsertRule(r.projectId, { kind: r.kind, pattern: r.pattern, meaning: r.meaning, source: r.source });
    const svc = new LearningService(store, { exploreDir: path.join(tmpdir(), 'no-such-explore-dir') });
    const first = await svc.applyMigration();
    assert.equal(first.written, REAL.length);
    assert.equal((await svc.applyMigration()).written, 0, 'a second run writes nothing');
    const readings = await store.learnedEntries('orangehrm-bulk', { kind: 'reading' });
    const sound = (await store.learnedEntries('updated-bookcart', { kind: 'reading', status: 'active' }))[0];
    assert.ok(
      readings.every((e) => e.status !== 'active'),
      'both orangehrm-bulk readings judge nothing',
    );
    assert.ok(sound);
    // A person switches off one entry; rolling back must not touch what a person decided, and must keep the quarantined ones quarantined.
    await svc.disable('updated-bookcart', sound.id, 'tester', 'not wanted');
    const back = await svc.rollbackMigration();
    assert.ok(back.kept > 0);
    const after = (await Promise.all(['orangehrm-bulk', 'updated-bookcart', 'add-enployee'].map((p) => store.learnedEntries(p)))).flat();
    assert.ok(
      after.every((e) => e.status !== 'active' && e.status !== 'pending'),
      'nothing is active after a rollback',
    );
    assert.ok(
      after.filter((e) => e.legacyRuleId === 'RULE-8a8e68d624').every((e) => e.status === 'quarantined'),
      'a quarantined entry keeps its reason',
    );
    assert.equal((await store.rules('orangehrm-bulk')).length, REAL.filter((r) => r.projectId === 'orangehrm-bulk').length, 'the project rules are untouched');
    await store.close();
  });
});

describe('the wrong PASS of 5 Oct cannot come back through a learned sentence', () => {
  it('shows what the old path did: the rule was switched on, passed its check, and made a check that passes on an empty page', () => {
    const old = rulesFor([rule('x', 'p', 'check', FIVE_OCT.from, FIVE_OCT.to)]);
    const rewritten = old.check[ruleKey(FIVE_OCT.from)] as string;
    const checks = checksOf(rewritten);
    assert.ok(
      checks.every((c) => c.negated),
      'it judges only by absence',
    );
  });
  it('after the migration the sentence is read as the tester wrote it: a message that has to be shown', async () => {
    const store = await openStore();
    for (const r of REAL) await store.upsertRule(r.projectId, { kind: r.kind, pattern: r.pattern, meaning: r.meaning, source: r.source });
    await new LearningService(store, { exploreDir: path.join(tmpdir(), 'none') }).applyMigration();
    const run = await learnedForRun(store, 'orangehrm-bulk');
    assert.equal(run.rules.check[ruleKey(FIVE_OCT.from)], undefined, 'no rule rewrites it');
    assert.equal(
      run.approvedAssumptions.has(ruleKey(`${FIVE_OCT.from}. is read as ${ruleKey(FIVE_OCT.to)} (a project rule)`)),
      false,
      'nor is the rewrite approved',
    );
    const checks = checksOf(FIVE_OCT.from, run.rules);
    assert.ok(
      checks.some((c) => c.type === 'visible' && !c.negated),
      'a message has to be shown',
    );
    assert.ok(!checks.every((c) => c.negated));
    await store.close();
  });
});

describe('there is no second path from the old project rules to a run', () => {
  const src = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
  const ALLOWED = new Set(['db/store.ts', 'learning/service.ts', 'parser/rules.ts']);
  it('only the store, the migration and the definition of a rule touch the old rules', () => {
    const found: string[] = [];
    for (const f of files(src)) {
      const rel = path.relative(src, f).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(f, 'utf8');
      for (const word of ['.upsertRule(', '.updateRule(', '.deleteRule(', 'store.rules(', 'rulesFor(']) if (text.includes(word)) found.push(`${rel}: ${word}`);
    }
    assert.deepEqual(found, []);
  });
});

describe('an approval is not evidence (DEC-05)', () => {
  const learned = 'the error message "Invalid credentials" was learned from the application.';
  const test: ManifestTest = {
    testId: 'TC-1',
    title: 'Login is rejected',
    automationId: 'AUTO-1',
    file: 'tests/tc-1.spec.ts',
    steps: [{ id: 'S1', raw: 'Open Login page', action: 'navigate' }],
    checks: [{ id: 'A1', raw: 'Error "Invalid credentials" is shown', type: 'visible', target: 'Invalid credentials', negated: false }],
    unparsed: [],
    assumptions: [`A1: ${learned}`],
  };
  const facts = { url: 'http://app/', path: '/', title: 'Login', headings: [], messages: ['Invalid credentials'], invalid: [], problems: [] };
  const run = (over: Record<string, unknown> = {}) =>
    ({
      testId: 'TC-1',
      title: 'TC-1',
      status: 'passed',
      expectedStatus: 'passed',
      duration: 5,
      startedAt: '2026-10-29T10:00:00.000Z',
      steps: [
        { title: 'S1: Open Login page', status: 'passed', duration: 1 },
        { title: 'A1: Error shown', status: 'passed', duration: 1 },
      ],
      errors: [],
      facts,
      screenshots: [],
      ...over,
    }) as never;
  const ctx = (approved: string[]) => ({ executionId: 'EXEC-2026-00001', approvedAssumptions: new Set(approved.map(ruleKey)) });

  it('an approved assumption on a run that passed on its evidence is a PASS', () => {
    assert.equal(verdictFor(test, run(), ctx([learned])).status, 'PASS');
  });
  it('the same assumption not approved keeps it at NEEDS REVIEW', () => {
    assert.equal(verdictFor(test, run(), ctx([])).status, 'NEEDS REVIEW');
  });
  it('an approval of a different assumption does not approve this one', () => {
    assert.equal(verdictFor(test, run(), ctx(['the error message "Something else" was learned from the application.'])).status, 'NEEDS REVIEW');
  });
  it('an approval never turns a failed check into a PASS', () => {
    const failed = run({
      status: 'failed',
      steps: [
        { title: 'S1: Open Login page', status: 'passed', duration: 1 },
        { title: 'A1: Error shown', status: 'failed', duration: 1, error: 'not visible' },
      ],
      errors: ['not visible'],
    });
    assert.notEqual(verdictFor(test, failed, ctx([learned])).status, 'PASS');
  });
  it('an approval never turns a check that could not be read into a PASS', () => {
    const unread = { ...test, unparsed: ['A2'] };
    assert.notEqual(verdictFor(unread, run(), ctx([learned])).status, 'PASS');
  });
  it('an approval never turns a check that cannot be verified into a PASS', () => {
    const unverified = { ...test, checks: [...test.checks, { id: 'A2', raw: 'The system behaves well', type: 'observe' as const, negated: false }] };
    const v = verdictFor(unverified, run(), ctx([learned]));
    assert.notEqual(v.status, 'PASS');
  });
  it('an approval is not an assumption of its own: no approval and no assumption is a PASS only on evidence', () => {
    assert.equal(verdictFor({ ...test, assumptions: undefined }, run(), ctx([])).status, 'PASS');
    assert.notEqual(verdictFor({ ...test, assumptions: undefined }, run({ status: 'failed', errors: ['x'] }), ctx([learned])).status, 'PASS');
  });
});
