import { useCallback, useEffect, useState } from 'react';
import { api, type Field, type Job, type Preview, type ProjectView, type TestCaseRecord } from '../api';
import { CaseForm, ErrorNote, JobBadge, ProjectForm, StatusBadge, when } from '../components/common';
import { useServerEvents } from '../events';
import { Link, navigate } from '../router';

type Tab = 'workbook' | 'single' | 'cases' | 'runs' | 'settings';
const TABS: Array<[Tab, string]> = [
  ['workbook', 'Run a workbook'],
  ['single', 'Single test case'],
  ['cases', 'Test cases'],
  ['runs', 'Runs'],
  ['settings', 'Settings'],
];

export function ProjectPage({ id }: { id: string }) {
  const [project, setProject] = useState<ProjectView>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') as Tab) || 'workbook');

  useEffect(() => {
    api.project(id).then(setProject, (e: Error) => setError(e.message));
  }, [id]);

  if (error) return <ErrorNote error={error} />;
  if (!project) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/">Projects</Link> /
      </p>
      <h1>{project.name}</h1>
      <p className="muted">
        {project.baseUrl} · Chromium · test ids: <code>{project.testIdAttribute}</code>
        {!project.env.hasPassword && ' · no password set: tests that log in will be blocked'}
      </p>
      <div className="tabs" role="tablist">
        {TABS.map(([t, label]) => (
          <button type="button" key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'workbook' && <WorkbookTab project={project} />}
      {tab === 'single' && (
        <section className="panel">
          <h2>Single test case</h2>
          <p className="muted">The platform explores it, shows you the steps, locators and code, and runs it after you approve.</p>
          <CaseForm
            submitLabel="Generate"
            onSubmit={async (c) => {
              const job = await api.submitCase(project.id, c);
              navigate(`/jobs/${job.id}`);
            }}
          />
        </section>
      )}
      {tab === 'cases' && <TestCasesTab project={project} />}
      {tab === 'runs' && <RunsTab project={project} />}
      {tab === 'settings' && (
        <section className="panel">
          <h2>Settings</h2>
          <ProjectForm
            initial={project}
            submitLabel="Save settings"
            onSubmit={async (p) => {
              setProject(await api.updateProject(project.id, p));
            }}
          />
        </section>
      )}
    </>
  );
}

const FIELD_LABEL: Record<Field, string> = {
  id: 'Test case ID',
  title: 'Title',
  type: 'Type',
  preconditions: 'Preconditions',
  steps: 'Steps',
  testData: 'Test data',
  expected: 'Expected result',
  requirementId: 'Requirement ID',
};
const REQUIRED: Field[] = ['title', 'steps', 'expected'];

/** Upload → column mapping with a preview (FR-IN-02) → run the whole workbook (FR-IN-08). */
function WorkbookTab({ project }: { project: ProjectView }) {
  const [preview, setPreview] = useState<Preview>();
  const [mapping, setMapping] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [over, setOver] = useState(false);

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const p = await api.upload(project.id, file);
      setPreview(p);
      setMapping(p.mapping ?? {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remap = async (field: Field, header: string) => {
    if (!preview) return;
    const next = { ...mapping, [field]: header };
    if (!header) delete next[field];
    setMapping(next);
    setPreview(await api.preview(preview.uploadId, next));
  };

  const headerOf = (field: Field) => {
    const col = preview?.columns?.[field];
    return mapping[field] ?? (col ? preview?.headers?.[col - 1] : '') ?? '';
  };

  return (
    <div className="stack">
      <section className="panel">
        <h2>1. Upload the workbook</h2>
        <label
          className={`dropzone ${over ? 'over' : ''}`}
          style={{ display: 'block', cursor: 'pointer' }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void upload(e.dataTransfer.files[0]);
          }}
        >
          <strong>{busy ? 'Reading…' : 'Drop an .xlsx or .csv file here, or choose one'}</strong>
          <br />
          <span className="muted">Your file is never changed: results go into a copy.</span>
          <input
            type="file"
            accept=".xlsx,.xlsm,.csv"
            style={{ display: 'block', margin: '1rem auto 0', maxWidth: 320 }}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </label>
        <ErrorNote error={error} />
      </section>

      {preview && (
        <section className="panel stack">
          <h2>2. Check the columns</h2>
          {preview.ok ? (
            <p>
              <strong>{preview.fileName}</strong>, sheet "{preview.sheet}", headers on row {preview.headerRow}: <strong>{preview.total}</strong> test case(s).
            </p>
          ) : (
            <ErrorNote error={preview.error} />
          )}
          <div className="grid2">
            {preview.fields.map((f) => (
              <label className="field" key={f}>
                <span>
                  {FIELD_LABEL[f]}
                  {REQUIRED.includes(f) ? ' *' : ''}
                </span>
                <select value={headerOf(f)} onChange={(e) => void remap(f, e.target.value)}>
                  <option value="">— not in this sheet —</option>
                  {(preview.headers ?? []).filter(Boolean).map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {Object.keys(mapping).length > 0 && (
            <p className="muted">
              Using the columns you chose last time for:{' '}
              {Object.keys(mapping)
                .map((f) => FIELD_LABEL[f as Field])
                .join(', ')}
              .
            </p>
          )}
          {!!preview.unmatched?.length && <p className="muted">Kept as they are: {preview.unmatched.join(', ')}.</p>}
          {!!preview.warnings?.length && <p className="notice warn">{preview.warnings.join(' ')}</p>}
          {!!preview.problems?.length && (
            <div className="notice warn">
              {preview.problems.length} row(s) are not complete test cases and will be marked NEEDS REVIEW:
              <ul>
                {preview.problems.slice(0, 5).map((p) => (
                  <li key={p.row}>{p.text}</li>
                ))}
              </ul>
            </div>
          )}
          {!!preview.sample?.length && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>ID</th>
                    <th>Title</th>
                    <th>Steps</th>
                    <th>Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((c) => (
                    <tr key={c.row}>
                      <td>{c.row}</td>
                      <td>{c.id}</td>
                      <td>{c.title}</td>
                      <td style={{ whiteSpace: 'pre-line' }}>{c.steps}</td>
                      <td>{c.expected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={!preview.ok || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const job = await api.runUpload(preview.uploadId, mapping);
                  navigate(`/jobs/${job.id}`);
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              Run all {preview.total ?? ''} test cases
            </button>
            <span className="muted">Runs unattended: cases that need you are set aside for the review queue.</span>
          </div>
        </section>
      )}
    </div>
  );
}

/** Every test case written or imported, with its last result and Run again (item 1, item 3). */
function TestCasesTab({ project }: { project: ProjectView }) {
  const [cases, setCases] = useState<TestCaseRecord[]>();
  const [error, setError] = useState<string>();
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

  if (error) return <ErrorNote error={error} />;
  if (!cases) return <p className="muted">Loading…</p>;
  if (!cases.length) return <p className="muted">No test cases yet. Write one in "Single test case" or upload a workbook.</p>;
  return (
    <section className="panel table-wrap">
      <table>
        <thead>
          <tr>
            <th>Test case</th>
            <th>Steps</th>
            <th>Last result</th>
            <th>Last run</th>
            <th>Runs</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/projects/${project.id}/cases/${encodeURIComponent(c.extId)}`}>
                  <strong>{c.extId}</strong>
                </Link>
                <span className="case-title">{c.title}</span>
              </td>
              <td>{c.raw.steps.split(/\r?\n/).filter(Boolean).length}</td>
              <td>{c.lastStatus ? <StatusBadge status={c.lastStatus} /> : <span className="muted">not run</span>}</td>
              <td>{when(c.lastRunAt)}</td>
              <td>{c.runCount}</td>
              <td>
                <button
                  type="button"
                  className="primary"
                  onClick={async () => {
                    const job = await api.runTestCase(project.id, c.extId);
                    navigate(`/jobs/${job.id}`);
                  }}
                >
                  Run again
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const STAGE: Record<string, string> = {
  queued: 'waiting to start',
  running: 'running',
  waiting: 'waiting for your answer',
  review: 'waiting for your review',
};

/** Run history (FR-HI-01; the full history list is FR-HI-02, V2). */
function RunsTab({ project }: { project: ProjectView }) {
  const [jobs, setJobs] = useState<Job[]>();
  const load = useCallback(() => {
    api.jobs(project.id).then(setJobs, () => {});
  }, [project.id]);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === 'job' && e.job.projectId === project.id) load();
  });
  // Without a live connection the list still catches up while a run is going.
  const active = jobs?.some((j) => ['queued', 'running', 'waiting', 'review'].includes(j.status));
  useEffect(() => {
    const t = setInterval(load, active ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, active]);
  if (!jobs) return <p className="muted">Loading…</p>;
  if (!jobs.length) return <p className="muted">No runs yet.</p>;
  return (
    <section className="panel table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>What</th>
            <th>Status</th>
            <th>Result</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const totals = (j.output.summary as { totals?: Record<string, number> } | undefined)?.totals;
            const verdicts = j.output.verdicts as Array<{ status: string }> | undefined;
            const blocked = (j.output.review as { blocked?: unknown } | undefined)?.blocked;
            const theCase = j.input.case as { id?: string; title?: string } | undefined;
            const from = j.output.cancelledFrom as string | undefined;
            return (
              <tr key={j.id}>
                <td>
                  <Link to={`/jobs/${j.id}`}>{j.executionId ?? j.id}</Link>
                </td>
                <td>
                  {j.kind === 'workbook' ? (
                    `Workbook ${String(j.input.originalName ?? '')}${j.input.onlyReview ? ' (review queue)' : ''}`
                  ) : theCase?.id ? (
                    <Link to={`/projects/${project.id}/cases/${encodeURIComponent(theCase.id)}`}>{theCase.title ?? theCase.id}</Link>
                  ) : (
                    'Test'
                  )}
                  {j.input.rerun === true && <span className="muted"> · run again</span>}
                </td>
                <td>
                  <JobBadge status={j.status} />
                  {j.status === 'cancelled' && from && STAGE[from] && <div className="muted">while {STAGE[from]}</div>}
                </td>
                <td>
                  {totals ? (
                    `${totals.PASS} pass · ${totals.FAIL} fail · ${totals.BLOCKED} blocked · ${totals['NEEDS REVIEW']} review`
                  ) : verdicts?.length ? (
                    [...new Set(verdicts.map((v) => v.status))].map((status) => <StatusBadge key={status} status={status} />)
                  ) : j.status === 'review' || j.status === 'waiting' ? (
                    <span className="muted">{blocked ? 'Cannot run yet: open it to see why' : `Open it: ${STAGE[j.status]}`}</span>
                  ) : j.status === 'failed' ? (
                    <span className="muted">{j.error}</span>
                  ) : j.status === 'cancelled' ? (
                    <span className="muted">No result: it was stopped before the test ran</span>
                  ) : (
                    ''
                  )}
                </td>
                <td>{when(j.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
