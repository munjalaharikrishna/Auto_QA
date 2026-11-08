import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Dashboard, type Job, type ProjectView, type ReviewCard, type TestCaseRecord } from '../api';
import { CaseForm, ErrorNote, StatusBadge, when } from '../components/common';
import { Icon } from '../components/ui';
import { useServerEvents } from '../events';
import { Link, navigate } from '../router';

/**
 * U1 step 3: the project's Overview, its Test cases list, Upload and New test case. Every action of the old project tabs is here: run or
 * import a workbook, write a test case, approve, run again, walk through, export.
 */

type Totals = Record<string, number>;
const totalsOf = (j: Job): Totals | undefined => (j.output.summary as { totals?: Totals } | undefined)?.totals;
const isRun = (j: Job) => j.kind === 'workbook' || j.kind === 'single';

function RunBar({ totals }: { totals: Totals }) {
  const parts: Array<[string, number]> = [
    ['pass', totals.PASS ?? 0],
    ['fail', totals.FAIL ?? 0],
    ['other', (totals['NEEDS REVIEW'] ?? 0) + (totals['NOT VERIFIED'] ?? 0)],
    ['blocked', totals.BLOCKED ?? 0],
  ];
  const sum = parts.reduce((n, [, v]) => n + v, 0);
  return (
    <span className="bar run-bar" role="img" aria-label={parts.map(([k, v]) => `${v} ${k === 'other' ? 'need you' : k}`).join(', ')}>
      {sum === 0 ? null : parts.map(([k, v]) => (v > 0 ? <span key={k} className={`${k} seg`} style={{ flex: v }} /> : null))}
    </span>
  );
}

const resultText = (t: Totals): string =>
  [
    t.PASS ? `${t.PASS} pass` : '',
    t.FAIL ? `${t.FAIL} fail` : '',
    t['NEEDS REVIEW'] || t['NOT VERIFIED'] ? `${(t['NEEDS REVIEW'] ?? 0) + (t['NOT VERIFIED'] ?? 0)} need you` : '',
    t.BLOCKED ? `${t.BLOCKED} blocked` : '',
  ]
    .filter(Boolean)
    .join(' · ') || 'no results';

/** The project at a glance: what needs you, the last run, the test cases, the recent runs. */
export function OverviewSection({ project }: { project: ProjectView }) {
  const [jobs, setJobs] = useState<Job[]>();
  const [cards, setCards] = useState<{ jobId: string; cards: ReviewCard[] }>();
  const [dash, setDash] = useState<Dashboard['projects'][number]>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const all = await api.jobs(project.id);
      setJobs(all);
      const last = all.find((j) => j.status === 'done' && isRun(j));
      if (last) setCards({ jobId: last.id, cards: (await api.reviewCards(last.id)).cards });
      setDash((await api.dashboard()).projects.find((p) => p.project.id === project.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project.id]);
  useEffect(() => {
    void load();
  }, [load]);
  useServerEvents((e) => {
    if (e.type === 'job' && e.job.projectId === project.id) void load();
  });
  if (error) return <ErrorNote error={error} />;
  if (!jobs) return <p className="muted">Loading…</p>;
  const open = (cards?.cards ?? []).filter((c) => !c.decided && !c.held);
  const held = (cards?.cards ?? []).filter((c) => c.held).length;
  const casesHeld = new Set(open.flatMap((c) => c.cases.map((x) => x.testId))).size;
  const last = jobs.find((j) => j.status === 'done' && isRun(j) && totalsOf(j));
  const running = jobs.find((j) => ['queued', 'running', 'waiting', 'review'].includes(j.status));
  const runs = jobs.filter(isRun).slice(0, 5);
  return (
    <div className="stack-l">
      {running && (
        <Link to={`/jobs/${running.id}`} className="notice live-notice">
          <span className="dot live" aria-hidden="true" /> A run is{' '}
          {running.status === 'waiting' ? 'waiting for your answer' : running.status === 'review' ? 'waiting for your review' : 'going'}:{' '}
          {running.executionId ?? running.id}. Open it
        </Link>
      )}
      {open.length > 0 && (
        <section className="panel needs-panel" aria-labelledby="needs-title">
          <div className="row">
            <div className="grow">
              <h2 id="needs-title">
                {open.length} question{open.length === 1 ? '' : 's'} need{open.length === 1 ? 's' : ''} you
              </h2>
              <p className="muted">
                They hold up {casesHeld} test case{casesHeld === 1 ? '' : 's'}
                {held ? `; ${held} held` : ''}. Each answer is remembered for the next run.
              </p>
            </div>
            <Link to={`/projects/${project.id}/review`} className="button primary">
              Open review <Icon name="arrow" size={16} />
            </Link>
          </div>
          <ul className="question-list">
            {open.slice(0, 3).map((c) => (
              <li key={c.id} className="question-item">
                <span className="muted">{c.cases.map((x) => x.testId).join(' · ')}</span>
                <strong>“{c.clause || c.why}”</strong>
                <span className="muted">{c.suggestions?.ready[0] ? `Suggested: ${c.suggestions.ready[0].text}` : c.label ? c.label.meaning : c.why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="grid-2">
        <section className="panel" aria-labelledby="last-title">
          <div className="row">
            <h2 id="last-title" className="grow">
              Last run
            </h2>
            {last && <Link to={`/jobs/${last.id}`}>{last.executionId ?? last.id}</Link>}
          </div>
          {last ? (
            <>
              <RunBar totals={totalsOf(last) as Totals} />
              <div className="big-counts">
                {(
                  [
                    ['PASS', 'passed', 'pass-ink'],
                    ['FAIL', 'failed', 'fail-ink'],
                    ['NEEDS REVIEW', 'need you', 'need-ink'],
                    ['BLOCKED', 'blocked', ''],
                  ] as const
                ).map(([k, label, cls]) => (
                  <div key={k}>
                    <strong className={cls}>{(totalsOf(last) as Totals)[k] ?? 0}</strong>
                    <span className="muted">{label}</span>
                  </div>
                ))}
              </div>
              <p className="muted">{when(last.createdAt)}</p>
            </>
          ) : (
            <p className="muted">Not run yet. Upload a workbook or write a test case to start.</p>
          )}
        </section>
        <section className="panel" aria-labelledby="cases-title">
          <div className="row">
            <h2 id="cases-title" className="grow">
              Test cases
            </h2>
            <Link to={`/projects/${project.id}/cases`}>See all {dash?.cases.total ?? ''}</Link>
          </div>
          <div className="big-counts">
            <div>
              <strong>{dash?.cases.total ?? 0}</strong>
              <span className="muted">written</span>
            </div>
            <div>
              <strong>{dash?.cases.approved ?? 0}</strong>
              <span className="muted">approved</span>
            </div>
            <div>
              <strong>{dash?.cases.scripts ?? 0}</strong>
              <span className="muted">scripts ready</span>
            </div>
          </div>
          <p className="muted">Approve a test case once it runs cleanly; approved ones get a Playwright script in Automation.</p>
          <div className="row">
            <Link to={`/projects/${project.id}/upload`} className="button primary">
              <Icon name="plus" size={16} /> Upload workbook
            </Link>
            <Link to={`/projects/${project.id}/new-case`} className="button secondary">
              New test case
            </Link>
          </div>
        </section>
      </div>
      <section className="panel" aria-labelledby="recent-title">
        <div className="row">
          <h2 id="recent-title" className="grow">
            Recent runs
          </h2>
          <Link to={`/projects/${project.id}/runs`}>All runs</Link>
        </div>
        {runs.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>What</th>
                  <th>Result</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((j) => {
                  const t = totalsOf(j);
                  const theCase = j.input.case as { title?: string } | undefined;
                  return (
                    <tr key={j.id}>
                      <td>
                        <Link to={`/jobs/${j.id}`}>{j.executionId ?? j.id}</Link>
                      </td>
                      <td>{j.kind === 'workbook' ? String(j.input.originalName ?? 'Workbook') : (theCase?.title ?? 'Test case')}</td>
                      <td>{t ? resultText(t) : <span className="muted">{j.status}</span>}</td>
                      <td>{when(j.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No runs yet.</p>
        )}
      </section>
    </div>
  );
}

type CaseFilter = 'all' | 'needs' | 'failed' | 'passed' | 'notrun';
const FILTERS: Array<[CaseFilter, string, (c: TestCaseRecord) => boolean]> = [
  ['all', 'All', () => true],
  ['needs', 'Needs you', (c) => c.lastStatus === 'NEEDS REVIEW' || c.lastStatus === 'NOT VERIFIED' || c.lastStatus === 'BLOCKED'],
  ['failed', 'Failed', (c) => c.lastStatus === 'FAIL'],
  ['passed', 'Passed', (c) => c.lastStatus === 'PASS'],
  ['notrun', 'Not run', (c) => !c.lastStatus],
];

/** Every test case of the project: filter, search, approve, run again, walk through, export. */
export function CasesSection({ project }: { project: ProjectView }) {
  const [cases, setCases] = useState<TestCaseRecord[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState<CaseFilter>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string>();
  const load = useCallback(() => {
    api.testCases(project.id).then(setCases, (e: Error) => setError(e.message));
  }, [project.id]);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === 'job' && e.job.projectId === project.id) load();
  });
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  const shown = useMemo(() => {
    const test = FILTERS.find(([f]) => f === filter)?.[2] ?? (() => true);
    const q = query.trim().toLowerCase();
    return (cases ?? []).filter((c) => test(c) && (!q || c.extId.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)));
  }, [cases, filter, query]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setNotice(undefined);
    try {
      await fn();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (error) return <ErrorNote error={error} />;
  if (!cases) return <p className="muted">Loading…</p>;
  const notRun = cases.filter((c) => !c.lastStatus).length;
  return (
    <div className="stack-l">
      <div className="row">
        <div className="tabs grow" role="tablist" aria-label="Filter test cases">
          {FILTERS.map(([f, label, test]) => (
            <button type="button" role="tab" key={f} aria-selected={filter === f} onClick={() => setFilter(f)}>
              {label} {cases.filter(test).length}
            </button>
          ))}
        </div>
        <label className="search">
          <span className="sr-only">Search test cases</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search test cases" />
        </label>
      </div>
      {notice && <p className="notice warn">{notice}</p>}
      {cases.length === 0 ? (
        <section className="panel empty">
          <h2>No test cases yet</h2>
          <p className="muted">Upload a workbook to import or run its test cases, or write one.</p>
          <div className="row">
            <Link to={`/projects/${project.id}/upload`} className="button primary">
              Upload workbook
            </Link>
            <Link to={`/projects/${project.id}/new-case`} className="button secondary">
              New test case
            </Link>
          </div>
        </section>
      ) : (
        <section className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Test case</th>
                <th>Steps</th>
                <th>Last result</th>
                <th>Last run</th>
                <th>Runs</th>
                <th>Approval</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/projects/${project.id}/cases/${encodeURIComponent(c.extId)}`}>
                      <strong>{c.extId}</strong>
                    </Link>
                    <span className="case-title">{c.title}</span>
                  </td>
                  <td>{c.raw.steps.split('\n').filter((l) => l.trim()).length}</td>
                  <td>{c.lastStatus ? <StatusBadge status={c.lastStatus} /> : <span className="muted">not run</span>}</td>
                  <td>{when(c.lastRunAt)}</td>
                  <td>{c.runCount}</td>
                  <td>
                    <span className="row tight">
                      {c.approval === 'approved' ? <span className="badge PASS">Approved</span> : <span className="badge job">Draft</span>}
                      <button
                        type="button"
                        className="small"
                        disabled={busy === `approve:${c.extId}`}
                        onClick={() =>
                          void act(`approve:${c.extId}`, async () => {
                            await api.setApproval(project.id, c.extId, c.approval === 'approved' ? 'draft' : 'approved');
                            load();
                          })
                        }
                      >
                        {c.approval === 'approved' ? 'Unapprove' : 'Approve'}
                      </button>
                    </span>
                  </td>
                  <td>
                    <span className="row tight">
                      <button
                        type="button"
                        className="small primary"
                        disabled={busy === `run:${c.extId}`}
                        onClick={() =>
                          void act(`run:${c.extId}`, async () => {
                            const job = await api.runTestCase(project.id, c.extId);
                            navigate(`/jobs/${job.id}`);
                          })
                        }
                      >
                        Run again
                      </button>
                      <button
                        type="button"
                        className="small"
                        title="Run the steps one at a time in a browser: pick elements, add checks, reword steps"
                        disabled={busy === `walk:${c.extId}`}
                        onClick={() =>
                          void act(`walk:${c.extId}`, async () => {
                            // The case's last run, when there is one, gives the walkthrough its workbook's login case to log in with first.
                            const job = await api.walkthrough(project.id, c.extId, c.lastJobId ? { fromJob: c.lastJobId } : {});
                            navigate(`/jobs/${job.id}`);
                          })
                        }
                      >
                        Walkthrough
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No test case matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
      {cases.length > 0 && (
        <p className="muted">
          {cases.length} test case{cases.length === 1 ? '' : 's'}, {cases.filter((c) => c.approval === 'approved').length} approved (approved ones appear in
          Automation). Export gives one sheet with every case, its status, the actual result and the screenshot
          {notRun ? `; ${notRun} not run yet are listed as NOT RUN` : ''}.
        </p>
      )}
    </div>
  );
}

/** Writing one test case: the platform explores it, shows the plan, and runs it after you approve. */
export function NewCaseSection({ project }: { project: ProjectView }) {
  return (
    <div className="two-col">
      <section className="panel" aria-labelledby="new-case-title">
        <h2 id="new-case-title">The test case</h2>
        <CaseForm
          submitLabel="Generate"
          onSubmit={async (c) => {
            const job = await api.submitCase(project.id, c);
            navigate(`/jobs/${job.id}`);
          }}
          onCancel={() => navigate(`/projects/${project.id}/cases`)}
        />
      </section>
      <aside className="panel side-tips" aria-label="How to write steps that automate well">
        <h2>Steps that automate well</h2>
        <ul>
          <li>One action per line, with the words the screen shows: Click “Sign in”.</li>
          <li>Values go in Test data; secrets as {'{{env.NAME}}'}.</li>
          <li>Say what should be true on the screen: The “Dashboard” heading is shown.</li>
        </ul>
        <p className="muted">
          After Generate, the platform opens the application, finds each step and shows you the plan before it runs. <Link to="/guide">The writing guide</Link>
        </p>
      </aside>
    </div>
  );
}
