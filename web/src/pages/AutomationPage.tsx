import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AutomationCase, api, type CatalogueEntry, type ScriptState } from '../api';
import { ErrorNote, StatusBadge, when } from '../components/common';
import { useServerEvents } from '../events';
import { Link, navigate } from '../router';

const SCRIPT_LABEL: Record<ScriptState, string> = { none: 'Not recorded', ready: 'Script ready', 'out-of-date': 'Out of date' };

/** The approved test cases: record the script, run it, download it, add assertions. */
export function AutomationPage() {
  const [cases, setCases] = useState<AutomationCase[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [project, setProject] = useState('');
  const [open, setOpen] = useState<{ key: string; panel: 'assertions' | 'script' }>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => {
    api.automation().then(setCases, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === 'job') load();
  });
  const active = cases?.some((c) => c.running);
  useEffect(() => {
    const t = setInterval(load, active ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, active]);

  const projects = useMemo(() => [...new Map((cases ?? []).map((c) => [c.projectId, c.projectName])).entries()], [cases]);
  if (error) return <ErrorNote error={error} />;
  if (!cases) return <p className="muted">Loading…</p>;
  const shown = cases.filter((c) => !project || c.projectId === project);
  const keyOf = (c: AutomationCase) => `${c.projectId}/${c.extId}`;

  const guard = async (c: AutomationCase, what: string, fn: () => Promise<void>) => {
    setBusy(`${keyOf(c)}:${what}`);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: '0.25rem' }}>
        <h1 className="grow" style={{ margin: 0 }}>
          Web Automation
        </h1>
        {projects.length > 1 && (
          <label className="row" style={{ gap: '0.5rem' }}>
            <span className="muted">Project</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="muted">
        The approved test cases. <strong>Record</strong> explores the application from the written steps and keeps the Playwright script.{' '}
        <strong>Execute</strong> runs it. <strong>Download</strong> gives you the script to run yourself. <strong>Assertions</strong> adds checks from the full
        list of validations.
      </p>
      <ErrorNote error={error} />
      {notice && <p className="notice">{notice}</p>}
      {!shown.length ? (
        <section className="panel">
          <p>
            No approved test cases yet. Open <Link to="/test-cases">Test Cases</Link> and approve the ones that are ready.
          </p>
        </section>
      ) : (
        <section className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Test case</th>
                <th>Script</th>
                <th>Last result</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const key = keyOf(c);
                const panel = open?.key === key ? open.panel : undefined;
                return (
                  <FragmentRow key={key}>
                    <tr>
                      <td>
                        <Link to={`/projects/${c.projectId}/cases/${encodeURIComponent(c.extId)}`}>
                          <strong>{c.extId}</strong>
                        </Link>
                        <span className="case-title">{c.title}</span>
                        <span className="muted">{c.projectName}</span>
                      </td>
                      <td>
                        <span className={`badge ${c.script === 'ready' ? 'PASS' : c.script === 'out-of-date' ? 'review' : 'job'}`}>
                          {SCRIPT_LABEL[c.script]}
                        </span>
                        {c.recordedAt && <div className="muted">{when(c.recordedAt)}</div>}
                        {c.running && <div className="muted">working…</div>}
                      </td>
                      <td>
                        {c.lastStatus ? <StatusBadge status={c.lastStatus} /> : <span className="muted">not run</span>}
                        {c.lastRunAt && <div className="muted">{when(c.lastRunAt)}</div>}
                      </td>
                      <td>
                        <div className="row" style={{ gap: '0.4rem' }}>
                          <button
                            type="button"
                            disabled={c.running || busy === `${key}:record`}
                            onClick={() =>
                              guard(c, 'record', async () => {
                                await api.recordCase(c.projectId, c.extId);
                                setNotice(`Recording ${c.extId}. It explores the application and keeps the script; this takes a minute.`);
                                load();
                              })
                            }
                          >
                            {c.script === 'none' ? 'Record' : 'Record again'}
                          </button>
                          <button
                            type="button"
                            className="primary"
                            disabled={c.running || busy === `${key}:run`}
                            onClick={() =>
                              guard(c, 'run', async () => {
                                const job = await api.runTestCase(c.projectId, c.extId);
                                navigate(`/jobs/${job.id}`);
                              })
                            }
                          >
                            Execute
                          </button>
                          {c.scriptReady ? (
                            <a href={`/api/projects/${c.projectId}/test-cases/${encodeURIComponent(c.extId)}/script`} download>
                              <button type="button">Download script</button>
                            </a>
                          ) : (
                            <button type="button" disabled title="Record the test case first">
                              Download script
                            </button>
                          )}
                          <button
                            type="button"
                            aria-expanded={panel === 'assertions'}
                            onClick={() => setOpen(panel === 'assertions' ? undefined : { key, panel: 'assertions' })}
                          >
                            Assertions
                          </button>
                          {c.scriptReady && (
                            <button
                              type="button"
                              aria-expanded={panel === 'script'}
                              onClick={() => setOpen(panel === 'script' ? undefined : { key, panel: 'script' })}
                            >
                              View script
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {panel && (
                      <tr>
                        <td colSpan={4} style={{ background: 'var(--sunk)' }}>
                          {panel === 'assertions' ? (
                            <AssertionPanel
                              c={c}
                              onChanged={() => {
                                setNotice(`${c.extId} changed. Record it again so the script includes the new check.`);
                                load();
                              }}
                            />
                          ) : (
                            <ScriptView projectId={c.projectId} extId={c.extId} />
                          )}
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function ScriptView({ projectId, extId }: { projectId: string; extId: string }) {
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.scriptPreview(projectId, extId).then(
      (r) => setFiles(r.files),
      (e: Error) => setError(e.message),
    );
  }, [projectId, extId]);
  if (error) return <ErrorNote error={error} />;
  if (!files) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      {files.map((f) => (
        <div key={f.name}>
          <strong>{f.name}</strong>
          <div className="codebox">{f.content}</div>
        </div>
      ))}
    </div>
  );
}

/** The checks of a test case, and every validation the platform knows to add another from. */
function AssertionPanel({ c, onChanged }: { c: AutomationCase; onChanged: () => void }) {
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>();
  const [family, setFamily] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<CatalogueEntry>();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.validations().then(setCatalogue, (e: Error) => setError(e.message));
  }, []);

  const lines = c.raw.expected.split(/\r?\n/).filter((l) => l.trim());
  const families = [...new Set((catalogue ?? []).map((v) => v.family))];
  const q = query.trim().toLowerCase();
  const list = (catalogue ?? []).filter(
    (v) => (!family || v.family === family) && (!q || `${v.id} ${v.title} ${v.type} ${v.examples.join(' ')}`.toLowerCase().includes(q)),
  );

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div>
        <strong>Checks in this test case ({lines.length})</strong>
        <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.2rem' }}>
          {lines.map((l) => (
            <li key={l}>
              {l}{' '}
              <button
                type="button"
                className="chip"
                disabled={busy || lines.length < 2}
                title={lines.length < 2 ? 'A test case needs at least one check' : 'Remove this check'}
                onClick={() => {
                  const { row: _row, ...raw } = c.raw;
                  void run(() => api.updateTestCase(c.projectId, c.extId, { ...raw, expected: lines.filter((x) => x !== l).join('\n') }));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="stack">
        <strong>Add an assertion</strong>
        <div className="row">
          <input
            aria-label="Search validations"
            placeholder="Search: title, text, url, table, cookie…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select aria-label="Family" value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="">All families ({catalogue?.length ?? 0})</option>
            {families.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="chips" style={{ maxHeight: '9rem', overflow: 'auto' }}>
          {list.map((v) => (
            <button
              key={v.id}
              type="button"
              className="chip"
              aria-pressed={picked?.id === v.id}
              style={picked?.id === v.id ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : undefined}
              onClick={() => {
                setPicked(v);
                setText(v.examples[0] ?? '');
              }}
            >
              {v.id.replace('VAL-', '')} · {v.title}
            </button>
          ))}
          {!list.length && <span className="muted">Nothing matches.</span>}
        </div>
        {picked && (
          <div className="stack">
            <div className="muted">
              {picked.family} · {picked.targets === 'none' ? 'checks the page' : picked.targets === 'one' ? 'checks one element' : 'compares two elements'}.
              {picked.examples.length
                ? ' Start from an example and change the names and values to your own:'
                : ' Write it the way you would in the Expected result.'}
            </div>
            <div className="chips">
              {picked.examples.map((ex) => (
                <button key={ex} type="button" className="chip" onClick={() => setText(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.addAssertion(c.projectId, c.extId, text);
              setText('');
              setPicked(undefined);
            });
          }}
        >
          <input
            className="grow"
            aria-label="Assertion sentence"
            placeholder='e.g. Page title is "Swag Labs"'
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || text.trim().length < 3}>
            Add assertion
          </button>
        </form>
        <ErrorNote error={error} />
      </div>
    </div>
  );
}
