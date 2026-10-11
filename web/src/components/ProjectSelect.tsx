import { useEffect, useState } from 'react';
import { api, type ProjectView } from '../api';
import { navigate } from '../router';

/** The projects, and the one chosen in the page address (`?project=`), or the first. Choosing another keeps the address in step. */
export function useProjects(): { projects?: ProjectView[]; current?: ProjectView; error?: string; choose: (id: string) => void } {
  const [projects, setProjects] = useState<ProjectView[]>();
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState(() => new URLSearchParams(location.search).get('project') ?? undefined);
  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => setError(e.message));
  }, []);
  const current = projects?.find((p) => p.id === chosen) ?? projects?.[0];
  const choose = (id: string) => {
    setChosen(id);
    history.replaceState(null, '', `${location.pathname}?project=${encodeURIComponent(id)}`);
  };
  return { projects, current, error, choose };
}

export function ProjectSelect(props: { projects: ProjectView[]; value?: string; onChange: (id: string) => void; label?: string }) {
  if (!props.projects.length) {
    return (
      <button type="button" className="primary" onClick={() => navigate('/projects')}>
        Create a project
      </button>
    );
  }
  return (
    <label className="row" style={{ gap: '0.5rem' }}>
      <span className="muted">{props.label ?? 'Project'}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
