import { useCallback, useEffect, useState } from 'react';
import { api, type RawTestCase, type TestCaseRecord, type TestCaseRun } from '../api';
import { CaseForm, duration, ErrorNote, JobBadge, StatusBadge, when } from '../components/common';
import { useServerEvents } from '../events';
import { Link, navigate } from '../router';

type Detail = TestCaseRecord & { versions: Array<{ version: number; reason: string; createdAt: string; raw: RawTestCase }>; runs: TestCaseRun[] };

/** One saved test case: what was written, every run of it, and Run again (item 1, item 3). */
export function CasePage({ projectId, caseId }: { projectId: string; caseId: string }) {
  const [c, setC] = useState<Detail>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.testCase(projectId, caseId).then(setC, (e: Error) => setError(e.message));
  }, [projectId, caseId]);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === 'job' && e.job.projectId === projectId) load();
  });
  // Without a live connection the page still catches up.
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ErrorNote error={error} />;
  if (!c) return <p className="muted">Loading…</p>;
  const raw = c.raw;
  const running = c.runs.some((r) => ['queued', 'running', 'waiting', 'review'].includes(r.jobStatus));

  const runAgain = async () => {
    setBusy(true);
    try {
      const job = await api.runTestCase(projectId, c.extId);
      navigate(`/jobs/${job.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        <Link to={`/projects/${projectId}?tab=cases`}>{projectId}</Link> / test cases / {c.extId}
      </p>
      <div className="row" style={{ margin: '0.25rem 0 1rem' }}>
        <h1 className="grow" style={{ margin: 0 }}>
          {c.title}
        </h1>
        {c.lastStatus && <StatusBadge status={c.lastStatus} />}
        <button type="button" className="primary" disabled={busy || running || editing} onClick={() => void runAgain()}>
          Run again
        </button>
        <button type="button" disabled={editing} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className="danger"
          onClick={async () => {
            if (!confirm(`Remove ${c.extId} from the list? Its past results are kept.`)) return;
            await api.deleteTestCase(projectId, c.extId);
            navigate(`/projects/${projectId}?tab=cases`);
          }}
        >
          Remove
        </button>
      </div>
      {running && <p className="notice warn">A run of this test case is in progress. Open it from the history below.</p>}

      {editing ? (
        <section className="panel">
          <h2>Edit the test case</h2>
          <p className="muted">Saving makes a new version. Run it again to explore and run the changed steps.</p>
          <CaseForm
            initial={raw}
            submitLabel="Save as a new version"
            onSubmit={async (next) => {
              await api.updateTestCase(projectId, c.extId, next);
              setEditing(false);
              load();
            }}
            onCancel={() => setEditing(false)}
          />
        </section>
      ) : (
        <section className="panel stack">
          <div className="grid2">
            <div>
              <div className="muted">ID</div>
              {c.extId} · version {c.version}
            </div>
            <div>
              <div className="muted">Type</div>
              {raw.type ?? '—'}
            </div>
          </div>
          {raw.preconditions && (
            <div>
              <div className="muted">Preconditions</div>
              {raw.preconditions}
            </div>
          )}
          <div>
            <div className="muted">Steps</div>
            <div style={{ whiteSpace: 'pre-line' }}>{raw.steps}</div>
          </div>
          {raw.testData && (
            <div>
              <div className="muted">Test data</div>
              <div style={{ whiteSpace: 'pre-line' }}>{raw.testData}</div>
            </div>
          )}
          <div>
            <div className="muted">Expected result</div>
            {raw.expected}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {c.sourceKind === 'workbook' ? `From a workbook${c.sourceRow ? `, row ${c.sourceRow}` : ''}` : 'Written in the form'} · saved {when(c.createdAt)}
          </p>
        </section>
      )}

      <section className="panel">
        <h2>Runs</h2>
        {c.runs.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Result</th>
                  <th>What happened</th>
                  <th>Started</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {c.runs.map((r) => (
                  <tr key={r.jobId}>
                    <td>
                      <Link to={`/jobs/${r.jobId}`}>{r.executionId ?? r.jobId}</Link>
                    </td>
                    <td>
                      {['PASS', 'FAIL', 'BLOCKED', 'NEEDS REVIEW'].includes(r.status) ? <StatusBadge status={r.status} /> : <JobBadge status={r.jobStatus} />}
                    </td>
                    <td>{r.summary}</td>
                    <td>{when(r.at)}</td>
                    <td>{duration(r.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Not run yet.</p>
        )}
      </section>

      {c.versions.length > 1 && (
        <section className="panel">
          <h2>Versions</h2>
          <ul>
            {c.versions.map((v) => (
              <li key={v.version}>
                Version {v.version} · {v.reason} · {when(v.createdAt)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
