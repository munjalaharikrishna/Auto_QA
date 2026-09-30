import { useEffect, useState } from 'react';
import { api, type ProjectView } from '../api';
import { ErrorNote, ProjectForm } from '../components/common';
import { Link, navigate } from '../router';

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectView[]>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <h1 className="grow" style={{ margin: 0 }}>
          Projects
        </h1>
        {!creating && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            New project
          </button>
        )}
      </div>
      <ErrorNote error={error} />
      {creating && (
        <section className="panel">
          <h2>New project</h2>
          <p className="muted">One project per application under test. Its generated Playwright tests go in their own folder.</p>
          <ProjectForm
            submitLabel="Create project"
            onSubmit={async (p) => {
              const created = await api.createProject(p);
              navigate(`/projects/${created.id}`);
            }}
          />
        </section>
      )}
      {projects && !projects.length && !creating && (
        <section className="panel">
          <p>No projects yet. Create one with the URL of the application you test and a test user's credentials.</p>
        </section>
      )}
      {projects?.map((p) => (
        <section className="panel row" key={p.id}>
          <div className="grow">
            <h2 style={{ marginBottom: '0.25rem' }}>
              <Link to={`/projects/${p.id}`}>{p.name}</Link>
            </h2>
            <div className="muted">
              {p.baseUrl} · {p.env.username ? `user ${p.env.username}` : 'no user set'} · {p.env.hasPassword ? 'password set' : 'no password'}
            </div>
          </div>
          <Link to={`/projects/${p.id}`}>Open</Link>
        </section>
      ))}
    </>
  );
}
