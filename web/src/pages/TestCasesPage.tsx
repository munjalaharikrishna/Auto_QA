import { ErrorNote } from '../components/common';
import { ProjectSelect, useProjects } from '../components/ProjectSelect';
import { Link } from '../router';
import { TestCasesTab } from './ProjectPage';

/** Every test case, one project at a time. Approving a case here is what offers it in Web Automation. */
export function TestCasesPage() {
  const { projects, current, error, choose } = useProjects();
  if (error) return <ErrorNote error={error} />;
  if (!projects) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="row" style={{ marginBottom: '0.25rem' }}>
        <h1 className="grow" style={{ margin: 0 }}>
          Test Cases
        </h1>
        <ProjectSelect projects={projects} value={current?.id} onChange={choose} />
        {current && (
          <Link to={`/projects/${current.id}?tab=single`} className="primary-link">
            <button type="button" className="primary">
              New test case
            </button>
          </Link>
        )}
      </div>
      <p className="muted">All the test cases of the project. Approve the ones that are ready: only approved test cases appear in Web Automation.</p>
      {current ? <TestCasesTab key={current.id} project={current} /> : <p>No projects yet. Create one in Projects &amp; settings first.</p>}
    </>
  );
}
