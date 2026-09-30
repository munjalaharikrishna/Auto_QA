import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BatchSummary, fileUrl, type JobDetail, type Question, type RawTestCase, type Review, resultsUrl, type TestVerdict } from '../api';
import { CaseForm, Diff, duration, ErrorNote, JobBadge, StatusBadge, when } from '../components/common';
import { PickElement, type ViewElement } from '../components/PickElement';
import { useServerEvents } from '../events';
import { Link, navigate } from '../router';

export function JobPage({ id }: { id: string }) {
  const [job, setJob] = useState<JobDetail>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.job(id).then(setJob, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === 'log' && e.jobId === id) setJob((j) => j && { ...j, logs: [...j.logs, { at: e.at, message: e.message }] });
    else if ((e.type === 'job' && e.job.id === id) || (e.type === 'question' && e.question.jobId === id) || (e.type === 'answered' && e.jobId === id)) load();
  });

  if (error) return <ErrorNote error={error} />;
  if (!job) return <p className="muted">Loading…</p>;
  const active = ['queued', 'running', 'waiting', 'review'].includes(job.status);
  const summary = job.output.summary as BatchSummary | undefined;
  const title =
    job.kind === 'workbook'
      ? `Workbook: ${String(job.input.originalName ?? '')}${job.input.onlyReview ? ' — review queue' : ''}`
      : String((job.input.case as RawTestCase | undefined)?.title ?? 'Test case');

  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        <Link to={`/projects/${job.projectId}?tab=runs`}>{job.projectId}</Link> / {job.executionId ?? job.id}
      </p>
      <div className="row" style={{ margin: '0.25rem 0 1rem' }}>
        <h1 className="grow" style={{ margin: 0 }}>
          {title}
        </h1>
        <JobBadge status={job.status} />
        {active && (
          <button type="button" className="danger" onClick={() => void api.cancel(job.id)}>
            Cancel
          </button>
        )}
      </div>
      {job.status === 'failed' && <ErrorNote error={job.error} />}

      {job.questions.map((q) => (
        <QuestionPanel key={q.id} question={q} />
      ))}
      {job.status === 'review' && job.output.review ? <ReviewPanel job={job} review={job.output.review as Review} /> : null}
      {job.status === 'done' && <ResultsPanel job={job} summary={summary} />}

      <section className="panel">
        <h2>Progress</h2>
        <div className="log" aria-live="polite">
          {job.logs.length ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows at the end; lines can repeat
            job.logs.map((l, i) => <div key={i}>{l.message}</div>)
          ) : (
            <span className="muted">Waiting to start…</span>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Started {when(job.startedAt ?? job.createdAt)}
          {job.finishedAt && ` · finished ${when(job.finishedAt)}`}
        </p>
      </section>
    </>
  );
}

/** A question exploration cannot answer by rule; the browser waits for it (D6, FR-RV-02). */
function QuestionPanel({ question }: { question: Question }) {
  const p = question.payload as {
    item: string;
    raw?: string;
    code: string;
    text: string;
    page?: string;
    candidates?: Array<{ ref?: string; role: string; name: string; score: number; notes: string[] }>;
    view?: { screenshot: string; width: number; height: number; elements: ViewElement[] };
  };
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const send = async (answer: unknown) => {
    setBusy(true);
    await api.answer(question.id, answer).catch(() => setBusy(false));
  };

  return (
    <section className="panel stack" style={{ borderColor: '#e0a100' }}>
      <h2>
        {p.item}
        {p.raw ? `: ${p.raw}` : ''}
      </h2>
      <p className="notice warn" style={{ margin: 0 }}>
        {p.text}
      </p>
      {question.kind === 'choose' && (
        <>
          {p.view && <PickElement view={p.view} busy={busy} onPick={(ref) => void send({ ref })} />}
          {!!p.candidates?.length && (
            <div>
              <h3>Or choose a match</h3>
              <div className="row">
                {p.candidates.map((c, i) => (
                  <button type="button" key={c.ref ?? i} disabled={busy} onClick={() => void send(i)}>
                    {i + 1}. {c.role} "{c.name}" ({c.score.toFixed(2)})
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void send('skip')}>
              Skip this step
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void send('abort')}>
              Stop exploring
            </button>
          </div>
        </>
      )}
      {question.kind === 'pageUrl' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void send(url);
          }}
        >
          <input
            required
            className="grow"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="/profile or https://…"
            aria-label={`URL of the ${p.page} page`}
          />
          <button type="submit" className="primary" disabled={busy}>
            Use this URL
          </button>
          <button type="button" disabled={busy} onClick={() => void send('abort')}>
            Stop
          </button>
        </form>
      )}
      {question.kind === 'confirm' && (
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void send(true)}>
            Yes, continue
          </button>
          <button type="button" disabled={busy} onClick={() => void send(false)}>
            No, stop
          </button>
        </div>
      )}
    </section>
  );
}

/** The plan before it runs: steps, locators, scores, screenshots, code (FR-RV-01, FR-RV-03, FR-RV-04, FR-RV-05). */
function ReviewPanel({ job, review }: { job: JobDetail; review: Review }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<string>();
  const [open, setOpen] = useState<string | undefined>(review.changes.find((c) => c.path.startsWith('tests/'))?.path);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn().catch(() => setBusy(false));
  };

  if (editing) {
    return (
      <section className="panel">
        <h2>Edit the test case</h2>
        <p className="muted">Your changes go into the test case itself; it is explored again (FR-RV-05).</p>
        <CaseForm
          initial={job.input.case as RawTestCase}
          submitLabel="Save and explore again"
          onSubmit={(c) => api.edit(job.id, c).then(() => setEditing(false))}
          onCancel={() => setEditing(false)}
        />
      </section>
    );
  }
  return (
    <section className="panel stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          Review {review.testId}
        </h2>
        <button type="button" className="primary" disabled={busy || !!review.blocked} onClick={() => void act(() => api.approve(job.id))}>
          Approve &amp; Execute
        </button>
        <button type="button" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" disabled={busy} onClick={() => void act(() => api.regenerate(job.id))}>
          Regenerate
        </button>
      </div>
      {review.blocked && (
        <p className="notice warn">
          <StatusBadge status={review.blocked.status} /> {review.blocked.reason} Edit the test case or regenerate.
        </p>
      )}
      {!!review.warnings.length && <p className="notice warn">{review.warnings.map((w) => `${w.at ? `${w.at} ` : ''}${w.text}`).join(' ')}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>As written</th>
              <th>Locator</th>
              <th>Score</th>
              <th>Page</th>
              <th>Screenshot</th>
            </tr>
          </thead>
          <tbody>
            {review.items.map((i) => (
              <tr key={`${i.phase}-${i.id}`}>
                <td>
                  {i.phase === 'setup' ? 'login ' : ''}
                  {i.id} {i.status !== 'done' && <StatusBadge status={i.status === 'skipped' ? 'NEEDS REVIEW' : 'FAIL'} />}
                </td>
                <td>
                  {i.raw || <span className="muted">No crash (health check)</span>}
                  {i.effect && <div className="muted">→ {i.effect}</div>}
                  {i.warnings.map((w) => (
                    <div key={w} className="muted">
                      ! {w}
                    </div>
                  ))}
                </td>
                <td>
                  {i.locator ? (
                    <>
                      <code>{i.locator.code}</code>
                      <div className="muted">
                        {i.locator.strategy}
                        {i.locator.validated ? ', validated' : ', NOT validated'}
                        {i.resolvedBy === 'tester' ? ', picked by you' : ''}
                      </div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{i.score !== undefined ? i.score.toFixed(2) : ''}</td>
                <td>{i.page ?? ''}</td>
                <td>
                  {i.screenshot && (
                    <button type="button" className="thumb-button" onClick={() => setZoom(i.screenshot)} aria-label={`Screenshot after ${i.id}, full size`}>
                      <img className="thumb" src={fileUrl(i.screenshot)} alt="" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Generated code</h3>
      {review.changes.length ? (
        review.changes.map((c) => (
          <details key={c.path} open={open === c.path} onToggle={(e) => (e.currentTarget.open ? setOpen(c.path) : open === c.path && setOpen(undefined))}>
            <summary>
              <code>{c.path}</code> {c.added ? '(new)' : '(changed)'}
            </summary>
            <Diff patch={c.patch} />
          </details>
        ))
      ) : (
        <p className="muted">No code changed since the last generation.</p>
      )}
      {zoom && <ZoomDialog file={zoom} onClose={() => setZoom(undefined)} />}
    </section>
  );
}

/** A screenshot full size, as a modal: focus moves into it and Esc closes it. */
function ZoomDialog({ file, onClose }: { file: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="zoom" onClose={onClose}>
      <img src={fileUrl(file)} alt="Screenshot, full size" />
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button type="button" onClick={() => ref.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}

/** PASS / FAIL with expected vs actual for every case (FR-HI-01, FR-VAL-01). */
function ResultsPanel({ job, summary }: { job: JobDetail; summary?: BatchSummary }) {
  const [expanded, setExpanded] = useState<string>();
  const review = summary?.review ?? [];
  return (
    <section className="panel stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          Results {job.executionId && <span className="muted">{job.executionId}</span>}
        </h2>
        {job.kind === 'workbook' && (
          <a href={resultsUrl(job.id)} download>
            <button type="button" className="primary">
              Download results workbook
            </button>
          </a>
        )}
        {job.kind === 'workbook' && review.length > 0 && (
          <button
            type="button"
            onClick={async () => {
              const next = await api.reviewQueue(job.id);
              navigate(`/jobs/${next.id}`);
            }}
          >
            Answer the review queue ({review.length})
          </button>
        )}
      </div>
      {summary && (
        <div className="tiles">
          {(['PASS', 'FAIL', 'BLOCKED', 'NEEDS REVIEW'] as const).map((s) => (
            <div key={s} className={`tile badge ${s === 'NEEDS REVIEW' ? 'NEEDS' : s}`} style={{ borderRadius: 8, textAlign: 'left' }}>
              <strong>{summary.totals[s]}</strong>
              {s.toLowerCase()}
            </div>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {job.kind === 'workbook' && <th>Row</th>}
              <th>Test case</th>
              <th>Status</th>
              <th>Actual result</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {job.verdicts.map(({ testId, row, status, verdict: v }) => (
              <VerdictRow
                key={`${row}-${testId}`}
                testId={testId}
                row={job.kind === 'workbook' ? row : undefined}
                status={status}
                v={v}
                open={expanded === testId}
                toggle={() => setExpanded(expanded === testId ? undefined : testId)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function VerdictRow(props: { testId: string; row?: number; status: string; v: TestVerdict & { problem?: string }; open: boolean; toggle: () => void }) {
  const { v } = props;
  const shot = v.evidence?.screenshots?.[0];
  return (
    <>
      <tr>
        {props.row !== undefined && <td>{props.row}</td>}
        <td>
          <button type="button" onClick={props.toggle} aria-expanded={props.open} style={{ padding: '0.1rem 0.4rem', marginRight: '0.4rem' }}>
            {props.open ? '−' : '+'}
          </button>
          <strong>{props.testId}</strong>
          <span className="case-title">{v.title}</span>
        </td>
        <td>
          <StatusBadge status={props.status} />
          {v.category && <div className="muted">{v.category}</div>}
        </td>
        <td>
          {v.actual ?? (v.problem ? `Not run: ${v.problem}` : '')}
          {v.status !== 'PASS' && v.reason && !v.actual?.includes(v.reason) && <div className="muted">{v.reason}</div>}
        </td>
        <td>
          {shot && (
            <a href={fileUrl(shot)} target="_blank" rel="noreferrer">
              Screenshot
            </a>
          )}
          <div className="muted">{duration(v.durationMs)}</div>
        </td>
      </tr>
      {props.open && (
        <tr>
          <td colSpan={5}>
            {v.steps && (
              <table>
                <tbody>
                  {v.steps.map((s) => (
                    <tr key={s.id}>
                      <td style={{ width: '3rem' }}>{s.id}</td>
                      <td>{s.raw}</td>
                      <td>{s.result}</td>
                    </tr>
                  ))}
                  {v.checks?.map((c) => (
                    <tr key={c.id}>
                      <td>{c.id}</td>
                      <td>
                        <div>
                          <strong>Expected:</strong> {c.expected}
                        </div>
                        {c.actual && (
                          <div>
                            <strong>Actual:</strong> {c.actual}
                          </div>
                        )}
                      </td>
                      <td>{c.result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
