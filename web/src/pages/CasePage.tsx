import { useCallback, useEffect, useState } from 'react';
import { api, type RawTestCase, type TestCaseRecord, type TestCaseRun } from '../api';
import { CaseForm, duration, ErrorNote, JobBadge, StatusBadge, when } from '../components/common';
import { useServerEvents } from '../events';
import { Link, navigate } from '../router';

type Detail = TestCaseRecord & {
  versions: Array<{ version: number; reason: string; createdAt: string; raw: RawTestCase; changes: Array<{ text: string }> }>;
  runs: TestCaseRun[];
};

/**
 * One saved test case (U1 step 3): what was written, step by step with what each step should show; every run of it; its versions and its
 * automation. Run again, Walkthrough, Edit (a new version) and Remove (its results are kept, asked in the page, not in a browser pop-up).
 */
export function CasePage({ projectId, caseId }: { projectId: string; caseId: string }) {
  const [c, setC] = useState<Detail>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
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

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head with-actions">
        <div className="page-head-text">
          <nav aria-label="Breadcrumb" className="crumb">
            <Link to={`/projects/${projectId}/cases`}>Test cases</Link> / {c.extId}
          </nav>
          <div className="row tight">
            {c.lastStatus ? <StatusBadge status={c.lastStatus} /> : <span className="badge job">Not run</span>}
            <span className="muted">
              {c.extId} · version {c.version} ·{' '}
              {c.sourceKind === 'workbook' ? `from a workbook${c.sourceRow ? `, row ${c.sourceRow}` : ''}` : 'written in the form'}
            </span>
          </div>
          <h1>{c.title}</h1>
        </div>
        {!editing && (
          <div className="row">
            <button
              type="button"
              disabled={busy}
              title="Run the steps one at a time in a browser: pick elements, add checks, reword steps"
              onClick={() =>
                void guard(async () => {
                  const job = await api.walkthrough(projectId, c.extId, c.lastJobId ? { fromJob: c.lastJobId } : {});
                  navigate(`/jobs/${job.id}`);
                })
              }
            >
              Walkthrough
            </button>
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || running}
              onClick={() =>
                void guard(async () => {
                  const job = await api.runTestCase(projectId, c.extId);
                  navigate(`/jobs/${job.id}`);
                })
              }
            >
              Run again
            </button>
          </div>
        )}
      </header>
      {running && <p className="notice warn">A run of this test case is in progress. Open it from the runs below.</p>}

      {editing ? (
        <div className="two-col">
          <section className="panel" aria-labelledby="edit-title">
            <h2 id="edit-title">Edit {c.extId}</h2>
            <p className="muted">Saving makes version {c.version + 1}; the results of earlier runs stay as they were. Run it again to see the new one.</p>
            <CaseForm
              initial={raw}
              submitLabel={`Save as version ${c.version + 1}`}
              onSubmit={async (next) => {
                await api.updateTestCase(projectId, c.extId, next);
                setEditing(false);
                load();
              }}
              onCancel={() => setEditing(false)}
            />
          </section>
          <aside className="panel side-tips" aria-label="How to write steps that automate well">
            <h2>Steps that automate well</h2>
            <ul>
              <li>One action per line, with the words the screen shows.</li>
              <li>“N: what should be true” after a step checks that step.</li>
              <li>Write secrets in Test data as {'{{env.NAME}}'}.</li>
            </ul>
            <p className="muted">
              To fix a step next to its picture, use Walkthrough, or Edit on the run's result. <Link to="/guide">The writing guide</Link>
            </p>
          </aside>
        </div>
      ) : (
        <div className="two-col">
          <div className="stack-l">
            <section className="panel" aria-labelledby="steps-title">
              <h2 id="steps-title">Steps</h2>
              {raw.preconditions && (
                <p>
                  <span className="eyebrow">Preconditions</span>
                  <br />
                  {raw.preconditions}
                </p>
              )}
              <ol className="step-list">
                {raw.steps
                  .split('\n')
                  .filter((l) => l.trim())
                  .map((line, i) => {
                    const after = raw.stepExpected?.[/^\s*(?:step\s*)?(\d{1,3})/i.exec(line)?.[1] ?? String(i + 1)];
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a saved text have no id of their own
                      <li key={i} className="step-item">
                        <span>{line.replace(/^\s*(?:step\s*)?\d{1,3}\s*[.):-]\s*/i, '')}</span>
                        {after && <span className="muted step-expect">↳ Expected: {after}</span>}
                      </li>
                    );
                  })}
              </ol>
              <div className="facts">
                <div>
                  <span className="eyebrow">Test data</span>
                  <span className="pre-line">{raw.testData || '—'}</span>
                </div>
                <div>
                  <span className="eyebrow">Expected result</span>
                  <span>{raw.expected}</span>
                </div>
                <div>
                  <span className="eyebrow">Type</span>
                  <span>{raw.type ?? '—'}</span>
                </div>
              </div>
              <p className="muted small-print">Saved {when(c.createdAt)}</p>
            </section>
            <section className="panel" aria-labelledby="runs-title">
              <h2 id="runs-title">Runs</h2>
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
                            {['PASS', 'FAIL', 'BLOCKED', 'NEEDS REVIEW', 'NOT VERIFIED'].includes(r.status) ? (
                              <StatusBadge status={r.status} />
                            ) : (
                              <JobBadge status={r.jobStatus} />
                            )}
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
          </div>
          <div className="stack-l">
            <section className="panel" aria-labelledby="versions-title">
              <h2 id="versions-title">Versions</h2>
              <ul className="version-list">
                {c.versions.map((v) => (
                  <li key={v.version}>
                    <strong>{v.version}</strong> · {v.reason} · {when(v.createdAt)}
                    {!!v.changes.length && (
                      <ul>
                        {v.changes.map((x) => (
                          <li key={x.text} className="muted">
                            {x.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <section className="panel" aria-labelledby="auto-title">
              <h2 id="auto-title">Automation</h2>
              <p className="row">
                {c.approval === 'approved' ? <span className="badge PASS">Approved</span> : <span className="badge job">Draft</span>}
                <span className="muted">
                  {c.approval === 'approved'
                    ? 'It is in Automation, where its Playwright script is recorded.'
                    : 'Approve it once it runs cleanly to get a Playwright script.'}
                </span>
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void guard(async () => {
                    await api.setApproval(projectId, c.extId, c.approval === 'approved' ? 'draft' : 'approved');
                    setBusy(false);
                    load();
                  })
                }
              >
                {c.approval === 'approved' ? 'Unapprove' : 'Approve'}
              </button>
            </section>
            {removing ? (
              <section className="panel danger-panel" aria-label="Remove the test case">
                <p>Remove {c.extId} from the list? Its past results are kept.</p>
                <div className="row">
                  <button
                    type="button"
                    className="danger solid"
                    disabled={busy}
                    onClick={() =>
                      void guard(async () => {
                        await api.deleteTestCase(projectId, c.extId);
                        navigate(`/projects/${projectId}/cases`);
                      })
                    }
                  >
                    Remove {c.extId}
                  </button>
                  <button type="button" onClick={() => setRemoving(false)}>
                    Keep it
                  </button>
                </div>
              </section>
            ) : (
              <button type="button" className="link-button danger-link" onClick={() => setRemoving(true)}>
                Remove from the list (its results are kept)
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
