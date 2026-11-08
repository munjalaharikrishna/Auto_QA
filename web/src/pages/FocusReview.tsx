import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fileUrl, type ProjectView, type ReviewCard } from '../api';
import { ErrorNote } from '../components/common';
import { Chip } from '../components/ui';
import { Link, navigate } from '../router';

type ProjectCard = ReviewCard & { jobId: string; executionId?: string; runAt: string };
type Ripple = { settles: string[]; sheets: Array<{ name: string; cases: Array<{ id: string; title: string; status?: string }> }> };
type Done = { cardId: string; what: 'answered' | 'removed' | 'passed' | 'failed' | 'skipped' };
type Option = { key: string; label: string; note?: string; run: () => Promise<void> } | { key: string; label: string; write: true };

const REVIEWER_KEY = 'auto-qa.reviewer';
const reviewer = (): string => {
  try {
    return localStorage.getItem(REVIEWER_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
};

/**
 * U1 step 6, Focus review: the open questions of the project one at a time, answered with the keyboard, and beside each the Ripple map:
 * every test case of the project as a tile, the ones this answer settles lit before it is given. Nothing is decided by a key that a
 * card would not offer: PASS only where PASS is offered, a sentence only on a wording card.
 */
export function FocusReview({ project }: { project: ProjectView }) {
  const [queue, setQueue] = useState<ProjectCard[]>();
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const [ripple, setRipple] = useState<Ripple>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [own, setOwn] = useState('');
  const [note, setNote] = useState('');
  const writeRef = useRef<HTMLInputElement>(null);
  const who = reviewer();

  useEffect(() => {
    api.projectReview(project.id).then(
      (r) => setQueue(r.cards.filter((c) => !c.decided && !c.held && !c.meaning)),
      (e: Error) => setError(e.message),
    );
  }, [project.id]);

  const card = queue?.[index];
  useEffect(() => {
    setRipple(undefined);
    setOwn('');
    setNote('');
    setError(undefined);
    if (!card) return;
    api.ripple(card.jobId, card.id).then(setRipple, () => setRipple({ settles: card.cases.map((c) => c.testId), sheets: [] }));
  }, [card]);

  const next = useCallback(
    (what: Done['what']) => {
      if (!card) return;
      setDone((d) => [...d.filter((x) => x.cardId !== card.id), { cardId: card.id, what }]);
      setIndex((i) => i + 1);
    },
    [card],
  );
  const act = useCallback(
    async (what: Done['what'], fn: () => Promise<void>) => {
      setBusy(true);
      setError(undefined);
      try {
        await fn();
        next(what);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [next],
  );

  const refusal = card?.cases.find((c) => !c.eligibility.canPass)?.eligibility.passRefusal;
  const decide = useCallback(
    (decision: 'PASS' | 'FAIL') =>
      card &&
      act(decision === 'PASS' ? 'passed' : 'failed', async () => {
        const r = await api.decideCard(card.jobId, { cardId: card.id, decision, ...(who ? { who } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
        const refused = r.results.filter((x) => x.outcome === 'refused');
        if (refused.length) throw new Error(refused.map((x) => `${x.testId}: ${x.reason}`).join('; '));
      }),
    [act, card, note, who],
  );

  const options: Option[] = [];
  if (card?.asks) {
    for (const sg of card.suggestions?.ready.slice(0, 3) ?? [])
      options.push({
        key: String(options.length + 1),
        label: sg.text,
        note: sg.why,
        run: () => act('answered', async () => void (await api.answerCard(card.jobId, { cardId: card.id, means: sg.text, ...(who ? { who } : {}) }))),
      });
    if (card.asks.kind === 'step')
      options.push({
        key: String(options.length + 1),
        label: `Remove the step from ${card.cases.length === 1 ? 'the test case' : `the ${card.cases.length} test cases`}`,
        run: () => act('removed', async () => void (await api.removeStep(card.jobId, { cardId: card.id, ...(who ? { who } : {}) }))),
      });
    options.push({ key: String(options.length + 1), label: 'Write it yourself', write: true });
  }

  // The keys: a number picks an option, P and F decide, S skips, W walks through, Z goes back. Typing in a box is never a key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.ctrlKey || e.metaKey || e.altKey || busy || !card) return;
      const k = e.key.toLowerCase();
      const opt = options.find((o) => o.key === k);
      if (opt) {
        e.preventDefault();
        if ('write' in opt) writeRef.current?.focus();
        else void opt.run();
      } else if (k === 'p' && !card.asks && !refusal) void decide('PASS');
      else if (k === 'f' && !card.asks) void decide('FAIL');
      else if (k === 's') next('skipped');
      else if (k === 'z') setIndex((i) => Math.max(0, i - 1));
      else if (k === 'w') {
        const first = card.cases[0];
        if (first) void api.walkthrough(project.id, first.testId, { fromJob: card.jobId }).then((j) => navigate(`/jobs/${j.id}`));
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (error && !queue) return <ErrorNote error={error} />;
  if (!queue) return <p className="muted">Loading…</p>;
  const total = queue.length;
  const count = (w: Done['what']) => done.filter((d) => d.what === w).length;

  if (!card) {
    return (
      <section className="panel focus-done" aria-label="Focus review done">
        <h2 className="focus-done-title">{total === 0 ? 'Nothing needs you' : 'That was every question'}</h2>
        {total > 0 && (
          <p className="focus-done-text">
            {count('answered')} answered · {count('removed')} steps removed · {count('passed') + count('failed')} decided · {count('skipped')} skipped. The next
            run reads every answer; run the test cases again to see them settle.
          </p>
        )}
        <div className="row">
          <Link to={`/projects/${project.id}/cases`} className="button primary">
            Run the test cases
          </Link>
          <Link to={`/projects/${project.id}/review`} className="button secondary">
            Back to Review
          </Link>
          {index > 0 && (
            <button type="button" onClick={() => setIndex(index - 1)}>
              Back to the last question
            </button>
          )}
        </div>
      </section>
    );
  }

  const settles = new Set(ripple?.settles ?? card.cases.map((c) => c.testId));
  const remaining = total - index;
  const angle = total ? done.length / total : 0;
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="focus">
      <div className="focus-top">
        <span className="eyebrow">
          Question {index + 1} of {total}
        </span>
        <div className="row tight">
          <svg width="56" height="56" viewBox="0 0 64 64" role="img" aria-label={`${done.length} of ${total} done`}>
            <circle cx="32" cy="32" r={r} fill="none" style={{ stroke: 'var(--sunk)' }} strokeWidth="7" />
            <circle
              cx="32"
              cy="32"
              r={r}
              fill="none"
              style={{ stroke: 'var(--accent)' }}
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${Math.max(angle * c, 0.01)} ${c}`}
              transform="rotate(-90 32 32)"
            />
            <text x="32" y="37" textAnchor="middle" className="focus-ring-num">
              {remaining}
            </text>
          </svg>
          <span className="muted">left to a clean run{who ? ` · reviewing as ${who}` : ''}</span>
          <Link to={`/projects/${project.id}/review`}>Exit focus</Link>
        </div>
      </div>

      <div className="focus-grid">
        <article className="panel focus-question" aria-label={`Question: ${card.clause || card.why}`}>
          <div className="row tight">
            <Chip kind={card.asks ? 'need' : 'info'}>{card.asks ? 'Wording' : card.label ? card.label.name : 'Decide'}</Chip>
            <span className="muted">
              {card.cases.map((x) => x.testId).join(', ')} · from {card.executionId ?? card.jobId}
            </span>
          </div>
          <p className="focus-sentence">“{card.clause || card.why}”</p>
          <p className="muted">{card.why}</p>

          {card.asks ? (
            <div className="focus-options">
              {options.map((o) =>
                'write' in o ? (
                  <label key={o.key} className="focus-option write">
                    <span className="kbd">{o.key}</span>
                    <input
                      ref={writeRef}
                      value={own}
                      onChange={(e) => setOwn(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Enter' && own.trim() && !own.includes('<'))
                          void act(
                            'answered',
                            async () => void (await api.answerCard(card.jobId, { cardId: card.id, means: own.trim(), ...(who ? { who } : {}) })),
                          );
                      }}
                      placeholder={card.suggestions?.template ?? 'Write what it means, then Enter'}
                      aria-label="Write what it means"
                    />
                  </label>
                ) : (
                  <button key={o.key} type="button" className="focus-option" disabled={busy} title={o.note} onClick={() => void o.run()}>
                    <span className="kbd">{o.key}</span>
                    <span className="grow">{o.label}</span>
                    {o.note && <span className="muted small-note">{o.note}</span>}
                  </button>
                ),
              )}
            </div>
          ) : (
            <>
              <div className="seen-pair">
                <div className="seen expected">
                  <span className="eyebrow">Expected</span>
                  <span>{card.expected}</span>
                </div>
                <div className="seen actual">
                  <span className="eyebrow">The page showed</span>
                  <span>{card.actual}</span>
                </div>
              </div>
              {card.after && <img className="focus-shot" src={fileUrl(card.after)} alt="The page after the step" />}
              <label className="grow">
                Why (optional)
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
              </label>
              <div className="row">
                <button type="button" className="pass-button" disabled={busy || !!refusal} onClick={() => void decide('PASS')}>
                  <span className="kbd">P</span> PASS
                </button>
                <button type="button" className="fail-button" disabled={busy} onClick={() => void decide('FAIL')}>
                  <span className="kbd">F</span> FAIL
                </button>
                {refusal && <span className="muted">PASS is not offered: {refusal}</span>}
              </div>
            </>
          )}
          <ErrorNote error={error} />
          <div className="focus-keys muted">
            {card.asks ? (
              <span>
                <span className="kbd">1</span>–<span className="kbd">{options.length}</span> answer
              </span>
            ) : (
              <span>
                <span className="kbd">P</span> pass · <span className="kbd">F</span> fail
              </span>
            )}
            <span>
              <span className="kbd">S</span> skip
            </span>
            <span>
              <span className="kbd">W</span> walkthrough
            </span>
            <span>
              <span className="kbd">Z</span> back
            </span>
          </div>
        </article>

        <aside className="panel ripple" aria-label="Ripple map">
          <h2 className="ripple-title">Ripple map</h2>
          <p className="muted ripple-intro">Every test case of the project. The glowing ones are what this answer settles, before you give it.</p>
          {(ripple?.sheets ?? []).map((sheet) => (
            <div key={sheet.name} className="ripple-sheet">
              <span className="muted small-note">{sheet.name}</span>
              <div className="ripple-tiles">
                {[...sheet.cases]
                  .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
                  .map((t) => (
                    <span
                      key={t.id}
                      className={`ripple-tile ${settles.has(t.id) ? 'lit' : t.status === 'PASS' ? 'pass' : t.status === 'FAIL' ? 'fail' : t.status ? 'other' : 'idle'}`}
                      title={`${t.id}: ${t.title}${t.status ? ` (${t.status})` : ''}`}
                    >
                      {t.id}
                    </span>
                  ))}
              </div>
            </div>
          ))}
          {!ripple && <p className="muted">Working out what this answer settles…</p>}
          <div className="ripple-legend">
            <span>
              <i className="ripple-tile lit" /> settled by this answer
            </span>
            <span>
              <i className="ripple-tile pass" /> passed
            </span>
            <span>
              <i className="ripple-tile fail" /> failed
            </span>
            <span>
              <i className="ripple-tile idle" /> not run
            </span>
          </div>
          <div className="ripple-sum">
            <strong>
              {settles.size} test case{settles.size === 1 ? '' : 's'}
            </strong>
            <span>
              {settles.size > card.cases.length
                ? `${card.cases.length} on this question, and ${settles.size - card.cases.length} more with the same sentence. `
                : ''}
              Questions left: {remaining} → {remaining - 1}.
            </span>
          </div>
          <div className="remember">
            <span className="eyebrow">What I will remember</span>
            <span>
              {card.asks
                ? `“${card.asks.sentence}” means the answer you pick, for this project, until you change it.`
                : 'Your PASS or FAIL, for the next run of this check, while the check, its element and the page stay the same.'}
            </span>
          </div>
        </aside>
      </div>

      <ol className="focus-strip" aria-label="Coming up">
        {queue.slice(index, index + 3).map((q, i) => (
          <li key={`${q.jobId}:${q.id}`} className={i === 0 ? 'focus-step now' : 'focus-step'}>
            <strong>{i === 0 ? 'Now' : i === 1 ? 'Next' : 'Then'}</strong> {q.clause || q.why} · {q.cases.length} case{q.cases.length === 1 ? '' : 's'}
          </li>
        ))}
      </ol>
    </div>
  );
}
