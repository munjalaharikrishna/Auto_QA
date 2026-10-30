import { useCallback, useEffect, useState } from 'react';
import { api, type DecideResult, fileUrl, type ReviewCard } from '../api';
import { navigate } from '../router';
import { ErrorNote, StatusBadge, when } from './common';

const REVIEWER_KEY = 'auto-qa.reviewer';

const remembered = (): string => {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? '';
  } catch {
    return '';
  }
};

/**
 * The cases the engine could not decide, as cards (VD-11, DEC-05): what was expected, what the page showed, the pictures, and PASS and
 * FAIL. Cases with one cause are one card, so you decide once. What you decide is kept with your name and the time, beside the engine's
 * own verdict, which it does not change. A PASS is offered only when the run finished and there is something to look at.
 */
export function ReviewCards({
  jobId,
  projectId,
  onChanged,
  zoom,
}: {
  jobId: string;
  /** The project of the job: with it, each case of a card offers a walkthrough (E0.14b). */
  projectId?: string;
  onChanged: () => void;
  zoom: (file: string) => void;
}) {
  const [cards, setCards] = useState<ReviewCard[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.reviewCards(jobId).then(
      (r) => setCards(r.cards),
      (e: Error) => setError(e.message),
    );
  }, [jobId]);
  useEffect(load, [load]);
  if (error) return <ErrorNote error={error} />;
  if (!cards || cards.length === 0) return null;
  return (
    <section className="stack" aria-label="Cases that need your decision">
      <h3 style={{ margin: 0 }}>
        Needs your decision{' '}
        <span className="muted">
          ({cards.filter((c) => !c.decided).length} of {cards.length} card{cards.length === 1 ? '' : 's'} open)
        </span>
      </h3>
      {cards.map((card) => (
        <Card
          key={card.id}
          jobId={jobId}
          projectId={projectId}
          card={card}
          zoom={zoom}
          changed={() => {
            load();
            onChanged();
          }}
        />
      ))}
    </section>
  );
}

function Card({
  jobId,
  projectId,
  card,
  zoom,
  changed,
}: {
  jobId: string;
  projectId?: string;
  card: ReviewCard;
  zoom: (file: string) => void;
  changed: () => void;
}) {
  const [who, setWho] = useState(remembered);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<DecideResult>();
  const refusal = card.cases.find((c) => !c.eligibility.canPass)?.eligibility.passRefusal;
  const decided = card.cases.filter((c) => c.decision);

  const decide = async (decision: 'PASS' | 'FAIL') => {
    setBusy(true);
    setError(undefined);
    try {
      try {
        if (who.trim()) localStorage.setItem(REVIEWER_KEY, who.trim());
      } catch {
        // a browser without storage just asks again
      }
      setResult(
        await api.decideCard(jobId, { cardId: card.id, decision, ...(who.trim() ? { who: who.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
      );
      setNote('');
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="panel stack" aria-label={`Review card: ${card.clause || card.why}`}>
      <div className="row">
        <StatusBadge status="NEEDS REVIEW" />
        <strong className="grow">{card.clause || 'The run could not be judged'}</strong>
        <span className="muted">covers {card.cases.map((c) => c.testId).join(', ')}</span>
      </div>
      <p style={{ margin: 0 }}>{card.why}</p>
      <div className="row" style={{ alignItems: 'stretch' }}>
        <div className="notice grow">
          <strong>Expected</strong>
          <div>{card.expected}</div>
        </div>
        <div className="notice warn grow">
          <strong>The page showed</strong>
          <div>{card.actual}</div>
        </div>
      </div>
      <div className="row">
        {card.before && (
          <figure style={{ margin: 0 }}>
            <button type="button" className="thumb-button" onClick={() => card.before && zoom(card.before)} aria-label="Page before, full size">
              <img className="thumb" src={fileUrl(card.before)} alt="" />
            </button>
            <figcaption className="muted">before</figcaption>
          </figure>
        )}
        {card.after && (
          <figure style={{ margin: 0 }}>
            <button type="button" className="thumb-button" onClick={() => card.after && zoom(card.after)} aria-label="Page after, full size">
              <img className="thumb" src={fileUrl(card.after)} alt="" />
            </button>
            <figcaption className="muted">after</figcaption>
          </figure>
        )}
      </div>
      {projectId && (
        <ul className="plain" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }} aria-label="Walk through a case">
          {card.cases.map((c) => (
            <li key={c.testId} className="row">
              <span className="grow">
                {c.testId}
                {c.changedSince && (
                  <span className="muted">
                    {' '}
                    · changed since this run: version {c.changedSince.version} ({c.changedSince.reason}, {when(c.changedSince.at)}). The result here is the
                    earlier version's; run it again for the new one.
                  </span>
                )}
              </span>
              <button
                type="button"
                disabled={busy}
                title="Run the steps one at a time in a browser: pick elements, add checks, reword steps"
                onClick={async () => {
                  try {
                    const job = await api.walkthrough(projectId, c.testId, { fromJob: jobId, ...(who.trim() ? { who: who.trim() } : {}) });
                    navigate(`/jobs/${job.id}`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Walkthrough
              </button>
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <ul className="muted" style={{ margin: 0 }}>
          {decided.map((c) => (
            <li key={c.testId}>
              {c.testId}: decided <strong>{c.decision?.decision}</strong> by {c.decision?.reviewer} on {when(c.decision?.decidedAt)}
              {c.decision?.note ? ` (${c.decision.note})` : ''}. The engine's verdict was {c.decision?.engineStatus}.
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <label className="grow">
          Your name
          <input value={who} onChange={(e) => setWho(e.target.value)} maxLength={80} placeholder="the platform's user, if blank" />
        </label>
        <label className="grow" style={{ flex: 3 }}>
          Why {decided.length ? '(needed to change a decision)' : '(optional)'}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </label>
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={busy || !!refusal} onClick={() => void decide('PASS')}>
          PASS
        </button>
        <button type="button" disabled={busy} onClick={() => void decide('FAIL')}>
          FAIL
        </button>
        {refusal && <span className="muted">PASS is not offered: {refusal}</span>}
      </div>
      <ErrorNote error={error} />
      {result && (
        <ul className="muted" style={{ margin: 0 }} aria-label="What was recorded">
          {result.results.map((r) => (
            <li key={r.testId}>
              {r.testId}: {r.outcome === 'refused' ? `not recorded: ${r.reason}` : r.outcome === 'duplicate' ? 'already decided the same way' : r.outcome}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
