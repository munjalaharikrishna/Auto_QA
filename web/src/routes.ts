import type { ProjectView } from './api.js';

/**
 * U1 step 1: the addresses of the project-first UI. Everything about a project is under `/projects/:id/<section>`; the addresses of the
 * old menu (`/test-cases`, `/automation`, `/releases`, `/projects/:id?tab=…`) become the project page they meant. No React here, so the
 * rules are tested on their own (src/server/routes.test.ts).
 */

export const SECTIONS = ['overview', 'cases', 'runs', 'review', 'automation', 'releases', 'settings', 'upload', 'new-case', 'focus'] as const;
export type Section = (typeof SECTIONS)[number];

/** The sidebar item a section belongs to: uploading a workbook and writing a test case are part of Test cases (U1 step 3). */
export const navSectionOf = (s: Section): Section => (s === 'upload' || s === 'new-case' ? 'cases' : s === 'focus' ? 'review' : s);

export type Route =
  | { kind: 'home' }
  | { kind: 'projects' }
  | { kind: 'guide' }
  | { kind: 'project'; projectId: string; section: Section }
  | { kind: 'case'; projectId: string; caseId: string }
  | { kind: 'job'; jobId: string }
  | { kind: 'redirect'; to: string | ((projects: ProjectView[]) => string) };

/** The old project tabs, and the section each now is. */
const TAB_SECTION: Record<string, Section> = {
  workbook: 'upload',
  single: 'new-case',
  cases: 'cases',
  runs: 'runs',
  rules: 'settings',
  settings: 'settings',
};

const projectPath = (id: string, section: Section = 'overview') => `/projects/${encodeURIComponent(id)}${section === 'overview' ? '' : `/${section}`}`;

export { projectPath };

/** The project named in `?project=`, else the first: where an address of the old menu goes. */
const chosen = (search: string, section: Section) => (projects: ProjectView[]) => {
  const want = new URLSearchParams(search).get('project');
  const p = projects.find((x) => x.id === want) ?? projects[0];
  return p ? projectPath(p.id, section) : '/projects';
};

export function routeOf(path: string, search: string): Route {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { kind: 'home' };
  if (parts[0] === 'guide') return { kind: 'guide' };
  if (parts[0] === 'jobs' && parts[1]) return { kind: 'job', jobId: parts[1] };
  if (parts[0] === 'test-cases') return { kind: 'redirect', to: chosen(search, 'cases') };
  if (parts[0] === 'automation') return { kind: 'redirect', to: chosen(search, 'automation') };
  if (parts[0] === 'releases') return { kind: 'redirect', to: chosen(search, 'releases') };
  if (parts[0] === 'projects') {
    const id = parts[1];
    if (!id) return { kind: 'projects' };
    if (parts[2] === 'cases' && parts[3]) return { kind: 'case', projectId: id, caseId: parts.slice(3).join('/') };
    const section = parts[2] as Section | undefined;
    if (!section) {
      // An old `?tab=` address becomes its section: a workbook is Upload, a single test case is New test case (U1 step 3).
      const tab = new URLSearchParams(search).get('tab');
      if (tab && TAB_SECTION[tab]) return { kind: 'redirect', to: projectPath(id, TAB_SECTION[tab]) };
      return { kind: 'project', projectId: id, section: 'overview' };
    }
    if ((SECTIONS as readonly string[]).includes(section)) return { kind: 'project', projectId: id, section };
    return { kind: 'project', projectId: id, section: 'overview' };
  }
  return { kind: 'home' };
}
