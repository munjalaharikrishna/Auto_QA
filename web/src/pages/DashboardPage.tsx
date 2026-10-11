import { useCallback, useEffect, useState } from 'react';
import { api, type Dashboard } from '../api';
import { ErrorNote, when } from '../components/common';
import { useServerEvents } from '../events';
import { Link } from '../router';
import { HealthBadge } from './ReleasesPage';

const Tile = ({ num, label, to }: { num: number | string; label: string; to?: string }) => {
  const body = (
    <>
      <div className="num">{num}</div>
      <div className="label">{label}</div>
    </>
  );
  return to ? (
    <Link to={to} className="tile">
      {body}
    </Link>
  ) : (
    <div className="tile">{body}</div>
  );
};

/** Results bar: passed, failed, and everything else, as a share of the cases. */
function ResultBar({ pass, fail, total }: { pass: number; fail: number; total: number }) {
  const w = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className="bar" role="img" aria-label={`${pass} passed, ${fail} failed, ${total - pass - fail} other or not run, of ${total}`}>
      <span className="pass" style={{ width: w(pass) }} />
      <span className="fail" style={{ width: w(fail) }} />
      <span className="other" style={{ width: w(total - pass - fail) }} />
    </div>
  );
}

export function DashboardPage() {
  const [d, setD] = useState<Dashboard>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.dashboard().then(setD, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === 'job') load();
  });
  if (error) return <ErrorNote error={error} />;
  if (!d) return <p className="muted">Loading…</p>;
  const t = d.totals;
  if (!t.projects) {
    return (
      <>
        <h1>Dashboard</h1>
        <section className="panel">
          <p>
            Nothing here yet. <Link to="/projects">Create a project</Link> with the URL of the application you test, then add test cases.
          </p>
        </section>
      </>
    );
  }
  const releases = d.projects.flatMap((p) => p.releases.map((r) => ({ ...r, projectName: p.project.name })));
  return (
    <>
      <h1>Dashboard</h1>
      <div className="tiles">
        <Tile num={t.projects} label="Projects" to="/projects" />
        <Tile num={t.cases} label="Test cases" to="/test-cases" />
        <Tile num={t.approved} label="Approved for automation" to="/automation" />
        <Tile num={t.scripts} label="Scripts recorded" to="/automation" />
        <Tile num={t.pass} label="Last result: pass" />
        <Tile num={t.fail} label="Last result: fail" />
        <Tile num={t.notRun} label="Not run yet" />
      </div>

      <section className="panel">
        <h2>Releases in progress</h2>
        {releases.length ? (
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
                      <Link to={`/releases?project=${r.projectId}`}>
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
        ) : (
          <p className="muted">
            No release in progress. <Link to="/releases">Plan one</Link>.
          </p>
        )}
      </section>

      {d.projects.map(({ project, cases, executions }) => (
        <section className="panel" key={project.id}>
          <div className="row">
            <h2 className="grow" style={{ margin: 0 }}>
              <Link to={`/test-cases?project=${project.id}`}>{project.name}</Link>
            </h2>
            <span className="muted">{project.baseUrl}</span>
          </div>
          <p className="muted" style={{ margin: '0.5rem 0' }}>
            {cases.total} test cases · {cases.approved} approved · {cases.draft} draft · {cases.scripts} scripts ready
          </p>
          <ResultBar pass={cases.pass} fail={cases.fail} total={cases.total} />
          <p className="muted" style={{ margin: '0.35rem 0 0.75rem' }}>
            {cases.pass} passed · {cases.fail} failed · {cases.notRun} not run
          </p>
          {executions.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Latest runs</th>
                    <th>Result</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((x) => (
                    <tr key={x.execId}>
                      <td>{x.execId}</td>
                      <td>
                        {Object.entries(x.totals)
                          .map(([k, v]) => `${v} ${k.toLowerCase()}`)
                          .join(' · ') || x.status}
                      </td>
                      <td>{when(x.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No runs yet.
            </p>
          )}
        </section>
      ))}
    </>
  );
}
