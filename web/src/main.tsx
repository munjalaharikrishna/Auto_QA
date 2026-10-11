import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationPage } from './pages/AutomationPage';
import { CasePage } from './pages/CasePage';
import { DashboardPage } from './pages/DashboardPage';
import { GuidePage } from './pages/GuidePage';
import { JobPage } from './pages/JobPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ReleasesPage } from './pages/ReleasesPage';
import { TestCasesPage } from './pages/TestCasesPage';
import { Link, usePath } from './router';
import './styles.css';

/** The left menu. `match` says which paths light the item up: a test case opened from the list still belongs to Test Cases. */
const MENU: Array<{ to: string; label: string; icon: string; match: (path: string) => boolean }> = [
  { to: '/', label: 'Dashboard', icon: '▦', match: (p) => p === '/' },
  { to: '/test-cases', label: 'Test Cases', icon: '☰', match: (p) => p === '/test-cases' || /^\/projects\/[\w-]+\/cases\//.test(p) },
  { to: '/automation', label: 'Web Automation', icon: '▶', match: (p) => p === '/automation' || p.startsWith('/jobs/') },
  { to: '/releases', label: 'Releases', icon: '⚑', match: (p) => p === '/releases' },
];
const MORE: typeof MENU = [
  { to: '/projects', label: 'Projects & settings', icon: '⚙', match: (p) => p === '/projects' || /^\/projects\/[\w-]+\/?$/.test(p) },
  { to: '/guide', label: 'Writing guide', icon: '?', match: (p) => p === '/guide' },
];

function App() {
  const path = usePath();
  const testCase = /^\/projects\/([\w-]+)\/cases\/(.+)$/.exec(path);
  const project = /^\/projects\/([\w-]+)/.exec(path);
  const job = /^\/jobs\/([\w-]+)/.exec(path);
  const item = (m: (typeof MENU)[number]) => (
    <Link key={m.to} to={m.to} className={m.match(path) ? 'active' : undefined}>
      <span aria-hidden="true" className="icon">
        {m.icon}
      </span>
      {m.label}
    </Link>
  );
  return (
    <div className="shell">
      <aside className="side">
        <Link to="/" className="brand">
          Auto QA
        </Link>
        <span className="muted tagline">Manual test cases → Playwright automation</span>
        <nav aria-label="Main">{MENU.map(item)}</nav>
        <nav aria-label="More" className="more">
          {MORE.map(item)}
        </nav>
      </aside>
      <main>
        {testCase ? (
          <CasePage key={`${testCase[1]}/${testCase[2]}`} projectId={testCase[1]} caseId={decodeURIComponent(testCase[2])} />
        ) : path === '/projects' ? (
          <ProjectsPage />
        ) : project ? (
          <ProjectPage key={project[1]} id={project[1]} />
        ) : job ? (
          <JobPage key={job[1]} id={job[1]} />
        ) : path === '/guide' ? (
          <GuidePage />
        ) : path === '/test-cases' ? (
          <TestCasesPage />
        ) : path === '/automation' ? (
          <AutomationPage />
        ) : path === '/releases' ? (
          <ReleasesPage />
        ) : (
          <DashboardPage />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
