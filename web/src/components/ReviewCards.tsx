import { useCallback, useEffect, useState } from 'react';
import { type AnswerResult, api, type DecideResult, fileUrl, type ReviewCard } from '../api';
import { navigate } from '../router';
import { ErrorNote, when } from './common';
import { Chip, type ChipKind } from './ui';

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
          ({cards.filter((c) => !c.decided && !c.held).length} of {cards.length} card{cards.length === 1 ? '' : 's'} open
          {cards.some((c) => c.held) ? `, ${cards.filter((c) => c.held).length} held` : ''})
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

/** The kind of question a card asks, for its chip: what a sentence means, or a decision on what the page showed. */
const chipOf = (card: ReviewCard): { kind: ChipKind; text: string } =>
  card.held
    ? { kind: 'accent', text: 'Held' }
    : card.decided
      ? { kind: 'muted', text: 'Decided' }
      : card.asks
        ? { kind: 'need', text: card.meaning ? 'Answered' : 'Wording' }
        : card.label?.name === 'flaky'
          ? { kind: 'accent', text: 'Flaky' }
          : { kind: 'info', text: card.label ? card.label.name[0]?.toUpperCase() + card.label.name.slice(1) : 'Decide' };

/**
 * One question (U1 step 5): the sentence asked about and why first; then what answers it, which is a sentence for a wording card and PASS
 * or FAIL on what the page showed for the others; what the run saw is folded away on a wording card. `run` says which run the card is
 * from on the project's review, where cards of several runs are shown together.
 */
export function Card({
  jobId,
  projectId,
  card,
  zoom,
  changed,
  run,
}: {
  jobId: string;
  projectId?: string;
  card: ReviewCard;
  zoom: (file: string) => void;
  changed: () => void;
  run?: { label: string; at?: string };
}) {
  const [who, setWho] = useState(remembered);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<DecideResult>();
  const refusal = card.cases.find((c) => !c.eligibility.canPass)?.eligibility.passRefusal;
  const decided = card.cases.filter((c) => c.decision);
  const chip = chipOf(card);

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

  const seen = (
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
      {(card.before || card.after) && (
        <div className="row shots">
          {card.before && (
            <figure>
              <button type="button" className="thumb-button" onClick={() => card.before && zoom(card.before)} aria-label="Page before, full size">
                <img className="thumb" src={fileUrl(card.before)} alt="" />
              </button>
              <figcaption className="muted">before</figcaption>
            </figure>
          )}
          {card.after && (
            <figure>
              <button type="button" className="thumb-button" onClick={() => card.after && zoom(card.after)} aria-label="Page after, full size">
                <img className="thumb" src={fileUrl(card.after)} alt="" />
              </button>
              <figcaption className="muted">after</figcaption>
            </figure>
          )}
        </div>
      )}
    </>
  );

  return (
    <article
      className={`panel review-card${card.held ? ' is-held' : ''}${card.decided ? ' is-decided' : ''}`}
      aria-label={`Review card: ${card.clause || card.why}`}
    >
      <div className="row tight card-top">
        <Chip kind={chip.kind}>{chip.text}</Chip>
        {card.label && !card.asks && (
          <span className="muted" title={card.label.meaning}>
            {card.label.meaning}
          </span>
        )}
        <span className="muted grow card-covers">
          covers {card.cases.map((c) => c.testId).join(', ')}
          {run && ` · from ${run.label}${run.at ? `, ${when(run.at)}` : ''}`}
        </span>
      </div>
      <h3 className="card-sentence">“{card.clause || 'The run could not be judged'}”</h3>
      <p className="muted card-why">{card.why}</p>

      {card.asks && <MeansForm jobId={jobId} card={card} who={who} changed={changed} />}
      {card.asks ? (
        <details className="seen-details">
          <summary className="seen-summary">What the run saw</summary>
          {seen}
        </details>
      ) : (
        seen
      )}

      {projectId && (
        <ul className="case-chips" aria-label="Walk through a case">
          {card.cases.map((c) => (
            <li key={c.testId} className="case-chip">
              <button
                type="button"
                className="small"
                disabled={busy}
                title="Run the steps one at a time in a browser: pick elements, add checks, reword steps"
                aria-label={`Walkthrough of ${c.testId}`}
                onClick={async () => {
                  try {
                    const job = await api.walkthrough(projectId, c.testId, { fromJob: jobId, ...(who.trim() ? { who: who.trim() } : {}) });
                    navigate(`/jobs/${job.id}`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {c.testId} · Walkthrough
              </button>
              {c.changedSince && (
                <span className="changed-note">
                  changed since this run: version {c.changedSince.version} ({c.changedSince.reason}, {when(c.changedSince.at)}). The result here is the earlier
                  version's; run it again for the new one.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <HoldNote card={card} projectId={projectId} who={who} changed={changed} />
      {card.label?.name === 'flaky' && !card.held && <HoldForm jobId={jobId} card={card} who={who} changed={changed} />}
      {decided.length > 0 && (
        <ul className="decided-list">
          {decided.map((c) => (
            <li key={c.testId}>
              <Chip kind={c.decision?.decision === 'PASS' ? 'pass' : 'fail'}>Decided {c.decision?.decision}</Chip> {c.testId} · by {c.decision?.reviewer} on{' '}
              {when(c.decision?.decidedAt)}
              {c.decision?.note ? ` · “${c.decision.note}”` : ''}. The engine's verdict was {c.decision?.engineStatus}.
            </li>
          ))}
        </ul>
      )}
      {(() => {
        const decideBox = (
          <div className="decide-box">
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
              <button type="button" className="pass-button" disabled={busy || !!refusal} onClick={() => void decide('PASS')}>
                PASS
              </button>
              <button type="button" className="fail-button" disabled={busy} onClick={() => void decide('FAIL')}>
                FAIL
              </button>
              {refusal && <span className="muted">PASS is not offered: {refusal}</span>}
            </div>
          </div>
        );
        // A wording card is settled by its answer: PASS or FAIL is there, folded away, for the case a person decides it all the same.
        return card.asks && !decided.length ? (
          <details className="seen-details">
            <summary className="seen-summary">Or decide PASS or FAIL instead</summary>
            {decideBox}
          </details>
        ) : (
          decideBox
        );
      })()}
      {!!card.remembers && (
        <p className="remember-note">
          Your decision is remembered: the next run of {card.remembers === 1 ? 'this check' : `these ${card.remembers} checks`} does not ask again while the
          check, its element and what the page shows stay the same. Changing it to FAIL later takes back what a PASS taught.
        </p>
      )}
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

/**
 * E0.19 step 3, ask once: the card asks what one sentence means. The answer is a sentence the engine can run; it is kept for the project
 * and every case with that sentence, in every sheet, is read that way from the next run on. This run's results stay as they were.
 */
function MeansForm({ jobId, card, who, changed }: { jobId: string; card: ReviewCard; who: string; changed: () => void }) {
  const [means, setMeans] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [kept, setKept] = useState<AnswerResult>();
  const [removed, setRemoved] = useState<{ changed: string[]; unchanged: string[] }>();
  if (!card.asks) return null;
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setRemoved(await api.removeStep(jobId, { cardId: card.id, ...(who.trim() ? { who: who.trim() } : {}) }));
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (text = means) => {
    setBusy(true);
    setError(undefined);
    try {
      setKept(await api.answerCard(jobId, { cardId: card.id, means: text.trim(), ...(who.trim() ? { who: who.trim() } : {}) }));
      setMeans('');
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="means-box" aria-label="What the sentence means">
      {card.meaning ? (
        <span>
          Answered: “{card.asks.sentence}” means <strong>“{card.meaning.to}”</strong> ({card.meaning.by}, {when(card.meaning.at)}). The next run reads every
          case with it this way.
        </span>
      ) : (
        <span>
          Say once what “{card.asks.sentence}” means, as a {card.asks.kind === 'step' ? 'step' : 'check'} the engine can run. Every case with this sentence is
          read that way from the next run, in every sheet of the project.
        </span>
      )}
      {!card.meaning && !!card.suggestions?.ready.length && (
        <fieldset className="suggestions">
          <legend>Did you mean · one click keeps it for every case</legend>
          {card.suggestions.ready.map((sg) => (
            <button key={sg.text} type="button" className="suggestion" disabled={busy} title={sg.why} onClick={() => void save(sg.text)}>
              {sg.text}
            </button>
          ))}
        </fieldset>
      )}
      <div className="row">
        <label className="grow" style={{ flex: 3 }}>
          It means
          <input
            value={means}
            onChange={(e) => setMeans(e.target.value)}
            maxLength={1000}
            placeholder={
              card.asks.kind === 'step' ? 'e.g. Click "Anita Kumari Rao" in the Employee Name column' : 'e.g. The "Personal Details" heading is shown'
            }
          />
        </label>
        {card.suggestions?.template && !means && (
          <button
            type="button"
            disabled={busy}
            title="Start from the engine's pattern and fill in the part in angle brackets"
            onClick={() => setMeans(card.suggestions?.template ?? '')}
          >
            Fill in a pattern
          </button>
        )}
        <button type="button" className="primary" disabled={busy || !means.trim() || means.includes('<')} onClick={() => void save()}>
          {card.meaning ? 'Change the answer' : 'Keep for every case'}
        </button>
      </div>
      {card.asks.kind === 'step' && !card.meaning && !removed && (
        <button type="button" className="link-button" disabled={busy} onClick={() => void remove()}>
          Or remove this step from {card.cases.length === 1 ? 'the test case' : `the ${card.cases.length} test cases`}
        </button>
      )}
      {removed && (
        <span className="muted" role="status">
          Removed from {removed.changed.join(', ') || 'no test case'}
          {removed.unchanged.length ? ` (not found in ${removed.unchanged.join(', ')})` : ''}: each is a new version; run them again to see the result.
        </span>
      )}
      <ErrorNote error={error} />
      {kept && (
        <span className="muted" role="status">
          Kept. {kept.casesOnCard === 1 ? 'The case on this card' : `The ${kept.casesOnCard} cases on this card`}
          {kept.casesInProject > 0 ? ` and ${kept.casesInProject} test case${kept.casesInProject === 1 ? '' : 's'} of the project` : ''} use this sentence; run
          them again to see them read your way.
        </span>
      )}
    </section>
  );
}

/** A held card says who has it and until when, and can be released; an overdue hold says its owner decides (E0.19 step 7). */
function HoldNote({ card, projectId, who, changed }: { card: ReviewCard; projectId?: string; who: string; changed: () => void }) {
  const [error, setError] = useState<string>();
  const held = card.cases.filter((c) => c.held);
  if (!held.length) return null;
  return (
    <section className={held.some((c) => c.held?.overdue) ? 'notice warn stack' : 'notice stack'} aria-label="Holding area">
      {held.map((c) =>
        c.held ? (
          <div key={c.testId} className="row">
            <span className="grow">
              {c.held.overdue ? (
                <>
                  {c.testId}: the hold ended on {when(c.held.until)}. <strong>{c.held.owner}</strong> decides: fix it, hold it again, or decide it here.
                </>
              ) : (
                <>
                  {c.testId} is held by <strong>{c.held.owner}</strong> until {when(c.held.until)} ({c.held.reason}). It still runs; it is not counted as a
                  question.
                </>
              )}
            </span>
            {projectId && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await api.releaseHold(projectId, c.testId, { note: 'released on the review card', ...(who.trim() ? { who: who.trim() } : {}) });
                    changed();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Release
              </button>
            )}
          </div>
        ) : null,
      )}
      <ErrorNote error={error} />
    </section>
  );
}

/** A flaky card can be put in the holding area: an owner, a reason, and how many days (E0.19 step 7). */
function HoldForm({ jobId, card, who, changed }: { jobId: string; card: ReviewCard; who: string; changed: () => void }) {
  const [owner, setOwner] = useState(who);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hold = async () => {
    setBusy(true);
    setError(undefined);
    try {
      for (const c of card.cases.filter((x) => !x.held || x.held.overdue))
        await api.holdCase(jobId, { testId: c.testId, owner: owner.trim(), reason: reason.trim(), days, ...(who.trim() ? { who: who.trim() } : {}) });
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="notice stack" aria-label="Hold the flaky case">
      <span>
        It passed only on a second try. Hold it while someone fixes it: it keeps running and stays listed, but stops being a question until the day you set.
      </span>
      <div className="row">
        <label className="grow">
          Owner
          <input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={80} />
        </label>
        <label>
          Days (1 to 30)
          <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <label className="grow" style={{ flex: 2 }}>
          Why
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. the save is slow on the test server" />
        </label>
        <button type="button" disabled={busy || !owner.trim() || reason.trim().length < 3 || days < 1 || days > 30} onClick={() => void hold()}>
          Hold
        </button>
      </div>
      <ErrorNote error={error} />
    </section>
  );
}
