import { useEffect, useState } from 'react';
import { api, type ProjectView } from './api';
import { Icon, type IconName, ProjectTile } from './components/ui';
import { Link, navigate } from './router';
import { navSectionOf, projectPath, type Route, type Section } from './routes';

export { routeOf, type Section } from './routes';

/**
 * U1 step 1: the project-first shell. Everything about a project is under `/projects/:id/<section>`, with the project's sidebar beside
 * it; the pages above projects (all projects, the writing guide) have a top bar. The addresses of the old menu still work: they are
 * replaced by the project page they meant.
 */

const NAV: Array<{ section: Section; label: string; icon: IconName }> = [
  { section: 'overview', label: 'Overview', icon: 'overview' },
  { section: 'cases', label: 'Test cases', icon: 'cases' },
  { section: 'runs', label: 'Runs', icon: 'runs' },
  { section: 'review', label: 'Review', icon: 'review' },
  { section: 'automation', label: 'Automation', icon: 'automation' },
  { section: 'releases', label: 'Releases', icon: 'releases' },
  { section: 'settings', label: 'Settings', icon: 'settings' },
];

/** Replaces the address without a new history entry, so Back does not return to the old one. */
export function replaceWith(to: string): void {
  history.replaceState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function Redirect({ to }: { to: Extract<Route, { kind: 'redirect' }>['to'] }) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (typeof to === 'string') return replaceWith(to);
    api.projects().then(
      (projects) => replaceWith(to(projects)),
      (e: Error) => setError(e.message),
    );
  }, [to]);
  return error ? (
    <p className="muted" role="alert">
      {error}
    </p>
  ) : null;
}

/** The pages above projects: all projects, the writing guide. */
export function TopShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="top-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="check" size={16} stroke={2.6} />
          </span>
          Auto QA
        </Link>
        <nav aria-label="Main">
          <Link to="/" className={location.pathname === '/' || location.pathname === '/projects' ? 'active' : undefined}>
            Projects
          </Link>
          <Link to="/guide" className={location.pathname === '/guide' ? 'active' : undefined}>
            Writing guide
          </Link>
        </nav>
      </header>
      <main className="top-main">{children}</main>
    </div>
  );
}

/** A project's pages: its sidebar (switcher, sections, all projects) beside the page. */
export function ProjectShell({ projectId, section, children }: { projectId?: string; section: Section; children: React.ReactNode }) {
  const [projects, setProjects] = useState<ProjectView[]>();
  const [questions, setQuestions] = useState<number>();
  useEffect(() => {
    api.projects().then(setProjects, () => setProjects([]));
  }, []);
  // How many questions wait in this project: the count beside Review (U1 step 5).
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on every change of section, so the count follows the answers given on a page
  useEffect(() => {
    if (!projectId) return;
    api.reviewSummary().then(
      (r) => setQuestions(r.projects.find((p) => p.projectId === projectId)?.questions),
      () => setQuestions(undefined),
    );
  }, [projectId, section]);
  const project = projects?.find((p) => p.id === projectId);
  return (
    <div className="shell">
      <aside className="side" aria-label="Project">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="check" size={16} stroke={2.6} />
          </span>
          Auto QA
        </Link>
        <label className="switcher">
          <span className="sr-only">Project</span>
          <ProjectTile name={project?.name ?? projectId ?? '?'} />
          <span className="switcher-text">
            <strong>{project?.name ?? projectId ?? 'Project'}</strong>
            <small>{project ? hostOf(project.baseUrl) : ''}</small>
          </span>
          <Icon name="swap" size={16} />
          <select
            aria-label="Switch project"
            value={projectId ?? ''}
            onChange={(e) => navigate(projectPath(e.target.value, section))}
            disabled={!projects || projects.length < 2}
          >
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Sections">
          {NAV.map((n) => (
            <Link
              key={n.section}
              to={projectId ? projectPath(projectId, n.section) : '/'}
              className={n.section === navSectionOf(section) ? 'active' : undefined}
              current={n.section === navSectionOf(section)}
            >
              <Icon name={n.icon} />
              {n.label}
              {n.section === 'review' && !!questions && (
                <span className="nav-count">
                  {questions}
                  <span className="sr-only"> open</span>
                </span>
              )}
            </Link>
          ))}
        </nav>
        <nav aria-label="More" className="more">
          <Link to="/">
            <Icon name="projects" size={16} />
            All projects
          </Link>
          <Link to="/guide">
            <Icon name="guide" size={16} />
            Writing guide
          </Link>
        </nav>
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
