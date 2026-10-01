import { useId, useState } from 'react';
import type { JobStatus } from '../../../src/server/store.js';
import type { Policy, ProjectInput, ProjectView, RawTestCase } from '../api';
import { Link } from '../router';

export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'NEEDS REVIEW' ? 'NEEDS' : status === 'NOT VERIFIED' ? 'NOTV' : status;
  return <span className={`badge ${cls}`}>{status}</span>;
}

const JOB_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs an answer',
  review: 'Ready for review',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export function JobBadge({ status }: { status: JobStatus }) {
  const cls = status === 'waiting' || status === 'review' ? 'review' : status === 'failed' ? 'FAIL' : status === 'done' ? 'PASS' : 'job';
  return <span className={`badge ${cls}`}>{JOB_LABEL[status]}</span>;
}

export function ErrorNote({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p className="notice error" role="alert">
      {error}
    </p>
  );
}

/** Run settings (FR-IN-04, D18, FR-ENV-05). The password is write-only: blank keeps the saved one. */
export function ProjectForm(props: { initial?: ProjectView; submitLabel: string; onSubmit: (p: ProjectInput) => Promise<void> }) {
  const init = props.initial;
  const [name, setName] = useState(init?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(init?.baseUrl ?? '');
  const [testIdAttribute, setTestIdAttribute] = useState(init?.testIdAttribute ?? 'data-testid');
  const [username, setUsername] = useState(init?.env.username ?? '');
  const [password, setPassword] = useState('');
  const [policy, setPolicy] = useState<Policy>(init?.policy ?? 'balanced');
  const known = init?.env.variables.filter((v) => !['BASE_URL', 'TEST_USERNAME', 'TEST_PASSWORD'].includes(v.name)) ?? [];
  const [extra, setExtra] = useState<Array<{ key: number; name: string; value: string; secret: boolean; set: boolean }>>(
    known.map((v, i) => ({ key: i, name: v.name, value: v.value ?? '', secret: v.secret, set: true })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hintId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const variables = Object.fromEntries(extra.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value]));
      await props.onSubmit({ name, baseUrl, testIdAttribute, browser: 'chromium', username, password, variables, policy });
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack">
      <div className="grid2">
        <label className="field">
          <span>Project name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer portal" />
        </label>
        <label className="field">
          <span>Application URL</span>
          <input required type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" />
        </label>
        <label className="field">
          <span>Username</span>
          <input value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
        </label>
        <div className="field">
          <label className="field">
            <span>Password</span>
            <input
              aria-describedby={`${hintId}-password`}
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder={init?.env.hasPassword ? 'Saved — leave blank to keep it' : ''}
            />
          </label>
          <small id={`${hintId}-password`}>Stored only in the project's git-ignored .env, never in the database or reports.</small>
        </div>
        <label className="field">
          <span>Browser</span>
          <select value="chromium" onChange={() => {}}>
            <option value="chromium">Chromium</option>
            <option disabled>Firefox (V3)</option>
            <option disabled>WebKit (V3)</option>
          </select>
        </label>
        <div className="field">
          <label className="field">
            <span>Test id attribute</span>
            <input aria-describedby={`${hintId}-testid`} value={testIdAttribute} onChange={(e) => setTestIdAttribute(e.target.value)} />
          </label>
          <small id={`${hintId}-testid`}>The attribute your app uses for test ids, e.g. data-testid or data-test.</small>
        </div>
      </div>
      <div className="field">
        <label className="field">
          <span>When the wording is unclear</span>
          <select aria-describedby={`${hintId}-policy`} value={policy} onChange={(e) => setPolicy(e.target.value as Policy)}>
            <option value="balanced">Balanced (recommended)</option>
            <option value="strict">Strict: ask about everything unclear</option>
            <option value="lenient">Lenient: also pick the first of two equally good elements</option>
          </select>
        </label>
        <small id={`${hintId}-policy`}>
          Balanced runs a test case even if one of its expected results cannot be checked from the page; that check is reported NOT VERIFIED, and made-up or
          learned values are listed next to PASS. Strict asks first, so the test case waits.
        </small>
      </div>
      <fieldset className="panel" style={{ margin: 0 }}>
        <legend>Other values the tests need</legend>
        <p className="muted" style={{ marginTop: 0 }}>
          E.g. <code>TEST_WRONG_PASSWORD</code> for a "Wrong Password" in Test Data. Secret-looking names are never shown again.
        </p>
        {extra.map((v, i) => (
          <div className="row" key={v.key} style={{ marginBottom: '0.5rem' }}>
            <input
              aria-label="Variable name"
              value={v.name}
              style={{ maxWidth: 260 }}
              onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase() } : x)))}
            />
            <input
              aria-label={`${v.name || 'Variable'} value`}
              type={v.secret || /PASS|SECRET|TOKEN|KEY|PIN/i.test(v.name) ? 'password' : 'text'}
              value={v.value}
              placeholder={v.set && v.secret ? 'Saved — leave blank to keep it' : ''}
              onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            <button type="button" onClick={() => setExtra(extra.filter((_, j) => j !== i))} aria-label={`Remove ${v.name}`}>
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setExtra([...extra, { key: Math.max(0, ...extra.map((x) => x.key)) + 1, name: 'TEST_', value: '', secret: false, set: false }])}
        >
          Add a value
        </button>
      </fieldset>
      <ErrorNote error={error} />
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Saving…' : props.submitLabel}
      </button>
    </form>
  );
}

/** One test case as the tester writes it (SPEC §5, FR-IN-04). */
export function CaseForm(props: {
  initial?: Partial<RawTestCase>;
  submitLabel: string;
  onSubmit: (c: Omit<RawTestCase, 'row'>) => Promise<void>;
  onCancel?: () => void;
}) {
  const [c, setC] = useState<Omit<RawTestCase, 'row'>>({
    id: props.initial?.id,
    title: props.initial?.title ?? '',
    type: props.initial?.type,
    preconditions: props.initial?.preconditions ?? '',
    steps: props.initial?.steps ?? '',
    testData: props.initial?.testData ?? '',
    expected: props.initial?.expected ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hintId = useId();
  const set = (k: keyof typeof c) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setC({ ...c, [k]: e.target.value || undefined });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await props.onSubmit({ ...c, preconditions: c.preconditions || undefined, testData: c.testData || undefined, type: c.type || undefined });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack">
      <div className="grid2">
        <label className="field">
          <span>Title</span>
          <input required value={c.title} onChange={set('title')} placeholder="Verify a user can log in" />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={c.type ?? ''} onChange={set('type')}>
            <option value="">—</option>
            <option value="positive">Positive</option>
            <option value="negative">Negative</option>
            <option value="validation">Validation</option>
            <option value="boundary">Boundary</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Preconditions</span>
        <input value={c.preconditions ?? ''} onChange={set('preconditions')} placeholder="Unauthenticated visitor" />
      </label>
      <label className="field">
        <span>Steps</span>
        <textarea
          required
          value={c.steps}
          onChange={set('steps')}
          placeholder={'1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login'}
        />
      </label>
      <div className="field">
        <label className="field">
          <span>Test data</span>
          <textarea
            aria-describedby={`${hintId}-data`}
            value={c.testData ?? ''}
            onChange={set('testData')}
            style={{ minHeight: '3rem' }}
            placeholder="Email=someone@example.com"
          />
        </label>
        <small id={`${hintId}-data`}>One key=value per line. Passwords go in the project's settings, not here.</small>
      </div>
      <label className="field">
        <span>Expected result</span>
        <textarea required value={c.expected} onChange={set('expected')} style={{ minHeight: '4rem' }} placeholder="User is redirected to Dashboard page." />
      </label>
      <p className="muted">
        Tips: one action per step, the exact text on the screen, checks you can see. <Link to="/guide">Writing guide</Link>
      </p>
      <ErrorNote error={error} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Starting…' : props.submitLabel}
        </button>
        {props.onCancel && (
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** A unified diff of generated code, added and removed lines coloured (FR-RV-04). */
export function Diff({ patch }: { patch: string }) {
  const lines = patch.split('\n').slice(2);
  return (
    <div className="diff">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a patch's lines never move; the same text can repeat
        <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
          {l || ' '}
        </div>
      ))}
    </div>
  );
}

export function duration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function when(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

export interface Explanation {
  headline: string;
  why: string;
  todo: string[];
}

/** What happened and what to do, in the tester's words (src/explorer/explain.ts). */
export function Explain({ e, id, raw }: { e: Explanation; id?: string; raw?: string }) {
  return (
    <div className="explain">
      {(id || raw) && (
        <div className="muted">
          {id} {raw && `"${raw}"`}
        </div>
      )}
      <strong>{e.headline}</strong>
      <p style={{ margin: '0.25rem 0' }}>{e.why}</p>
      {!!e.todo.length && (
        <>
          <div className="muted">What you can do:</div>
          <ul style={{ margin: '0.15rem 0 0', paddingLeft: '1.2rem' }}>
            {e.todo.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
