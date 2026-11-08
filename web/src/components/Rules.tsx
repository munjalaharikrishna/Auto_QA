import { useCallback, useEffect, useState } from 'react';
import { api, type ProjectRule, type ReviewGroups } from '../api';
import { ErrorNote, Explain } from './common';

const KIND: Record<ProjectRule['kind'], string> = {
  step: 'A step is read as',
  check: 'An expected result is read as',
  element: 'A word means the name on the screen',
  approved: 'Accepted value',
};
const KIND_SHORT: Record<ProjectRule['kind'], string> = { step: 'Steps', check: 'Expected results', element: 'Words', approved: 'Accepted values' };

/**
 * What the engine learned (U1 step 7): every answer and pick a person gave, kept for this project, so the same wording is never asked
 * about again. Each can be switched off (the engine asks again), its meaning changed (checked like a new answer), or removed; new ones
 * can be written by hand; all of them can be exported and imported.
 */
export function RulesTab({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<ProjectRule[]>();
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<ProjectRule['kind'] | 'all'>('all');
  const [editing, setEditing] = useState<{ id: string; meaning: string }>();
  const [removing, setRemoving] = useState<string>();
  const [draft, setDraft] = useState<{ kind: 'step' | 'check' | 'element'; pattern: string; meaning: string }>({ kind: 'step', pattern: '', meaning: '' });
  const load = useCallback(() => {
    api.rules(projectId).then(setRules, (e: Error) => setError(e.message));
  }, [projectId]);
  useEffect(load, [load]);
  const run = (fn: () => Promise<unknown>) =>
    fn().then(
      () => {
        setError(undefined);
        load();
      },
      (e: Error) => setError(e.message),
    );

  if (!rules) return <ErrorNote error={error} />;
  const kinds = (Object.keys(KIND) as Array<ProjectRule['kind']>).filter((k) => rules.some((r) => r.kind === k));
  const shown = rules.filter((r) => kind === 'all' || r.kind === kind);
  return (
    <section className="panel stack learned" aria-labelledby="learned-title">
      <div className="row">
        <div className="grow">
          <h2 id="learned-title" style={{ margin: 0 }}>
            What the engine learned
          </h2>
          <p className="muted" style={{ margin: 0 }}>
            Your answers and picks, kept for this project, so the same wording is never asked about again. Switch one off to make the engine ask again.
          </p>
        </div>
        <a href={`/api/projects/${projectId}/rules/export`} download className="button secondary">
          Export
        </a>
        <label className="button secondary file-button">
          Import
          <input
            type="file"
            className="file-input"
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
      <ErrorNote error={error} />
      {kinds.length > 1 && (
        <div className="tabs" role="tablist" aria-label="Filter what the engine learned">
          <button type="button" role="tab" aria-selected={kind === 'all'} onClick={() => setKind('all')}>
            All {rules.length}
          </button>
          {kinds.map((k) => (
            <button type="button" role="tab" key={k} aria-selected={kind === k} onClick={() => setKind(k)}>
              {KIND_SHORT[k]} {rules.filter((r) => r.kind === k).length}
            </button>
          ))}
        </div>
      )}
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
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={r.enabled ? undefined : 'rule-off'}>
                  <td>{r.pattern}</td>
                  <td>
                    {r.kind === 'approved' ? (
                      <span className="muted">accepted as it is</span>
                    ) : editing?.id === r.id ? (
                      <form
                        className="row tight"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(() => api.updateRule(projectId, r.id, { meaning: editing.meaning.trim() })).then(() => setEditing(undefined));
                        }}
                      >
                        <input
                          aria-label={`New meaning of ${r.pattern}`}
                          value={editing.meaning}
                          onChange={(e) => setEditing({ id: r.id, meaning: e.target.value })}
                          required
                        />
                        <button type="submit" className="small primary">
                          Save
                        </button>
                        <button type="button" className="small" onClick={() => setEditing(undefined)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      r.meaning
                    )}
                  </td>
                  <td>{KIND[r.kind]}</td>
                  <td className="muted">{r.source}</td>
                  <td>
                    <label className="switch">
                      <input
                        type="checkbox"
                        className="switch-input"
                        aria-label={`${r.pattern} is on`}
                        checked={r.enabled}
                        onChange={(e) => void run(() => api.updateRule(projectId, r.id, { enabled: e.target.checked }))}
                      />
                      <span className="switch-track" aria-hidden="true" />
                    </label>
                  </td>
                  <td>
                    {removing === r.id ? (
                      <span className="row tight">
                        <button type="button" className="small danger solid" onClick={() => void run(() => api.deleteRule(projectId, r.id))}>
                          Remove
                        </button>
                        <button type="button" className="small" onClick={() => setRemoving(undefined)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <span className="row tight">
                        {r.kind !== 'approved' && (
                          <button
                            type="button"
                            className="small"
                            onClick={() => setEditing({ id: r.id, meaning: r.meaning })}
                            aria-label={`Change the meaning of ${r.pattern}`}
                          >
                            Change
                          </button>
                        )}
                        <button type="button" className="small" onClick={() => setRemoving(r.id)} aria-label={`Remove the rule for ${r.pattern}`}>
                          Remove
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Nothing learned yet. Answers appear here when you answer a question in Review, or pick an element and choose to remember it.</p>
      )}

      <form
        className="add-rule"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.saveRule(projectId, { ...draft, source: 'written by hand' })).then(() => setDraft({ ...draft, pattern: '', meaning: '' }));
        }}
      >
        <span className="eyebrow">Teach it yourself</span>
        <div className="row">
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
        </div>
      </form>
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
