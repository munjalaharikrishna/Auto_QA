import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { AutomationPage } from './pages/AutomationPage';
import { CasePage } from './pages/CasePage';
import { GuidePage } from './pages/GuidePage';
import { HomePage } from './pages/HomePage';
import { JobPage } from './pages/JobPage';
import { ProjectPage } from './pages/ProjectPage';
import { ReleasesPage } from './pages/ReleasesPage';
import { usePath } from './router';
import { ProjectShell, Redirect, routeOf, TopShell } from './shell';
import './styles.css';

/** A run's page sits in its project's shell: the job says which project it belongs to. */
function JobRoute({ id }: { id: string }) {
  const [projectId, setProjectId] = useState<string>();
  useEffect(() => {
    api.job(id).then(
      (j) => setProjectId(j.projectId),
      () => setProjectId(undefined),
    );
  }, [id]);
  return (
    <ProjectShell projectId={projectId} section="runs">
      <JobPage key={id} id={id} />
    </ProjectShell>
  );
}

function App() {
  const path = usePath();
  const route = routeOf(location.pathname, location.search);
  // `path` changes on every navigation, so the route above is read again.
  void path;
  switch (route.kind) {
    case 'redirect':
      return <Redirect to={route.to} />;
    case 'guide':
      return (
        <TopShell>
          <GuidePage />
        </TopShell>
      );
    case 'projects':
      return (
        <TopShell>
          <HomePage />
        </TopShell>
      );
    case 'home':
      return (
        <TopShell>
          <HomePage />
        </TopShell>
      );
    case 'job':
      return <JobRoute id={route.jobId} />;
    case 'case':
      return (
        <ProjectShell projectId={route.projectId} section="cases">
          <CasePage key={`${route.projectId}/${route.caseId}`} projectId={route.projectId} caseId={route.caseId} />
        </ProjectShell>
      );
    case 'project':
      return (
        <ProjectShell projectId={route.projectId} section={route.section}>
          {route.section === 'automation' ? (
            <AutomationPage key={route.projectId} projectId={route.projectId} />
          ) : route.section === 'releases' ? (
            <ReleasesPage key={route.projectId} projectId={route.projectId} />
          ) : (
            <ProjectPage key={`${route.projectId}/${route.section}`} id={route.projectId} section={route.section} />
          )}
        </ProjectShell>
      );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
