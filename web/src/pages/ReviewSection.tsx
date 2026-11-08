import { useCallback, useEffect, useState } from 'react';
import { api, type HeldCase, type ProjectView, type ReviewCard } from '../api';
import { ErrorNote, when } from '../components/common';
import { Card } from '../components/ReviewCards';
import { Chip } from '../components/ui';
import { useServerEvents } from '../events';
import { Link } from '../router';
import { ZoomDialog } from './JobPage';

type ProjectCard = ReviewCard & { jobId: string; executionId?: string; runAt: string };
type Filter = 'needs' | 'held' | 'decided' | 'answered';

const REVIEWER_KEY = 'auto-qa.reviewer';
const reviewer = (): string => {
  try {
    return localStorage.getItem(REVIEWER_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
};

/**
 * U1 step 5: one review for the whole project. Every open question of its latest runs, each case from its latest run, with what answers
 * it: a sentence for a wording card (one click on a suggestion, or the engine's pattern), PASS or FAIL on what the page showed, a hold for
 * a flaky case. Held, decided and answered questions are one click away and never hidden.
 */
export function ReviewSection({ project }: { project: ProjectView }) {
  const [data, setData] = useState<{ cards: ProjectCard[]; held: Array<HeldCase & { overdue: boolean }> }>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>('needs');
  const [zoom, setZoom] = useState<string>();
  const load = useCallback(() => {
    api.projectReview(project.id).then(setData, (e: Error) => setError(e.message));
  }, [project.id]);
  useEffect(load, [load]);
  useServerEvents((e) => {
    if (e.type === 'job' && e.job.projectId === project.id && e.job.status === 'done') load();
  });

  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const groups: Record<Filter, ProjectCard[]> = {
    needs: data.cards.filter((c) => !c.decided && !c.held && !c.meaning),
    held: data.cards.filter((c) => c.held || c.cases.some((x) => x.held?.overdue)),
    decided: data.cards.filter((c) => c.decided),
    answered: data.cards.filter((c) => !!c.meaning && !c.decided),
  };
  const shown = groups[filter];
  const holding = new Set(groups.needs.flatMap((c) => c.cases.map((x) => x.testId))).size;
  const runs = [...new Map(data.cards.map((c) => [c.jobId, c.executionId ?? c.jobId])).values()];
  const name = reviewer();
  return (
    <div className="stack-l">
      <div className="review-head">
        <div className="grow">
          <h2 className="review-title">
            {groups.needs.length === 0
              ? 'Nothing needs you'
              : `${groups.needs.length} question${groups.needs.length === 1 ? '' : 's'} need${groups.needs.length === 1 ? 's' : ''} you`}
          </h2>
          <p className="muted">
            {groups.needs.length
              ? `They hold up ${holding} test case${holding === 1 ? '' : 's'}. Answer once: the next run remembers it.`
              : 'Every question of the latest runs is answered, decided or held.'}
            {runs.length ? ` From ${runs.length === 1 ? 'run' : 'runs'} ${runs.join(', ')}.` : ''}
          </p>
        </div>
        {name && (
          <span className="who-chip">
            <span className="project-tile" style={{ width: 24, height: 24, fontSize: 11 }} aria-hidden="true">
              {name.slice(0, 2).toUpperCase()}
            </span>
            Reviewing as {name}
          </span>
        )}
        {groups.needs.length > 0 && (
          <Link to={`/projects/${project.id}/focus`} className="button primary">
            Focus review
          </Link>
        )}
      </div>
      <div className="tabs" role="tablist" aria-label="Filter the questions">
        {(
          [
            ['needs', 'Needs you'],
            ['held', 'Held'],
            ['decided', 'Decided'],
            ['answered', 'Answered'],
          ] as Array<[Filter, string]>
        ).map(([f, label]) => (
          <button type="button" role="tab" key={f} aria-selected={filter === f} onClick={() => setFilter(f)}>
            {label} {groups[f].length}
          </button>
        ))}
      </div>
      {filter === 'held' && data.held.length > 0 && (
        <section className="panel" aria-label="Held cases">
          <h3>Held cases</h3>
          <ul className="held-list">
            {data.held.map((h) => (
              <li key={h.id} className="held-item">
                <Chip kind={h.overdue ? 'fail' : 'accent'}>{h.overdue ? 'Overdue' : 'Held'}</Chip>
                <span>
                  <strong>{h.testId}</strong> · {h.owner} until {when(h.until)} · “{h.reason}”
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {shown.length === 0 ? (
        <section className="panel empty">
          <h3>{filter === 'needs' ? 'Nothing needs you' : `No ${filter} questions`}</h3>
          <p className="muted">
            {filter === 'needs' ? 'Run test cases to find out where things stand.' : 'They show here once there are some.'}{' '}
            <Link to={`/projects/${project.id}/runs`}>See the runs</Link>
          </p>
        </section>
      ) : (
        shown.map((card) => (
          <Card
            key={`${card.jobId}:${card.id}`}
            jobId={card.jobId}
            projectId={project.id}
            card={card}
            zoom={setZoom}
            changed={load}
            run={{ label: card.executionId ?? card.jobId, at: card.runAt }}
          />
        ))
      )}
      {zoom && <ZoomDialog file={zoom} onClose={() => setZoom(undefined)} />}
    </div>
  );
}
