import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RawTestCase } from '../../model/test-model.js';
import { type ExecutionSession, executePlan } from '../execute/index.js';
import { planActions } from '../execute/planner.js';
import { compileCase } from '../pipeline/compile.js';
import { judge } from '../verdict/index.js';
import type { VerdictName } from '../verdict/verdict.js';
import type { AnswerKey, BenchmarkResult } from './benchmark.js';

/**
 * The mutation harness: the engine is run against a copy of the demo app that has been broken on purpose, one fault at a time.
 * What the page really does is the truth, so an engine that PASSes a case the broken app no longer satisfies has made a wrong
 * PASS, whatever the sentence said. Nothing in the app's own files changes: a small proxy rewrites its pages on the way out.
 *
 * Each case has a verdict on the untouched app (`baseline`). Each mutation says which cases it changes the right answer of
 * (`overrides`); every other case must keep its baseline verdict, which also catches an engine that starts failing what is fine.
 * The result is an ordinary answer key and result list, so the benchmark runner (GV-06, GV-09) and the gate treat a surviving
 * mutant as a wrong PASS.
 */

export interface MutationCase {
  id: string;
  title: string;
  steps: (appUrl: string) => string[];
  expected: string;
  testData?: string;
  /** The right verdict on the app as it is. */
  baseline: VerdictName;
}

export interface Mutation {
  id: string;
  describes: string;
  /** Rewrites one page of the app (`path`, `/dashboard`, …) on the way out; returns the body unchanged when the fault is not on that page. */
  rewrite: (path: string, body: string) => string;
  /** Cases whose right verdict is not their baseline once this fault is in the app. */
  overrides: Record<string, VerdictName>;
}

const loginSteps = (url: string): string[] => [
  `Open ${url}/`,
  "Enter 'demo' in the Username field",
  'Enter password in the Password field',
  "Click the 'Login' button",
];

export const MUTATION_CASES: readonly MutationCase[] = [
  {
    id: 'M-GOOD-LOGIN',
    title: 'A good login reaches the dashboard',
    steps: loginSteps,
    expected: 'The Dashboard heading is displayed',
    testData: 'Password: demo123',
    baseline: 'PASS',
  },
  {
    id: 'M-BAD-PASSWORD-ERROR',
    title: 'A wrong password shows the error',
    steps: loginSteps,
    expected: 'Error message "Invalid username or password" is displayed',
    testData: 'Password: nope',
    baseline: 'PASS',
  },
  {
    id: 'M-BAD-PASSWORD-DASHBOARD',
    title: 'A wrong password is not let in',
    steps: loginSteps,
    expected: 'The Dashboard heading is displayed',
    testData: 'Password: nope',
    baseline: 'FAIL',
  },
];

const swap = (body: string, from: string, to: string): string => {
  if (!body.includes(from)) throw new Error(`the demo app no longer contains "${from}": the mutation needs updating`);
  return body.replace(from, to);
};
const onPage =
  (page: string, from: string, to: string) =>
  (path: string, body: string): string =>
    path === page ? swap(body, from, to) : body;

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'reject-valid-login',
    describes: 'the right username and password are refused',
    rewrite: onPage('/', "username.value === 'demo' && password.value === 'demo123'", 'false'),
    overrides: { 'M-GOOD-LOGIN': 'FAIL' },
  },
  {
    id: 'accept-any-login',
    describes: 'any password is let in',
    rewrite: onPage('/', "username.value === 'demo' && password.value === 'demo123'", 'true'),
    overrides: { 'M-BAD-PASSWORD-ERROR': 'FAIL', 'M-BAD-PASSWORD-DASHBOARD': 'PASS' },
  },
  {
    id: 'silent-failure',
    describes: 'a wrong password shows nothing at all',
    rewrite: onPage('/', 'error.hidden = false;', ''),
    overrides: { 'M-BAD-PASSWORD-ERROR': 'FAIL' },
  },
  {
    id: 'wrong-error-text',
    describes: 'the error says something else',
    rewrite: onPage('/', "error.textContent = 'Invalid username or password'", "error.textContent = 'Something went wrong'"),
    overrides: { 'M-BAD-PASSWORD-ERROR': 'FAIL' },
  },
  {
    id: 'wrong-landing-page',
    describes: 'a good login goes to the profile page, not the dashboard',
    rewrite: onPage('/', "location.href = '/dashboard'", "location.href = '/profile'"),
    overrides: { 'M-GOOD-LOGIN': 'FAIL' },
  },
  {
    id: 'heading-renamed',
    describes: 'the dashboard heading says Overview',
    rewrite: onPage('/dashboard', '<h1>Dashboard</h1>', '<h1>Overview</h1>'),
    overrides: { 'M-GOOD-LOGIN': 'FAIL' },
  },
];

/** A server that passes everything through to `target`, with each HTML page rewritten by `rewrite`. */
export async function startMutant(target: string, rewrite: Mutation['rewrite']): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const upstream = await fetch(new URL(req.url ?? '/', target), { method: req.method, redirect: 'manual' });
      const type = upstream.headers.get('content-type') ?? '';
      const headers: Record<string, string> = type ? { 'content-type': type } : {};
      if (type.includes('text/html')) return res.writeHead(upstream.status, headers).end(rewrite(path, await upstream.text()));
      return res.writeHead(upstream.status, headers).end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      return res.writeHead(502).end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** The verdict the engine reaches for one case on one app, or the reason it could not run. */
export async function verdictFor(c: MutationCase, appUrl: string, session: ExecutionSession, screenshotDir: string): Promise<VerdictName> {
  const raw: RawTestCase = {
    id: c.id,
    title: c.title,
    steps: c
      .steps(appUrl)
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n'),
    expected: c.expected,
    ...(c.testData ? { testData: c.testData } : {}),
  };
  const compile = await compileCase(raw, { env: {} });
  // A case the engine would not compile is a result too: it must never be a PASS.
  if (!compile.ir || !compile.plan) return 'NEEDS_REVIEW';
  const trace = await executePlan(
    { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
    { mcp: session.port, page: session.page, baseUrl: appUrl, screenshotDir },
  );
  return judge({ compile, trace }).verdict;
}

/** The answer key of the whole matrix: the untouched app, then each mutant. The module is the app that was run. */
export function mutationKey(
  checkedBy: string,
  checkedOn: string,
  mutations: readonly Mutation[] = MUTATIONS,
  cases: readonly MutationCase[] = MUTATION_CASES,
): AnswerKey {
  return {
    checkedBy,
    checkedOn,
    cases: [
      ...cases.map((c) => ({ id: c.id, module: 'app:untouched', expected: c.baseline })),
      ...mutations.flatMap((m) =>
        cases.map((c) => ({
          id: c.id,
          module: `mutant:${m.id}`,
          expected: m.overrides[c.id] ?? c.baseline,
          ...(m.overrides[c.id] ? { trap: m.describes } : {}),
        })),
      ),
    ],
  };
}

/** Runs every case on the untouched app and on every mutant. `appUrl` is the running demo app. */
export async function runMutationMatrix(
  appUrl: string,
  session: ExecutionSession,
  screenshotDir: string,
  mutations: readonly Mutation[] = MUTATIONS,
  cases: readonly MutationCase[] = MUTATION_CASES,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const c of cases) results.push({ id: c.id, module: 'app:untouched', verdict: await verdictFor(c, appUrl, session, screenshotDir) });
  for (const m of mutations) {
    const mutant = await startMutant(appUrl, m.rewrite);
    try {
      for (const c of cases) results.push({ id: c.id, module: `mutant:${m.id}`, verdict: await verdictFor(c, mutant.url, session, screenshotDir) });
    } finally {
      await mutant.close();
    }
  }
  return results;
}

/** Mutation score: of the cases a fault made wrong, the share the engine did not PASS. Target 100%. */
export function mutationScore(key: AnswerKey, results: readonly BenchmarkResult[]): { killed: number; total: number; survivors: string[] } {
  const byId = new Map(results.map((r) => [`${r.module}/${r.id}`, r.verdict]));
  const broken = key.cases.filter((c) => c.module.startsWith('mutant:') && c.trap && c.expected !== 'PASS');
  const survivors = broken.filter((c) => byId.get(`${c.module}/${c.id}`) === 'PASS').map((c) => `${c.module}/${c.id}`);
  return { killed: broken.length - survivors.length, total: broken.length, survivors };
}
