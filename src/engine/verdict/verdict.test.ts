import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { RawTestCase } from '../../model/test-model.js';
import type { BlockCode, RunTrace, StepRecord } from '../execute/executor.js';
import type { Observation, ObservedElement } from '../execute/observe.js';
import { planActions } from '../execute/planner.js';
import type { Application } from '../knowledge/schema.js';
import { type CompileResult, compileCase } from '../pipeline/compile.js';
import { buildCards, decide, fingerprintOf, judge, LearningBook, renderCardHtml, renderVerdict, VERDICTS, type Verdict, type VerdictName } from './index.js';

/** E0.8 exit tests: the nine verdicts, freshness, vacuous checks, the confidence invariant, the review card and basic learning. */

const page = (p: Partial<Observation> = {}): Observation => ({
  url: 'http://app/login',
  title: 'Login',
  lines: [],
  elements: [],
  messages: [],
  fieldErrors: [],
  tabs: 1,
  ...p,
});
const el = (role: string, name: string, more: Partial<ObservedElement> = {}): ObservedElement => ({
  identity: name,
  role,
  name,
  tag: role,
  disabled: false,
  invalid: false,
  ...more,
});

const LOGIN = ['Open http://app/login', "Enter 'demo' in the Username field", "Enter 'demo123' in the Password field", "Click the 'Login' button"];

async function compile(steps: string[], expected: string, title = 'A run'): Promise<CompileResult> {
  const raw: RawTestCase = { id: 'T1', title, steps: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), expected };
  return compileCase(raw, { env: {} });
}

/** A trace of a run that finished: each step with the page before it and after it; the last step gets `last`. */
function traceOf(c: CompileResult, last: { before: Observation; after: Observation }, weight = 0.95): RunTrace {
  assert.ok(c.ir && c.plan, `it compiles: ${JSON.stringify(c.issues.filter((i) => i.severity === 'blocking'))}`);
  const plan = planActions(c.ir, c.plan);
  const blank = page();
  const steps: StepRecord[] = plan.chains.map((ch, i) => ({
    step: ch.step,
    action: ch.action,
    original: ch.original,
    status: 'done',
    calls: [],
    changes: [],
    dialogs: [],
    checksAfter: ch.checksAfter,
    notes: [],
    before: i === plan.chains.length - 1 ? last.before : blank,
    after: i === plan.chains.length - 1 ? last.after : blank,
    located: ch.target
      ? { name: ch.target.name ?? '', level: 'role', weight, selector: 'x', tried: [], element: { tag: 'button', role: 'button' }, ignored: [] }
      : undefined,
  }));
  return { testId: 'T1', status: 'completed', capabilities: [], steps };
}

const stopped = (c: CompileResult, code: BlockCode | 'START', reason: string): RunTrace => {
  const t = traceOf(c, { before: page(), after: page() });
  const at = t.steps.at(-1) as StepRecord;
  at.status = code === 'ACTION_FAILED' ? 'failed' : 'blocked';
  if (code !== 'START') at.code = code;
  return { ...t, status: code === 'ACTION_FAILED' ? 'failed' : 'blocked', stoppedAt: { step: at.step, code, reason } };
};

const dashboard = page({ url: 'http://app/dashboard', title: 'Dashboard', elements: [el('heading', 'Dashboard')], lines: ['Dashboard'] });
const failedLogin = page({ messages: ['Invalid credentials'], elements: [el('alert', 'Invalid credentials')], lines: ['Invalid credentials'] });

describe('VD-10: the verdict matrix, one scenario for each of the nine', () => {
  const matrix: Array<[VerdictName, () => Promise<Verdict>, string]> = [
    [
      'PASS',
      async () => {
        const c = await compile(LOGIN, 'The Dashboard heading is displayed');
        return judge({ compile: c, trace: traceOf(c, { before: page(), after: dashboard }) });
      },
      '',
    ],
    [
      'FAIL',
      async () => {
        const c = await compile(LOGIN, 'The Dashboard heading is displayed');
        return judge({ compile: c, trace: traceOf(c, { before: page(), after: failedLogin }) });
      },
      'APPLICATION',
    ],
    [
      'NEEDS_REVIEW',
      async () => {
        const c = await compile(LOGIN, 'Error message "Invalid credentials" is displayed');
        // The error was on the page before the click: this step did not produce it.
        return judge({ compile: c, trace: traceOf(c, { before: failedLogin, after: failedLogin }) });
      },
      '',
    ],
    [
      'NOT_VERIFIED',
      async () => {
        const c = await compile(LOGIN, 'The Dashboard heading is displayed');
        assert.ok(c.ir);
        const ir = { ...c.ir, expectations: c.ir.expectations.map((e) => ({ ...e, condition: { type: 'OTHER' as const, expect: 'an email is sent' } })) };
        return judge({ compile: { ...c, ir }, trace: traceOf(c, { before: page(), after: dashboard }) });
      },
      '',
    ],
    [
      'BLOCKED',
      async () => {
        const c = await compile(LOGIN, 'The Dashboard heading is displayed');
        return judge({ compile: c, trace: stopped(c, 'START', 'the precondition "logged out" does not hold') });
      },
      '',
    ],
    [
      'UNSUPPORTED',
      async () => {
        const c = await compile(['Open http://app/login', 'Do the needful'], 'The Dashboard heading is displayed');
        return judge({ compile: c });
      },
      '',
    ],
    [
      'AUTOMATION_ERROR',
      async () => {
        const c = await compile(LOGIN, 'The Dashboard heading is displayed');
        return judge({ compile: c, trace: stopped(c, 'ACTION_FAILED', 'the tool call threw') });
      },
      'AUTOMATION',
    ],
    [
      'ENVIRONMENT_ERROR',
      async () => {
        const c = await compile(LOGIN, 'The Dashboard heading is displayed');
        return judge({ compile: c, trace: stopped(c, 'ACTION_FAILED', 'page.goto: net::ERR_CONNECTION_REFUSED at http://app/login') });
      },
      'ENVIRONMENT',
    ],
    [
      'TEST_DATA_ERROR',
      async () => {
        const c = await compile(LOGIN, 'The Dashboard heading is displayed');
        return judge({ compile: c, trace: stopped(c, 'VALUE_UNRESOLVED', 'the value of $data.username was not resolved') });
      },
      'TEST_DATA',
    ],
  ];
  for (const [name, run, cause] of matrix) {
    it(`${name}`, async () => {
      const v = await run();
      assert.equal(v.verdict, name, renderVerdict(v));
      if (cause) assert.equal(v.rootCause, cause, 'the root cause');
      assert.equal(v.verification.length, 12, 'the twelve answers are stored with the verdict');
    });
  }
  it('covers every one of the nine verdicts', () => {
    assert.deepEqual(matrix.map((m) => m[0]).sort(), [...VERDICTS].sort());
  });
  it('a locator that is not unique is never a FAIL, and a locked account is a test-data error, not a FAIL', async () => {
    const c = await compile(LOGIN, 'The Dashboard heading is displayed');
    assert.equal(judge({ compile: c, trace: stopped(c, 'LOCATE_AMBIGUOUS', 'two Login buttons') }).verdict, 'NEEDS_REVIEW');
    const locked = page({ messages: ['Your account is locked'], elements: [el('alert', 'Your account is locked')] });
    const v = judge({ compile: c, trace: traceOf(c, { before: page(), after: locked }) });
    assert.equal(v.verdict, 'TEST_DATA_ERROR');
    assert.equal(v.rootCause, 'TEST_DATA');
  });
});

describe('EX-07: evidence freshness', () => {
  it('an error already on the page before the click is not accepted as evidence', async () => {
    const c = await compile(LOGIN, 'Error message "Invalid credentials" is displayed');
    const v = judge({ compile: c, trace: traceOf(c, { before: failedLogin, after: failedLogin }) });
    assert.notEqual(v.verdict, 'PASS');
    assert.equal(v.evaluations[0]?.doubt, 'STALE');
    assert.equal(v.verification[10]?.answer, 'yes', 'answer 11: there is stale evidence');
  });
  it('the same error that this step produced is accepted', async () => {
    const c = await compile(LOGIN, 'Error message "Invalid credentials" is displayed');
    const v = judge({ compile: c, trace: traceOf(c, { before: page(), after: failedLogin }) });
    assert.equal(v.verdict, 'PASS');
    assert.equal(v.evaluations[0]?.fresh, true);
  });
});

describe('EX-08: the vacuous assertion guard', () => {
  it('rejects the 5 Oct checks: a garbled "not visible" and "the button is still shown" as proof of a failure; never PASS', async () => {
    const garbled = await compile(LOGIN, 'Appropriate user name Password not given should shown', 'Login with no password');
    const a = judge({ compile: garbled, trace: traceOf(garbled, { before: page(), after: failedLogin }) });
    assert.notEqual(a.verdict, 'PASS', renderVerdict(a));
    assert.equal(a.evaluations[0]?.doubt, 'VACUOUS');

    const stillShown = await compile(LOGIN, 'The Login button is displayed', 'Login fails with an invalid password');
    const withLogin = page({ elements: [el('button', 'Login')], lines: ['Login'], messages: ['Invalid credentials'] });
    const b = judge({ compile: stillShown, trace: traceOf(stillShown, { before: withLogin, after: withLogin }) });
    assert.notEqual(b.verdict, 'PASS', renderVerdict(b));
    assert.equal(b.evaluations[0]?.doubt, 'VACUOUS');
  });
  it('does not call a real "not shown" check vacuous', async () => {
    const c = await compile(LOGIN, 'Verify the Save button is not visible');
    const before = page({ elements: [el('button', 'Save')], lines: ['Save'] });
    const v = judge({ compile: c, trace: traceOf(c, { before, after: page() }) });
    assert.equal(v.verdict, 'PASS', renderVerdict(v));
  });
});

describe('VD-08: the confidence invariant', () => {
  it('changing every confidence changes no verdict', async () => {
    const cases: Array<[string, Observation]> = [
      ['The Dashboard heading is displayed', dashboard],
      ['The Dashboard heading is displayed', failedLogin],
    ];
    for (const [expected, after] of cases) {
      const c = await compile(LOGIN, expected);
      const verdicts = [0.01, 0.5, 1].map((w) => judge({ compile: c, trace: traceOf(c, { before: page(), after }, w) }).verdict);
      assert.equal(new Set(verdicts).size, 1, verdicts.join(','));
    }
  });
});

describe('VD-11, DEC-05: the user review card', () => {
  it('shows expected, actual and the pictures; a click is stored with who and when, marked decided by user, evidence kept', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aq-card-'));
    const c = await compile(LOGIN, 'Error message "Invalid credentials" is displayed');
    const trace = traceOf(c, { before: failedLogin, after: failedLogin });
    const last = trace.steps.at(-1) as StepRecord;
    last.screenshots = { before: path.join(dir, 'b.png'), after: path.join(dir, 'a.png') };
    const v = judge({ compile: c, trace });
    const [card] = buildCards([{ verdict: v, trace }]);
    assert.ok(card);
    assert.ok(card.expected.includes('Invalid credentials') && card.actual.length > 0);
    assert.equal(card.evidence.before, path.join(dir, 'b.png'));
    const html = renderCardHtml(card);
    assert.ok(html.includes('data-decision="PASS"') && html.includes('data-decision="FAIL"') && html.includes('Expected') && html.includes('Actual'));
    const [decided] = decide(card, [v], { decision: 'PASS', who: 'asha@brightcone.ai', when: '2026-10-12T09:00:00Z' });
    assert.equal(decided?.verdict, 'PASS');
    assert.equal(decided?.engineVerdict, 'NEEDS_REVIEW');
    assert.deepEqual(decided?.decidedByUser, { who: 'asha@brightcone.ai', when: '2026-10-12T09:00:00Z', remembered: false });
    assert.equal(decided?.evaluations[0]?.result, 'unproven', 'the evidence is not changed by the decision');
    assert.ok(renderVerdict(decided as Verdict).includes('decided by user'));
  });
  it('4 cases with the same cause are one card', async () => {
    const runs = [];
    for (const id of ['T1', 'T2', 'T3', 'T4']) {
      const c = { ...(await compile(LOGIN, 'Error message "Invalid credentials" is displayed')), testId: id };
      const trace = { ...traceOf(c, { before: failedLogin, after: failedLogin }), testId: id };
      runs.push({ verdict: judge({ compile: c, trace }), trace });
    }
    assert.ok(runs.every((r) => r.verdict.verdict === 'NEEDS_REVIEW'));
    const cards = buildCards(runs);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0]?.cases, ['T1', 'T2', 'T3', 'T4']);
    const decided = decide(
      cards[0] as (typeof cards)[number],
      runs.map((r) => r.verdict),
      { decision: 'PASS', who: 'asha' },
    );
    assert.deepEqual(
      decided.map((d) => d.verdict),
      ['PASS', 'PASS', 'PASS', 'PASS'],
    );
  });
});

describe('BP-4: basic learning', () => {
  it('after one decision with a message, the next run needs no review', async () => {
    const book = new LearningBook();
    const c = await compile(LOGIN, 'Error message "Invalid credentials" is displayed');
    const stale = traceOf(c, { before: failedLogin, after: failedLogin });
    const first = judge({ compile: c, trace: stale, learning: book });
    assert.equal(first.verdict, 'NEEDS_REVIEW');
    const [card] = buildCards([{ verdict: first, trace: stale }]);
    decide(card as NonNullable<typeof card>, [first], { decision: 'PASS', who: 'asha', when: '2026-10-12T09:00:00Z' }, book);
    const again = judge({ compile: c, trace: stale, learning: book });
    assert.equal(again.verdict, 'PASS', renderVerdict(again));
    assert.equal(again.decidedByUser?.remembered, true);
    assert.equal(again.decidedByUser?.who, 'asha');
  });
  it('a FAIL decision is remembered too, and is saved and loaded as data', async () => {
    const book = new LearningBook();
    const c = await compile(LOGIN, 'Error message "Invalid credentials" is displayed');
    const stale = traceOf(c, { before: failedLogin, after: failedLogin });
    const first = judge({ compile: c, trace: stale });
    const [card] = buildCards([{ verdict: first, trace: stale }]);
    decide(card as NonNullable<typeof card>, [first], { decision: 'FAIL', who: 'asha' }, book);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'aq-learn-')), 'learned.json');
    book.save(file);
    assert.ok(readFileSync(file, 'utf8').includes('"FAIL"'));
    const loaded = LearningBook.load(file);
    assert.equal(judge({ compile: c, trace: stale, learning: loaded }).verdict, 'FAIL');
  });
  it('a vacuous check is never learned into a PASS', async () => {
    const c = await compile(LOGIN, 'Appropriate user name Password not given should shown', 'Login with no password');
    const trace = traceOf(c, { before: page(), after: failedLogin });
    const book = new LearningBook();
    book.decide({
      fingerprint: 'x',
      testId: 'T1',
      clause: 'Appropriate user name Password not given should shown',
      decision: 'PASS',
      who: 'asha',
      message: 'Invalid credentials',
    });
    assert.notEqual(judge({ compile: c, trace, learning: book }).verdict, 'PASS');
  });
  it('remembers the element a person picked and the name a person gave, in the knowledge of the next run', () => {
    const book = new LearningBook();
    const app = {
      version: 1,
      name: 'Demo',
      pages: [
        {
          name: 'Login',
          aliases: [],
          sections: [],
          forms: [],
          filters: [],
          messages: [],
          expectedStates: [],
          route: '/login',
          components: [{ name: 'Username', aliases: [], ontology: 'Field', key: false }],
        },
      ],
      roles: [],
      modules: [],
      rules: [],
      navigation: [],
      authentication: { mfa: 'none' },
      vocabulary: [],
    } as unknown as Application;
    book.mapLabel({ label: 'Login Name', means: 'Username', page: 'Login', who: 'asha' });
    book.pick({ testId: 'T1', wanted: 'Sign in', ontology: 'Button', page: 'Login', xpath: "//*[@id='go']", who: 'asha' });
    const learned = book.applyTo(app);
    const comps = learned.pages[0]?.components ?? [];
    assert.deepEqual(comps.find((x) => x.name === 'Username')?.aliases, ['Login Name']);
    assert.equal(comps.find((x) => x.name === 'Sign in')?.xpath, "//*[@id='go']");
    assert.deepEqual(
      app.pages[0]?.components.map((x) => x.aliases),
      [[]],
      'the original knowledge is not changed',
    );
  });
  it('the same expectation with the same page has the same fingerprint, and a different page has another', () => {
    assert.equal(fingerprintOf('Error shown', 'a b'), fingerprintOf('  error SHOWN ', 'A  B'));
    assert.notEqual(fingerprintOf('Error shown', 'a b'), fingerprintOf('Error shown', 'a c'));
  });
});
