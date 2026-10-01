import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CasePage } from './pages/CasePage';
import { GuidePage } from './pages/GuidePage';
import { JobPage } from './pages/JobPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { Link, usePath } from './router';
import './styles.css';

function App() {
  const path = usePath();
  const testCase = /^\/projects\/([\w-]+)\/cases\/(.+)$/.exec(path);
  const project = /^\/projects\/([\w-]+)/.exec(path);
  const job = /^\/jobs\/([\w-]+)/.exec(path);
  return (
    <>
      <header className="top">
        <Link to="/" className="brand">
          Auto QA
        </Link>
        <span className="muted">Manual test cases → Playwright automation</span>
        <nav>
          <Link to="/">Projects</Link>
          <Link to="/guide">Writing guide</Link>
        </nav>
      </header>
      <main>
        {testCase ? (
          <CasePage key={`${testCase[1]}/${testCase[2]}`} projectId={testCase[1]} caseId={decodeURIComponent(testCase[2])} />
        ) : project ? (
          <ProjectPage key={project[1]} id={project[1]} />
        ) : job ? (
          <JobPage key={job[1]} id={job[1]} />
        ) : path === '/guide' ? (
          <GuidePage />
        ) : (
          <ProjectsPage />
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
