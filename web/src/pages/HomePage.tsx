import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Dashboard, type ReviewSummary } from '../api';
import { ErrorNote, ProjectForm, when } from '../components/common';
import { Icon, initialsOf } from '../components/ui';
import { useServerEvents } from '../events';
import { Link, navigate } from '../router';
import { hostOf } from '../shell';
import { HealthBadge } from './ReleasesPage';

const REVIEWER_KEY = 'auto-qa.reviewer';
const reviewer = (): string => {
  try {
    return localStorage.getItem(REVIEWER_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
};
const greeting = (d: Date): string => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');
const ago = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(min) || min < 0) return undefined;
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};

type Filter = 'all' | 'needs' | 'passing';

/**
 * U1 step 2, the start page: a welcome box with the one thing worth doing today and the state of every test case, then a card per project
 * (its results, what waits for you, its last run), the releases in progress, and a New project drawer. It replaces the Dashboard and
 * the Projects list; what they showed is here (counts, approved and scripts, latest runs, releases).
 */
export function HomePage() {
  const [d, setD] = useState<Dashboard>();
  const [review, setReview] = useState<ReviewSummary>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(() => new URLSearchParams(location.search).get('new') === '1');
  const load = useCallback(() => {
    api.dashboard().then(setD, (e: Error) => setError(e.message));
    api.reviewSummary().then(setReview, () => setReview({ projects: [], remembered: 0 }));
  }, []);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === 'job') load();
  });

  if (error) return <ErrorNote error={error} />;
  if (!d) return <p className="muted">Loading…</p>;

  const questionsOf = (id: string) => review?.projects.find((p) => p.projectId === id);
  const needsYou = (id: string, cases: Dashboard['projects'][number]['cases']) => (questionsOf(id)?.questions ?? 0) > 0 || cases.needs + cases.blocked > 0;
  const passing = (cases: Dashboard['projects'][number]['cases']) => cases.total > 0 && cases.pass === cases.total;
  const shown = d.projects.filter((p) => filter === 'all' || (filter === 'needs' ? needsYou(p.project.id, p.cases) : passing(p.cases)));
  const lastRun = d.projects
    .flatMap((p) => p.executions.map((e) => e.startedAt))
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  const focus = [...(review?.projects ?? [])].filter((p) => p.biggest).sort((a, b) => (b.biggest?.cases ?? 0) - (a.biggest?.cases ?? 0))[0];
  const questions = (review?.projects ?? []).reduce((n, p) => n + p.questions, 0);
  const name = reviewer();
  const releases = d.projects.flatMap((p) => p.releases.map((r) => ({ ...r, projectId: p.project.id, projectName: p.project.name })));

  return (
    <>
      <section className="welcome" aria-labelledby="welcome-title">
        <div className="welcome-main">
          <span className="welcome-chip">
            <span className="dot" aria-hidden="true" />
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            {lastRun ? ` · last run ${ago(lastRun)}` : ''}
          </span>
          <h1 id="welcome-title">
            {greeting(new Date())}
            {name ? (
              <>
                , <span className="name">{name}</span>
              </>
            ) : null}
          </h1>
          <p className="muted">
            {d.totals.projects === 0
              ? 'Start with a project: the address of the application you test, and a login for the tests.'
              : questions > 0
                ? `${questions} question${questions === 1 ? '' : 's'} wait${questions === 1 ? 's' : ''} for you across your projects. One answer is remembered for every test case with it.`
                : 'Nothing waits for you. Run a workbook or a test case to see where things stand.'}
          </p>
          {focus?.biggest && (
            <div className="focus-card">
              <span className={`project-tile tile-${tileOf(d, focus.projectId)}`} style={{ width: 44, height: 44, fontSize: 16 }} aria-hidden="true">
                {initialsOf(focus.projectName)}
              </span>
              <div className="focus-text">
                <span className="eyebrow">Today's focus</span>
                <strong>
                  {focus.projectName}: one answer settles {focus.biggest.cases} test case{focus.biggest.cases === 1 ? '' : 's'}
                </strong>
                <span className="muted">“{focus.biggest.clause}”</span>
              </div>
              <Link to={`/projects/${focus.projectId}/review`} className="button primary">
                Answer it <Icon name="arrow" size={16} />
              </Link>
            </div>
          )}
          <div className="row">
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> New project
            </button>
          </div>
        </div>
        {d.totals.cases > 0 && (
          <div className="welcome-side">
            <StatusRing totals={d.totals} />
            <div className="stat-pair">
              <div className="stat">
                <span className="muted">Questions to answer</span>
                <strong>{questions}</strong>
                <small className="muted">one answer each</small>
              </div>
              <div className="stat">
                <span className="muted">Answers remembered</span>
                <strong>{review?.remembered ?? 0}</strong>
                <small className="muted">never asked twice</small>
              </div>
              <div className="stat">
                <span className="muted">Approved</span>
                <strong>{d.totals.approved}</strong>
              </div>
              <div className="stat">
                <span className="muted">Scripts ready</span>
                <strong>{d.totals.scripts}</strong>
              </div>
            </div>
          </div>
        )}
      </section>

      <div className="row section-head">
        <h2 className="grow">Your projects</h2>
        <div className="tabs" role="tablist" aria-label="Filter projects">
          {(
            [
              ['all', `All ${d.projects.length}`],
              ['needs', `Needs you ${d.projects.filter((p) => needsYou(p.project.id, p.cases)).length}`],
              ['passing', `All passing ${d.projects.filter((p) => passing(p.cases)).length}`],
            ] as Array<[Filter, string]>
          ).map(([f, label]) => (
            <button type="button" role="tab" key={f} aria-selected={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="project-grid">
        {shown.map(({ project, cases, executions }) => {
          const q = questionsOf(project.id);
          const state = needsYou(project.id, cases) ? 'needs' : passing(cases) ? 'passing' : cases.total === 0 ? 'empty' : 'ran';
          return (
            <Link key={project.id} to={`/projects/${project.id}`} className="project-card">
              <span className="project-card-head">
                <span className={`project-tile tile-${project.tile ?? 'lavender'}`} style={{ width: 48, height: 48, fontSize: 17 }} aria-hidden="true">
                  {initialsOf(project.name)}
                </span>
                <span className="project-card-name">
                  <strong>{project.name}</strong>
                  <small className="muted">{hostOf(project.baseUrl)}</small>
                </span>
                {state === 'needs' ? (
                  <span className="pill need">
                    <span className="dot" aria-hidden="true" />
                    Needs you
                  </span>
                ) : state === 'passing' ? (
                  <span className="pill pass">All passing</span>
                ) : state === 'empty' ? (
                  <span className="pill muted-pill">No test cases</span>
                ) : null}
              </span>
              {cases.total > 0 && <ResultsBar cases={cases} />}
              <span className="counts">
                {cases.pass > 0 && (
                  <span>
                    <strong className="pass-ink">{cases.pass}</strong> passed
                  </span>
                )}
                {cases.fail > 0 && (
                  <span>
                    <strong className="fail-ink">{cases.fail}</strong> failed
                  </span>
                )}
                {cases.needs > 0 && (
                  <span>
                    <strong className="need-ink">{cases.needs}</strong> need you
                  </span>
                )}
                {cases.blocked > 0 && (
                  <span>
                    <strong>{cases.blocked}</strong> blocked
                  </span>
                )}
                {cases.notRun > 0 && <span>{cases.notRun} not run</span>}
                <span className="push">
                  {cases.total} test case{cases.total === 1 ? '' : 's'} · {cases.approved} approved · {cases.scripts} script{cases.scripts === 1 ? '' : 's'}
                </span>
              </span>
              <span className="project-card-foot">
                <span className="muted">
                  {q?.questions
                    ? `${q.questions} question${q.questions === 1 ? '' : 's'} waiting${q.held ? ` · ${q.held} held` : ''}`
                    : executions[0]
                      ? `Last run ${executions[0].execId} · ${when(executions[0].startedAt)}`
                      : 'Not run yet'}
                </span>
                <span className="open">
                  Open <Icon name="arrow" size={16} />
                </span>
              </span>
            </Link>
          );
        })}
        <button type="button" className="project-card new-card" aria-label="Create a new project" onClick={() => setCreating(true)}>
          <span className="new-icon">
            <Icon name="plus" size={26} stroke={2.4} />
          </span>
          <strong>New project</strong>
          <span className="muted">Add an application to test: its address and a login. Takes about a minute.</span>
        </button>
      </div>

      {releases.length > 0 && (
        <section className="panel" aria-labelledby="releases-title">
          <h2 id="releases-title">Releases in progress</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Release</th>
                  <th>Date</th>
                  <th>Scope</th>
                  <th>Coverage</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/projects/${r.projectId}/releases`}>
                        <strong>{r.name}</strong>
                      </Link>{' '}
                      {r.version}
                      <div className="muted">{r.projectName}</div>
                    </td>
                    <td>
                      {r.dueDate}
                      <div className="muted">
                        {r.summary.slipDays > 0 ? `${r.summary.slipDays} day(s) later than planned` : 'as planned'} ·{' '}
                        {r.summary.daysLeft >= 0 ? `${r.summary.daysLeft} day(s) left` : `${-r.summary.daysLeft} day(s) overdue`}
                      </div>
                    </td>
                    <td>
                      {r.summary.baselineFeatures + r.summary.addedFeatures} features
                      {r.summary.addedFeatures > 0 && (
                        <div className="muted">
                          +{r.summary.addedFeatures} added ({r.summary.scopeGrowthPercent}% more work)
                        </div>
                      )}
                    </td>
                    <td>{r.summary.coveragePercent}%</td>
                    <td>
                      <HealthBadge summary={r.summary} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {creating && <NewProjectDrawer onClose={() => setCreating(false)} />}
    </>
  );
}

const tileOf = (d: Dashboard, id: string): string => d.projects.find((p) => p.project.id === id)?.project.tile ?? 'lavender';

function ResultsBar({ cases }: { cases: Dashboard['projects'][number]['cases'] }) {
  const parts: Array<[string, number]> = [
    ['pass', cases.pass],
    ['fail', cases.fail],
    ['other', cases.needs],
    ['blocked', cases.blocked],
  ];
  return (
    <span
      className="bar"
      role="img"
      aria-label={`${cases.pass} passed, ${cases.fail} failed, ${cases.needs} need you, ${cases.blocked} blocked, ${cases.notRun} not run, of ${cases.total}`}
    >
      {parts.map(([k, n]) => (n > 0 ? <span key={k} className={k} style={{ flex: n }} /> : null))}
      {cases.notRun > 0 && <span className="notrun" style={{ flex: cases.notRun }} />}
    </span>
  );
}

/** Every test case of every project by its last result, as a ring; the middle says how many wait for you. */
function StatusRing({ totals }: { totals: Dashboard['totals'] }) {
  const r = 68;
  const c = 2 * Math.PI * r;
  const parts: Array<[string, number, string]> = [
    ['passed', totals.pass, 'var(--pass-solid)'],
    ['failed', totals.fail, 'var(--fail-solid)'],
    ['need you', totals.needs, 'var(--review-solid)'],
    ['blocked', totals.blocked, 'var(--blocked-ink)'],
    ['not run', totals.notRun, 'var(--line-strong)'],
  ];
  const total = Math.max(1, totals.cases);
  let at = 0;
  return (
    <div className="ring-box">
      <svg width="150" height="150" viewBox="0 0 180 180" role="img" aria-label={parts.map(([l, n]) => `${n} ${l}`).join(', ')}>
        <circle cx="90" cy="90" r={r} fill="none" style={{ stroke: 'var(--sunk)' }} strokeWidth="14" />
        <g className="ring">
          {parts.map(([label, n, color]) => {
            if (n === 0) return null;
            const len = (n / total) * c;
            const el = (
              <circle
                key={label}
                cx="90"
                cy="90"
                r={r}
                fill="none"
                style={{ stroke: color }}
                strokeWidth="14"
                strokeDasharray={`${Math.max(len - 3, 1)} ${c}`}
                strokeDashoffset={-at}
              />
            );
            at += len;
            return el;
          })}
        </g>
        <text x="90" y="88" textAnchor="middle" className="ring-num">
          {totals.needs || totals.cases}
        </text>
        <text x="90" y="112" textAnchor="middle" className="ring-label">
          {totals.needs ? 'cases need you' : 'test cases'}
        </text>
      </svg>
      <ul className="ring-legend">
        {parts
          .filter(([, n]) => n > 0)
          .map(([label, n, color]) => (
            <li key={label} className="ring-item">
              <span className="ring-swatch" style={{ background: color }} aria-hidden="true" />
              {n} {label}
            </li>
          ))}
      </ul>
    </div>
  );
}

/** U1 step 2: a new project in a panel from the right, over the start page. Focus stays in it; Esc closes it. */
function NewProjectDrawer({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="drawer" aria-labelledby="new-project-title" onClose={onClose}>
      <div className="drawer-head">
        <div>
          <h2 id="new-project-title">New project</h2>
          <p className="muted">The application you want to test, and how to log in to it.</p>
        </div>
        <button type="button" className="icon-button" aria-label="Close" onClick={() => ref.current?.close()}>
          <Icon name="close" size={20} />
        </button>
      </div>
      <div className="drawer-body">
        <ProjectForm
          checkAddress
          submitLabel="Create project"
          onSubmit={async (p) => {
            const created = await api.createProject(p);
            navigate(`/projects/${created.id}`);
          }}
        />
      </div>
    </dialog>
  );
}
