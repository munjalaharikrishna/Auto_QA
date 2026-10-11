import { useCallback, useEffect, useState } from 'react';
import { api, type ProjectRule, type ReviewGroups } from '../api';
import { ErrorNote, Explain } from './common';

const KIND: Record<ProjectRule['kind'], string> = {
  step: 'A step is read as',
  check: 'An expected result is read as',
  element: 'A word means the name on the screen',
  approved: 'Accepted value',
};

/** The project's rules: every answer given in review, kept so the same wording is never asked about again (FR-RULE-02, FR-RULE-03). */
export function RulesTab({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<ProjectRule[]>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<{ kind: 'step' | 'check' | 'element'; pattern: string; meaning: string }>({ kind: 'step', pattern: '', meaning: '' });
  const load = useCallback(() => {
    api.rules(projectId).then(setRules, (e: Error) => setError(e.message));
  }, [projectId]);
  useEffect(load, [load]);
  const run = (fn: () => Promise<unknown>) => fn().then(load, (e: Error) => setError(e.message));

  if (!rules) return <ErrorNote error={error} />;
  return (
    <section className="panel stack">
      <h2 style={{ margin: 0 }}>Project rules</h2>
      <p className="muted" style={{ margin: 0 }}>
        Every answer you give in review is kept here, so the same wording is never asked about again. Switch a rule off to stop using it, or remove it.
      </p>
      <ErrorNote error={error} />
      {rules.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When the test case says</th>
                <th>It means</th>
                <th>Kind</th>
                <th>From</th>
                <th>On</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={r.enabled ? undefined : { opacity: 0.55 }}>
                  <td>{r.pattern}</td>
                  <td>{r.kind === 'approved' ? <span className="muted">accepted as it is</span> : r.meaning}</td>
                  <td>{KIND[r.kind]}</td>
                  <td>{r.source}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${r.pattern} is on`}
                      checked={r.enabled}
                      onChange={(e) => void run(() => api.updateRule(projectId, r.id, { enabled: e.target.checked }))}
                    />
                  </td>
                  <td>
                    <button type="button" onClick={() => void run(() => api.deleteRule(projectId, r.id))} aria-label={`Remove the rule for ${r.pattern}`}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No rules yet. They appear when you answer a question or pick an element and choose to remember it.</p>
      )}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.saveRule(projectId, { ...draft, source: 'written by hand' })).then(() => setDraft({ ...draft, pattern: '', meaning: '' }));
        }}
      >
        <select aria-label="Kind of rule" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as typeof draft.kind })}>
          <option value="step">A step is read as</option>
          <option value="check">An expected result is read as</option>
          <option value="element">A word means the name on the screen</option>
        </select>
        <input
          required
          className="grow"
          aria-label="When the test case says"
          placeholder="When it says…"
          value={draft.pattern}
          onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
        />
        <input
          required
          className="grow"
          aria-label="It means"
          placeholder="It means…"
          value={draft.meaning}
          onChange={(e) => setDraft({ ...draft, meaning: e.target.value })}
        />
        <button type="submit" className="primary">
          Add a rule
        </button>
      </form>

      <div className="row">
        <a href={`/api/projects/${projectId}/rules/export`} download>
          <button type="button">Export the rules</button>
        </a>
        <label className="muted">
          Import rules from a file{' '}
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void file.text().then((text) => run(() => api.importRules(projectId, JSON.parse(text).rules ?? [])));
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </section>
  );
}

/**
 * The questions of the whole batch, grouped by wording (FR-RV-09), and the learned values to accept in one click (FR-RV-10).
 * An answer is saved as a project rule, so it also applies to every later import.
 */
export function GroupedReview({ jobId, projectId, onRunAgain }: { jobId: string; projectId: string; onRunAgain: () => void }) {
  const [groups, setGroups] = useState<ReviewGroups>();
  const [error, setError] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string[]>([]);
  const load = useCallback(() => {
    api.reviewGroups(jobId).then(setGroups, (e: Error) => setError(e.message));
  }, [jobId]);
  useEffect(load, [load]);

  if (!groups) return <ErrorNote error={error} />;
  if (!groups.questions.length && !groups.assumptions.length) return null;
  return (
    <section className="panel stack">
      <h2 style={{ margin: 0 }}>Review</h2>
      <ErrorNote error={error} />
      {groups.questions.map((q) => {
        const done = saved.includes(q.key) || !!q.rule;
        return (
          <div key={q.key} className="notice warn stack">
            <Explain e={q} id={q.kind === 'step' ? 'Step' : 'Expected result'} raw={q.raw} />
            <div className="muted">
              Affects {q.cases.length} test case{q.cases.length === 1 ? '' : 's'}: {[...new Set(q.cases.map((c) => c.testId))].slice(0, 8).join(', ')}
            </div>
            {done ? (
              <div>Saved as a project rule{q.rule ? `: "${q.rule.meaning}"` : ''}. Run the review queue again to use it.</div>
            ) : (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  api.saveRule(projectId, { kind: q.kind, pattern: q.raw, meaning: answers[q.key] ?? '', source: 'grouped review' }).then(
                    () => setSaved([...saved, q.key]),
                    (err: Error) => setError(err.message),
                  );
                }}
              >
                <input
                  required
                  className="grow"
                  aria-label={`Write "${q.raw}" like this`}
                  placeholder={
                    q.kind === 'step'
                      ? 'Write the step so it can be run, e.g. Click the Login button'
                      : 'Write what the page should show, e.g. Dashboard heading is displayed'
                  }
                  value={answers[q.key] ?? ''}
                  onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })}
                />
                <button type="submit" className="primary">
                  Save for all {q.cases.length}
                </button>
              </form>
            )}
          </div>
        );
      })}
      {groups.questions.length > 0 && (
        <div className="row">
          <button type="button" className="primary" disabled={!saved.length && !groups.questions.some((q) => q.rule)} onClick={onRunAgain}>
            Run the review queue again
          </button>
        </div>
      )}
      {groups.assumptions.length > 0 && (
        <div className="notice stack">
          <strong>Assumed or learned ({groups.assumptions.length}): used in the run, not written by the tester</strong>
          <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {groups.assumptions.map((a) => (
              <li key={a.text}>
                {a.text}{' '}
                <span className="muted">
                  ({a.testIds.length} test case{a.testIds.length === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              type="button"
              onClick={() =>
                api
                  .approveValues(
                    projectId,
                    groups.assumptions.map((a) => a.text),
                  )
                  .then(load, (err: Error) => setError(err.message))
              }
            >
              Approve all
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
