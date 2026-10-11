import { useCallback, useEffect, useState } from 'react';
import { api, type Impact, type ProjectView, type ReleaseDetail, type ReleaseSummary } from '../api';
import { ErrorNote, when } from '../components/common';
import { ProjectSelect, useProjects } from '../components/ProjectSelect';

export function HealthBadge({ summary }: { summary: ReleaseSummary }) {
  const label = { ok: 'On track', watch: 'Watch', late: 'Late', done: 'Closed' }[summary.health.level];
  return (
    <span className={`health ${summary.health.level}`} title={summary.health.reason}>
      {label}
      <span className="muted" style={{ fontWeight: 400 }}>
        {' '}
        · {summary.health.reason}
      </span>
    </span>
  );
}

const today = () => new Date().toISOString().slice(0, 10);
const STATUS_LABEL = { planned: 'Planned', 'in-progress': 'In progress', released: 'Released', cancelled: 'Cancelled' } as const;

/** Releases of a project: scope, date and features. After the scope is locked, every added requirement says what it does to the date. */
export function ReleasesPage() {
  const { projects, current, error, choose } = useProjects();
  const [releases, setReleases] = useState<ReleaseDetail[]>();
  const [loadError, setLoadError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string>();

  const load = useCallback(() => {
    if (!current) return;
    api.releases(current.id).then(
      (r) => {
        setReleases(r);
        setLoadError(undefined);
      },
      (e: Error) => setLoadError(e.message),
    );
  }, [current]);
  useEffect(() => {
    setReleases(undefined);
    load();
  }, [load]);

  if (error) return <ErrorNote error={error} />;
  if (!projects) return <p className="muted">Loading…</p>;
  const replace = (r: ReleaseDetail) => setReleases((all) => all?.map((x) => (x.id === r.id ? r : x)));
  return (
    <>
      <div className="row" style={{ marginBottom: '0.25rem' }}>
        <h1 className="grow" style={{ margin: 0 }}>
          Releases
        </h1>
        <ProjectSelect projects={projects} value={current?.id} onChange={choose} />
        {current && !creating && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            New release
          </button>
        )}
      </div>
      <p className="muted">
        Enter the scope, the date and the features of a release. Lock the scope when work starts: from then on, a requirement you add asks for a reason, shows
        what it does to the date and the amount of work, and is kept in the change log.
      </p>
      <ErrorNote error={loadError} />
      {current && creating && (
        <NewRelease
          project={current}
          onCancel={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setOpenId(r.id);
            load();
          }}
        />
      )}
      {current && releases && !releases.length && !creating && (
        <section className="panel">
          <p>No releases for {current.name} yet.</p>
        </section>
      )}
      {current &&
        releases?.map((r) => (
          <ReleaseCard
            key={r.id}
            release={r}
            project={current}
            open={openId === r.id}
            onToggle={() => setOpenId(openId === r.id ? undefined : r.id)}
            onChange={replace}
            onDeleted={load}
          />
        ))}
    </>
  );
}

function NewRelease({ project, onCreated, onCancel }: { project: ProjectView; onCreated: (r: ReleaseDetail) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [scope, setScope] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [plannedDate, setPlannedDate] = useState('');
  const [teamSize, setTeamSize] = useState(1);
  const [features, setFeatures] = useState([{ key: 1, title: '', effortDays: 1 }]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onCreated(
        await api.createRelease(project.id, {
          name,
          version,
          scope,
          teamSize,
          startDate: startDate || undefined,
          plannedDate,
          features: features.filter((f) => f.title.trim()).map((f) => ({ title: f.title, effortDays: f.effortDays, caseIds: [] })),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>New release</h2>
      <div className="grid2">
        <label className="field">
          <span>Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring release" />
        </label>
        <label className="field">
          <span>Version</span>
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="2.4.0" />
        </label>
        <label className="field">
          <span>Start date</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Release date</span>
          <input required type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} />
        </label>
        <label className="field">
          <span>People working on it</span>
          <input type="number" min={1} value={teamSize} onChange={(e) => setTeamSize(Math.max(1, Number(e.target.value) || 1))} />
        </label>
      </div>
      <label className="field">
        <span>Scope</span>
        <textarea value={scope} onChange={(e) => setScope(e.target.value)} placeholder="What this release is for, and what it leaves out." />
      </label>
      <fieldset className="panel" style={{ margin: 0 }}>
        <legend>Features</legend>
        <p className="muted" style={{ marginTop: 0 }}>
          The effort is in working days. Test cases are linked to a feature after the release is created.
        </p>
        {features.map((f, i) => (
          <div className="row" key={f.key} style={{ marginBottom: '0.5rem' }}>
            <input
              className="grow"
              aria-label={`Feature ${i + 1}`}
              placeholder="Feature"
              value={f.title}
              onChange={(e) => setFeatures(features.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
            />
            <input
              aria-label={`Effort of feature ${i + 1}, in days`}
              type="number"
              min={0}
              step={0.5}
              style={{ width: '6rem' }}
              value={f.effortDays}
              onChange={(e) => setFeatures(features.map((x, j) => (j === i ? { ...x, effortDays: Number(e.target.value) || 0 } : x)))}
            />
            <span className="muted">days</span>
            <button type="button" onClick={() => setFeatures(features.filter((_, j) => j !== i))} aria-label={`Remove feature ${i + 1}`}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setFeatures([...features, { key: Math.max(0, ...features.map((x) => x.key)) + 1, title: '', effortDays: 1 }])}>
          Add a feature
        </button>
      </fieldset>
      <ErrorNote error={error} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Create release'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const Stat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <div className="tile">
    <div className="num" style={{ fontSize: '1.3rem' }}>
      {value}
    </div>
    <div className="label">{label}</div>
    {sub && <div className="label">{sub}</div>}
  </div>
);

function ReleaseCard(props: {
  release: ReleaseDetail;
  project: ProjectView;
  open: boolean;
  onToggle: () => void;
  onChange: (r: ReleaseDetail) => void;
  onDeleted: () => void;
}) {
  const { release: r, project } = props;
  const s = r.summary;
  const [error, setError] = useState<string>();
  const act = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const apply = async (fn: () => Promise<ReleaseDetail>) => {
    const next = await act(fn);
    if (next) props.onChange(next);
  };

  return (
    <section className="panel stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {r.name} {r.version && <span className="muted">{r.version}</span>}
        </h2>
        <HealthBadge summary={s} />
        <button type="button" aria-expanded={props.open} onClick={props.onToggle}>
          {props.open ? 'Hide details' : 'Open'}
        </button>
      </div>
      <div className="tiles" style={{ margin: 0 }}>
        <Stat
          label="Release date"
          value={r.dueDate}
          sub={s.slipDays ? `planned ${r.baselineDate} (${s.slipDays > 0 ? '+' : ''}${s.slipDays} days)` : 'as planned'}
        />
        <Stat label="Time left" value={s.daysLeft >= 0 ? `${s.daysLeft} days` : `${-s.daysLeft} days over`} />
        <Stat
          label="Work in scope"
          value={`${s.currentEffortDays} days`}
          sub={
            s.addedFeatures || s.removedFeatures
              ? `baseline ${s.baselineEffortDays} (${s.scopeGrowthPercent > 0 ? '+' : ''}${s.scopeGrowthPercent}%)`
              : undefined
          }
        />
        <Stat
          label="Features"
          value={`${s.doneFeatures}/${s.baselineFeatures + s.addedFeatures} done`}
          sub={s.addedFeatures ? `${s.addedFeatures} added after lock` : undefined}
        />
        <Stat label="Test coverage" value={`${s.coveragePercent}%`} sub={`${s.cases.pass} pass · ${s.cases.fail} fail · ${s.cases.notRun} not run`} />
      </div>
      <ErrorNote error={error} />
      {props.open && (
        <>
          {r.scope && <p style={{ whiteSpace: 'pre-line', margin: 0 }}>{r.scope}</p>}
          <div className="row">
            <label className="row" style={{ gap: '0.4rem' }}>
              <span className="muted">Status</span>
              <select
                value={r.status}
                onChange={(e) => void apply(() => api.updateRelease(project.id, r.id, { status: e.target.value as ReleaseDetail['status'] }))}
              >
                {Object.entries(STATUS_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {!r.baselinedAt ? (
              <button type="button" onClick={() => void apply(() => api.lockRelease(project.id, r.id))}>
                Lock the scope
              </button>
            ) : (
              <span className="muted">Scope locked {when(r.baselinedAt)}</span>
            )}
            <button
              type="button"
              className="danger"
              onClick={async () => {
                if (!confirm(`Delete the release ${r.name}?`)) return;
                if (await act(() => api.deleteRelease(project.id, r.id))) props.onDeleted();
              }}
            >
              Delete
            </button>
          </div>
          {!r.baselinedAt && (
            <p className="notice">
              The scope is not locked: features and the date can still be changed freely. Lock it (or set the status to In progress) when work starts, so later
              changes are tracked.
            </p>
          )}
          <Features release={r} project={project} act={apply} />
          <AddRequirement release={r} project={project} onAdded={props.onChange} />
          <MoveDate release={r} project={project} act={apply} />
          <ChangeLog release={r} />
        </>
      )}
    </section>
  );
}

function Features({ release: r, project, act }: { release: ReleaseDetail; project: ProjectView; act: (fn: () => Promise<ReleaseDetail>) => Promise<void> }) {
  const title = (id: string) => r.cases.find((c) => c.extId === id)?.title ?? id;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Feature</th>
            <th>Effort</th>
            <th>Status</th>
            <th>Test cases</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {r.features.map((f) => (
            <tr key={f.id} style={f.removed ? { opacity: 0.55 } : undefined}>
              <td>
                {f.removed ? <s>{f.title}</s> : f.title}
                {f.addedAfterBaseline && <span className="badge review">added after lock</span>}
                {f.removed && <span className="badge job">removed</span>}
                {f.requirementId && <div className="muted">{f.requirementId}</div>}
                {f.description && <div className="muted">{f.description}</div>}
              </td>
              <td>{f.effortDays} d</td>
              <td>
                {f.removed ? (
                  '—'
                ) : (
                  <select
                    aria-label={`Status of ${f.title}`}
                    value={f.status}
                    onChange={(e) => void act(() => api.updateFeature(project.id, r.id, f.id, { status: e.target.value as typeof f.status }))}
                  >
                    <option value="planned">Planned</option>
                    <option value="in-progress">In progress</option>
                    <option value="done">Done</option>
                  </select>
                )}
              </td>
              <td>
                <div className="chips">
                  {f.caseIds.map((id) => (
                    <span key={id} className="badge job" title={title(id)}>
                      {id}
                      {!f.removed && (
                        <button
                          type="button"
                          aria-label={`Unlink ${id}`}
                          style={{ border: 0, background: 'none', padding: '0 0 0 0.3rem', cursor: 'pointer', color: 'inherit' }}
                          onClick={() => void act(() => api.updateFeature(project.id, r.id, f.id, { caseIds: f.caseIds.filter((x) => x !== id) }))}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {!f.removed && (
                    <select
                      aria-label={`Link a test case to ${f.title}`}
                      value=""
                      onChange={(e) => e.target.value && void act(() => api.updateFeature(project.id, r.id, f.id, { caseIds: [...f.caseIds, e.target.value] }))}
                    >
                      <option value="">+ link</option>
                      {r.cases
                        .filter((c) => !f.caseIds.includes(c.extId))
                        .map((c) => (
                          <option key={c.extId} value={c.extId}>
                            {c.extId} · {c.title}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
                {!f.removed && !f.caseIds.length && <span className="muted">none yet: not covered</span>}
              </td>
              <td>
                {!f.removed && (
                  <button
                    type="button"
                    onClick={() => {
                      let reason = '';
                      if (r.baselinedAt) {
                        reason = prompt(`Why is "${f.title}" taken out of this release?`)?.trim() ?? '';
                        if (!reason) return;
                      }
                      void act(() => api.removeFeature(project.id, r.id, f.id, { reason }));
                    }}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!r.features.length && (
            <tr>
              <td colSpan={5} className="muted">
                No features yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A new requirement. When the scope is locked it shows the date the extra work suggests, and the tester decides the new date. */
function AddRequirement({ release: r, project, onAdded }: { release: ReleaseDetail; project: ProjectView; onAdded: (r: ReleaseDetail) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [requirementId, setRequirementId] = useState('');
  const [effortDays, setEffortDays] = useState(1);
  const [reason, setReason] = useState('');
  const [newDate, setNewDate] = useState('');
  const [dateTouched, setDateTouched] = useState(false);
  const [caseIds, setCaseIds] = useState<string[]>([]);
  const [impact, setImpact] = useState<Impact>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const locked = !!r.baselinedAt;

  // The date is a dependency on purpose: the suggestion is worked out from it, so it must be fetched again when it moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!locked) return;
    let stale = false;
    api.releaseImpact(project.id, r.id, effortDays).then(
      (i) => {
        if (stale) return;
        setImpact(i);
        if (!dateTouched) setNewDate(i.suggestedDate);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [locked, project.id, r.id, r.dueDate, effortDays, dateTouched]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { release } = await api.addFeature(project.id, r.id, {
        title,
        description,
        requirementId: requirementId || undefined,
        effortDays,
        caseIds,
        reason: locked ? reason : undefined,
        newDate: locked ? newDate : undefined,
      });
      onAdded(release);
      setTitle('');
      setDescription('');
      setRequirementId('');
      setReason('');
      setCaseIds([]);
      setDateTouched(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel stack" style={{ margin: 0 }} onSubmit={submit}>
      <h3>{locked ? 'Add a requirement to this release' : 'Add a feature'}</h3>
      <div className="grid2">
        <label className="field">
          <span>Title</span>
          <input required value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Requirement ID (optional)</span>
          <input value={requirementId} onChange={(e) => setRequirementId(e.target.value)} placeholder="REQ-142" />
        </label>
        <label className="field">
          <span>Effort (working days)</span>
          <input type="number" min={0} step={0.5} value={effortDays} onChange={(e) => setEffortDays(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label className="field">
          <span>Test cases that cover it</span>
          <select
            multiple
            size={Math.min(4, Math.max(2, r.cases.length))}
            value={caseIds}
            onChange={(e) => setCaseIds([...e.target.selectedOptions].map((o) => o.value))}
          >
            {r.cases.map((c) => (
              <option key={c.extId} value={c.extId}>
                {c.extId} · {c.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {locked && impact && (
        <div className="notice warn" role="status">
          <strong>Effect of this requirement</strong>
          <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.2rem' }}>
            <li>
              {effortDays} day(s) of work shared by {impact.teamSize} person(s) moves the date from <strong>{impact.dueDate}</strong> to{' '}
              <strong>{impact.suggestedDate}</strong> ({impact.extraCalendarDays} calendar day(s) later, weekends skipped).
            </li>
            <li>
              The work in scope becomes {impact.effortDaysAfter} days, {impact.scopeGrowthPercentAfter}% more than the baseline.
            </li>
            <li>{caseIds.length ? `${caseIds.length} test case(s) cover it.` : 'No test case covers it yet: write one, or the new work is untested.'}</li>
          </ul>
        </div>
      )}
      {locked && (
        <div className="grid2">
          <label className="field">
            <span>New release date</span>
            <input
              required
              type="date"
              value={newDate}
              onChange={(e) => {
                setNewDate(e.target.value);
                setDateTouched(true);
              }}
            />
          </label>
          <label className="field">
            <span>Why is it added?</span>
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Asked for by the customer in the review" />
          </label>
        </div>
      )}
      <ErrorNote error={error} />
      <div>
        <button type="submit" className="primary" disabled={busy}>
          {locked ? 'Add requirement and update the date' : 'Add feature'}
        </button>
      </div>
    </form>
  );
}

function MoveDate({ release: r, project, act }: { release: ReleaseDetail; project: ProjectView; act: (fn: () => Promise<ReleaseDetail>) => Promise<void> }) {
  const [date, setDate] = useState(r.dueDate);
  const [reason, setReason] = useState('');
  useEffect(() => setDate(r.dueDate), [r.dueDate]);
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        void act(() => api.moveRelease(project.id, r.id, date, reason)).then(() => setReason(''));
      }}
    >
      <label className="row" style={{ gap: '0.4rem' }}>
        <span className="muted">Move the date to</span>
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <input
        className="grow"
        aria-label="Reason for moving the date"
        placeholder={r.baselinedAt ? 'Reason (required once locked)' : 'Reason (optional)'}
        required={!!r.baselinedAt}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="submit" disabled={date === r.dueDate}>
        Move date
      </button>
    </form>
  );
}

function ChangeLog({ release: r }: { release: ReleaseDetail }) {
  if (!r.changes.length) return <p className="muted">No changes since the scope was locked.</p>;
  return (
    <div>
      <h3>Change log</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Change</th>
              <th>Reason</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {[...r.changes].reverse().map((c) => (
              <tr key={c.id}>
                <td>{when(c.at)}</td>
                <td>{c.summary}</td>
                <td>{c.reason}</td>
                <td>{c.oldDate && c.newDate && c.oldDate !== c.newDate ? `${c.oldDate} → ${c.newDate}` : (c.newDate ?? '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
