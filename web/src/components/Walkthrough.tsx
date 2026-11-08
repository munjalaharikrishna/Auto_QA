import { useState } from 'react';
import { api, fileUrl, type JobDetail, type Question } from '../api';
import { Link, navigate } from '../router';
import { ErrorNote } from './common';
import { PickElement, type ViewElement } from './PickElement';

/**
 * The guided walkthrough (E0.14b, PD-13): the steps of the test case on the left, the application's screen on the right. The engine
 * runs one step at a time and waits: the person goes on, adds a check on what the screen shows, rewords the step, or stops. A step
 * that cannot find its element asks for a pick on the screenshot, or the person does it by hand. While it waits, what the person does in
 * the walkthrough's browser window is recorded as steps (E0.14c). Nothing is saved until the person says so at the end.
 */

interface WalkStep {
  step: string;
  original: string;
  status: string;
}
interface WalkPending {
  kind: 'check' | 'edit' | 'recorded';
  sentence?: string;
  afterStep?: string;
  /** A recorded step done by hand in place of this step of the run. */
  replaces?: string;
  /** A recorded step the person added; one not added is not saved. */
  added?: boolean;
  step?: string;
  text?: string;
}
interface Walk {
  caseId: string;
  version: number;
  who: string;
  steps: WalkStep[];
  pending: WalkPending[];
  production?: boolean;
  /** The browser window is shown and what the person does in it is recorded (E0.14c). */
  recording?: boolean;
  /** What the recorder last could not keep, or a note on what it kept. */
  recorderNote?: string;
  ended?: 'finished' | 'stopped' | 'idle' | 'closed';
  /** The person closed the browser window: what was recorded before is kept, to save here. */
  browserClosed?: boolean;
  savedVersion?: number;
  durationMs?: number;
}
interface StepPayload {
  step: string;
  original: string;
  status: string;
  reason?: string;
  changes?: string[];
  picked?: boolean;
  url?: string;
  view: { screenshot?: string; width: number; height: number; elements: ViewElement[] };
  last?: { ok: boolean; sentence?: string; result?: 'proven' | 'disproven' | 'unproven'; message?: string };
}

/** The checks offered on day one: the ones the verdict engine judges. Text is matched as "contains". */
const KINDS: Array<{ kind: string; label: string; needs: 'element' | 'element+value' | 'value' }> = [
  { kind: 'visible', label: 'is shown', needs: 'element' },
  { kind: 'not-visible', label: 'is not shown', needs: 'element' },
  { kind: 'text-contains', label: 'shows text containing…', needs: 'element+value' },
  { kind: 'value', label: 'has the value…', needs: 'element+value' },
  { kind: 'enabled', label: 'is enabled', needs: 'element' },
  { kind: 'disabled', label: 'is disabled', needs: 'element' },
  { kind: 'url-contains', label: 'page address contains…', needs: 'value' },
];

const RESULT: Record<string, string> = {
  proven: 'holds on this screen now',
  disproven: 'does NOT hold on this screen now',
  unproven: 'cannot be told on this screen now',
};

export function Walkthrough({ job }: { job: JobDetail }) {
  const walk = job.output.walk as Walk | undefined;
  const question = job.questions[0];
  const current = question && typeof question.payload.item === 'string' ? question.payload.item : undefined;
  const active = ['queued', 'running', 'waiting'].includes(job.status);
  // A recorded step is added, or any change removed, at any time while the walkthrough is open (E0.14c).
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string>();
  const edit = active
    ? async (e: Parameters<typeof api.walkEdit>[1]) => {
        setEditing(true);
        setEditError(undefined);
        await api
          .walkEdit(job.id, e)
          .catch((x: Error) => setEditError(x.message))
          .finally(() => setEditing(false));
      }
    : undefined;
  const waiting = walk?.pending.filter((p) => p.kind === 'recorded' && !p.added).length ?? 0;

  return (
    <div className="walk">
      <section className="panel stack" aria-label="Steps">
        <h2 style={{ margin: 0 }}>Steps</h2>
        {walk ? (
          <ol className="steps">
            {walk.steps.map((s) => (
              <li key={s.step} className={s.step === current ? 'current' : s.status}>
                {s.original}
                <span className="state muted">{s.step === current ? '← here' : s.status === 'to do' ? '' : s.status}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Starting…</p>
        )}
        {!!walk?.pending.length && (
          <div>
            <h3 className="pending-title">To save at the end</h3>
            {waiting > 0 && (
              <p className="muted" style={{ margin: '0 0 0.25rem' }}>
                What you do in the browser is recorded here first. Add each one you mean as a step; the ones you do not add are not saved.
              </p>
            )}
            <ul className="pending-list">
              {walk.pending.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the same step can be recorded twice; the list only grows or loses an item
                <li key={`${i} ${p.kind} ${p.sentence ?? p.text}`}>
                  {p.kind === 'check' ? (
                    <>
                      {p.sentence} <span className="muted">({p.afterStep === 'end' ? 'at the end' : `after ${p.afterStep}`})</span>
                    </>
                  ) : p.kind === 'recorded' ? (
                    <>
                      {p.sentence} <span className="muted">({p.replaces ? `done for ${p.replaces}` : `recorded after ${p.afterStep}`})</span>{' '}
                      {p.added ? <span className="badge PASS">added</span> : <span className="badge job">waiting for your OK</span>}
                      {edit && !p.added && (
                        <button
                          type="button"
                          className="chip"
                          disabled={editing}
                          onClick={() => void edit({ add: i, sentence: p.sentence })}
                          style={{ marginLeft: '0.5rem' }}
                        >
                          Add
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {p.step} reads: {p.text}
                    </>
                  )}
                  {edit && (
                    <button
                      type="button"
                      className="chip"
                      disabled={editing}
                      onClick={() => void edit({ remove: i, ...(p.kind === 'edit' ? {} : { sentence: p.sentence }) })}
                      style={{ marginLeft: '0.5rem' }}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {edit && waiting > 1 && (
              <button type="button" className="primary" disabled={editing} onClick={() => void edit({ addAll: true })} style={{ marginTop: '0.4rem' }}>
                Add all ({waiting})
              </button>
            )}
            <ErrorNote error={editError} />
          </div>
        )}
        {walk?.production && <p className="notice warn">Production environment: steps that change data are not run unless the project allows it.</p>}
        {walk?.browserClosed && active && (
          <p className="notice warn" style={{ margin: 0 }}>
            The browser window was closed. Everything recorded before that is kept: say on the right whether to save it.
          </p>
        )}
        {walk?.recording && active && !walk.browserClosed && (
          <p className="notice" style={{ margin: 0 }}>
            A browser window is open for this walkthrough, with these steps and the Next step and Finish buttons on its left. While it waits for you, everything
            you do in that window is recorded as a step: clicks, typing, dropdowns, checkboxes, Enter and Escape, and the pages you go to. Your login is written
            as the project's valid username and password, so every test case uses the same one.
          </p>
        )}
        {walk?.recorderNote && active && (
          <p className="notice warn" style={{ margin: 0 }}>
            {walk.recorderNote}
          </p>
        )}
      </section>

      <section className="stack" aria-label="Screen">
        {question ? (
          <Asked key={question.id} question={question} />
        ) : active ? (
          <p className="panel muted">Running the next step…</p>
        ) : (
          <Ended job={job} walk={walk} />
        )}
      </section>
    </div>
  );
}

function Ended({ job, walk }: { job: JobDetail; walk?: Walk }) {
  if (!walk) return null;
  const how =
    walk.ended === 'idle'
      ? 'was closed after a long time without an answer'
      : walk.ended === 'closed'
        ? 'ended when its browser window was closed'
        : walk.ended === 'stopped'
          ? 'was finished before its last step'
          : 'went through every step';
  return (
    <div className="panel stack">
      <p style={{ margin: 0 }}>
        The walkthrough of <Link to={`/projects/${job.projectId}/cases/${encodeURIComponent(walk.caseId)}`}>{walk.caseId}</Link> {how}.
      </p>
      {walk.savedVersion ? (
        <p className="notice" style={{ margin: 0 }}>
          ✓ Saved as version {walk.savedVersion} of {walk.caseId}, with {walk.pending.filter((p) => p.kind === 'recorded').length} recorded step(s). Run it
          again to see the result: the earlier run's result is not changed.
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Nothing was saved.
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={async () => {
            const next = await api.runTestCase(job.projectId, walk.caseId);
            navigate(`/jobs/${next.id}`);
          }}
        >
          Run it again
        </button>
      </div>
    </div>
  );
}

/** The question the walkthrough is waiting on: a step done, an element to pick, or a yes or no. */
function Asked({ question }: { question: Question }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (answer: unknown) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.answer(question.id, answer);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const p = question.payload as Record<string, unknown>;

  if (question.kind === 'confirm' && p.code === 'SAVE_WALKTHROUGH') {
    const notRun = Array.isArray(p.notRun) ? (p.notRun as string[]) : [];
    const steps = notRun.length > 2 ? `${notRun[0]}–${notRun[notRun.length - 1]}` : notRun.join(' and ');
    return (
      <div className="panel stack">
        <p className="notice" style={{ margin: 0 }}>
          {String(p.text ?? '')}
        </p>
        {notRun.length > 0 && (
          <p className="muted" style={{ margin: 0 }}>
            {steps} {notRun.length === 1 ? 'was' : 'were'} not run. If what you recorded does the same, let it replace {notRun.length === 1 ? 'it' : 'them'}.
            Otherwise the old {notRun.length === 1 ? 'step runs' : 'steps run'} after what you recorded.
          </p>
        )}
        <div className="row">
          {notRun.length > 0 ? (
            <>
              <button type="button" className="primary" disabled={busy} onClick={() => void send('replace')}>
                Save: recorded steps replace {steps}
              </button>
              <button type="button" disabled={busy} onClick={() => void send(true)}>
                Save: keep {steps} too
              </button>
            </>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={() => void send(true)}>
              Save
            </button>
          )}
          <button type="button" className="danger" disabled={busy} onClick={() => void send(false)}>
            Don't save
          </button>
        </div>
        <ErrorNote error={error} />
      </div>
    );
  }

  if (question.kind === 'confirm')
    return (
      <div className="panel stack">
        <p className="notice warn" style={{ margin: 0 }}>
          {String(p.text ?? '')}
        </p>
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void send(true)}>
            Yes
          </button>
          <button type="button" disabled={busy} onClick={() => void send(false)}>
            No
          </button>
        </div>
        <ErrorNote error={error} />
      </div>
    );

  if (question.kind === 'choose') {
    const view = p.view as StepPayload['view'] | undefined;
    return (
      <div className="panel stack">
        <h2 style={{ margin: 0 }}>
          {String(p.item ?? '')}: {String(p.raw ?? '')}
        </h2>
        <p className="notice warn" style={{ margin: 0 }}>
          {String(p.text ?? '')}
        </p>
        {view?.screenshot ? (
          <PickElement view={{ ...view, screenshot: view.screenshot }} busy={busy} onPick={(ref, remember) => void send({ ref, remember })} />
        ) : (
          <p className="muted">There is no picture of the page to pick on.</p>
        )}
        <p className="muted" style={{ margin: 0 }}>
          Or do this step yourself in the browser window: what you do there is recorded in its place.
        </p>
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void send('manual')}>
            I did this step myself
          </button>
          <button type="button" disabled={busy} onClick={() => void send('skip')}>
            Leave the step blocked
          </button>
          <button type="button" disabled={busy} onClick={() => void send('finish')}>
            Finish
          </button>
        </div>
        <ErrorNote error={error} />
      </div>
    );
  }

  if (question.kind === 'step') return <StepDone payload={p as unknown as StepPayload} busy={busy} send={send} error={error} />;
  return <p className="panel muted">Waiting for an answer the walkthrough window does not show.</p>;
}

function StepDone({ payload, busy, send, error }: { payload: StepPayload; busy: boolean; send: (a: unknown) => Promise<void>; error?: string }) {
  const [mode, setMode] = useState<'none' | 'check' | 'edit'>('none');
  const [picked, setPicked] = useState<ViewElement>();
  const [kind, setKind] = useState('visible');
  const [expected, setExpected] = useState('');
  const [where, setWhere] = useState<'here' | 'end'>('here');
  const [text, setText] = useState(payload.original);
  const { view } = payload;
  const needs = KINDS.find((k) => k.kind === kind)?.needs ?? 'element';
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  const pickAt = (e: React.MouseEvent<HTMLDivElement>) => {
    if (mode !== 'check') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * view.width;
    const y = ((e.clientY - rect.top) / rect.height) * view.height;
    const under = view.elements.filter((el) => x >= el.box.x && x <= el.box.x + el.box.width && y >= el.box.y && y <= el.box.y + el.box.height);
    under.sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
    setPicked(under[0]);
  };

  const ready = needs === 'value' ? !!expected.trim() : !!picked && (needs === 'element' || !!expected.trim());

  return (
    <div className="panel stack">
      <h2 style={{ margin: 0 }}>
        {payload.step}: {payload.original}
      </h2>
      <p className="muted" style={{ margin: 0 }}>
        {payload.status === 'done' ? 'Done.' : `${payload.status}${payload.reason ? `: ${payload.reason}` : ''}`}
        {payload.picked ? ' The element you picked was used.' : ''}
        {payload.changes?.length ? ` What changed: ${payload.changes.slice(0, 3).join('; ')}${payload.changes.length > 3 ? '…' : ''}` : ''}
      </p>
      {payload.last && (
        <p className={`notice ${payload.last.ok && payload.last.result !== 'disproven' ? '' : 'warn'}`} style={{ margin: 0 }}>
          {payload.last.ok ? (
            <>
              Check added: <strong>{payload.last.sentence}</strong>
              {payload.last.result ? ` — it ${RESULT[payload.last.result]}` : ''}. {payload.last.message}
            </>
          ) : (
            <>Not added: {payload.last.message}</>
          )}
        </p>
      )}
      {view.screenshot ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the element can also be named in the form below
        <div className="shot" onClick={pickAt} style={{ cursor: mode === 'check' ? 'crosshair' : 'default' }}>
          <img src={fileUrl(view.screenshot)} alt={`The screen after ${payload.step}`} />
          {mode === 'check' &&
            view.elements.map((el) => (
              <div
                key={el.ref}
                className={`box ${picked?.ref === el.ref ? 'picked' : 'other'}`}
                style={{
                  left: pct(el.box.x, view.width),
                  top: pct(el.box.y, view.height),
                  width: pct(el.box.width, view.width),
                  height: pct(el.box.height, view.height),
                }}
                title={`${el.role} "${el.name}"`}
              />
            ))}
        </div>
      ) : (
        <p className="muted">There is no picture of this screen.</p>
      )}
      {payload.url && (
        <p className="muted" style={{ margin: 0 }}>
          {payload.url}
        </p>
      )}

      {mode === 'check' && (
        <section className="stack" aria-label="Add a check">
          <p className="muted" style={{ margin: 0 }}>
            {needs === 'value' ? 'This check is about the page address.' : 'Click the element on the screen, then say what should be true of it.'}
          </p>
          <div className="row">
            <span className="grow">{needs === 'value' ? 'The page' : picked ? `${picked.role} "${picked.name || '(no name)'}"` : 'Nothing picked yet'}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Check">
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {needs !== 'element' && (
              <input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="text" aria-label="Expected" maxLength={200} />
            )}
            <select value={where} onChange={(e) => setWhere(e.target.value as 'here' | 'end')} aria-label="When">
              <option value="here">after this step</option>
              <option value="end">at the end</option>
            </select>
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !ready}
              onClick={() =>
                void send({
                  check: {
                    kind,
                    ...(needs !== 'value' && picked ? { target: { role: picked.role, name: picked.name } } : {}),
                    ...(needs !== 'element' ? { expected } : {}),
                    ...(where === 'end' ? { afterStep: 'end' } : {}),
                  },
                })
              }
            >
              Add the check
            </button>
            <button type="button" onClick={() => setMode('none')}>
              Close
            </button>
          </div>
        </section>
      )}
      {mode === 'edit' && (
        <section className="stack" aria-label="Reword the step">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={300} aria-label="The step" />
          <div className="row">
            <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void send({ edit: { text } })}>
              Keep the new words
            </button>
            <button type="button" onClick={() => setMode('none')}>
              Close
            </button>
          </div>
        </section>
      )}
      {mode === 'none' && (
        <p className="muted" style={{ margin: 0 }}>
          Anything you do in the browser window now is added as a step after {payload.step}.
        </p>
      )}
      {mode === 'none' && (
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void send('next')}>
            Next step
          </button>
          <button type="button" disabled={busy} onClick={() => setMode('check')}>
            Add check
          </button>
          <button type="button" disabled={busy} onClick={() => setMode('edit')}>
            Edit step
          </button>
          <button type="button" disabled={busy} onClick={() => void send('finish')} title="Do not run the steps left; save what was recorded">
            Finish
          </button>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
