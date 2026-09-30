import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GuidePage } from './pages/GuidePage';
import { JobPage } from './pages/JobPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { Link, usePath } from './router';
import './styles.css';

function App() {
  const path = usePath();
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
        {project ? (
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
