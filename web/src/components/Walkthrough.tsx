import { useState } from 'react';
import { api, fileUrl, type JobDetail, type Question } from '../api';
import { Link, navigate } from '../router';
import { ErrorNote } from './common';
import { PickElement, type ViewElement } from './PickElement';

/**
 * The guided walkthrough (E0.14b, PD-13): the steps of the test case on the left, the application's screen on the right. The engine
 * runs one step at a time and waits: the person goes on, adds a check on what the screen shows, rewords the step, or stops. A step
 * that cannot find its element asks for a pick on the screenshot. Nothing is saved until the person says so at the end.
 */

interface WalkStep {
  step: string;
  original: string;
  status: string;
}
interface WalkPending {
  kind: 'check' | 'edit';
  sentence?: string;
  afterStep?: string;
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
  ended?: 'finished' | 'stopped' | 'idle';
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
            <h3 style={{ margin: '0.5rem 0 0.25rem' }}>To save at the end</h3>
            <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {walk.pending.map((p) => (
                <li key={p.kind === 'check' ? `check ${p.afterStep} ${p.sentence}` : `edit ${p.step} ${p.text}`}>
                  {p.kind === 'check' ? (
                    <>
                      {p.sentence} <span className="muted">({p.afterStep === 'end' ? 'at the end' : `after ${p.afterStep}`})</span>
                    </>
                  ) : (
                    <>
                      {p.step} reads: {p.text}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {walk?.production && <p className="notice warn">Production environment: steps that change data are not run unless the project allows it.</p>}
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
  const how = walk.ended === 'idle' ? 'was closed after a long time without an answer' : walk.ended === 'stopped' ? 'was stopped' : 'went through every step';
  return (
    <div className="panel stack">
      <p style={{ margin: 0 }}>
        The walkthrough of <Link to={`/projects/${job.projectId}/cases/${encodeURIComponent(walk.caseId)}`}>{walk.caseId}</Link> {how}.
      </p>
      {walk.savedVersion ? (
        <p className="notice" style={{ margin: 0 }}>
          Saved as version {walk.savedVersion}. Run it again to see the result: the earlier run's result is not changed.
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
        <div className="row">
          <button type="button" disabled={busy} onClick={() => void send('skip')}>
            Leave the step blocked
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
          <button type="button" className="danger" disabled={busy} onClick={() => void send('stop')}>
            Stop
          </button>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
