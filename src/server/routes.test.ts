import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProjectView } from '../../web/src/api.js';
import { projectPath, routeOf } from '../../web/src/routes.js';

/**
 * U1 step 1: the addresses of the project-first UI. A project's sections live under /projects/:id/<section>, and every address of the old
 * menu still opens the page it meant.
 */

const projects = [{ id: 'book-market' }, { id: 'orangehrm' }] as ProjectView[];
const target = (path: string, search = ''): string => {
  const r = routeOf(path, search);
  assert.equal(r.kind, 'redirect', `${path}${search} is not a redirect`);
  if (r.kind !== 'redirect') return '';
  return typeof r.to === 'string' ? r.to : r.to(projects);
};

describe('the project-first addresses (U1 step 1)', () => {
  it('each section of a project has its own address; the overview is the project itself', () => {
    assert.deepEqual(routeOf('/projects/book-market', ''), { kind: 'project', projectId: 'book-market', section: 'overview' });
    for (const section of ['cases', 'runs', 'review', 'automation', 'releases', 'settings'] as const) {
      assert.deepEqual(routeOf(`/projects/book-market/${section}`, ''), { kind: 'project', projectId: 'book-market', section });
      assert.equal(projectPath('book-market', section), `/projects/book-market/${section}`);
    }
    assert.equal(projectPath('book-market'), '/projects/book-market');
  });

  it('a test case, a run, all projects and the guide keep their addresses', () => {
    assert.deepEqual(routeOf('/projects/book-market/cases/TC%2001', ''), { kind: 'case', projectId: 'book-market', caseId: 'TC 01' });
    assert.deepEqual(routeOf('/jobs/JOB-1', ''), { kind: 'job', jobId: 'JOB-1' });
    assert.deepEqual(routeOf('/projects', ''), { kind: 'projects' });
    assert.deepEqual(routeOf('/', ''), { kind: 'home' });
    assert.deepEqual(routeOf('/guide', ''), { kind: 'guide' });
  });

  it('the old menu opens the same thing in a project: the one in ?project=, else the first', () => {
    assert.equal(target('/test-cases', '?project=orangehrm'), '/projects/orangehrm/cases');
    assert.equal(target('/test-cases'), '/projects/book-market/cases');
    assert.equal(target('/automation'), '/projects/book-market/automation');
    assert.equal(target('/releases', '?project=orangehrm'), '/projects/orangehrm/releases');
    const none = routeOf('/automation', '');
    assert.equal(none.kind === 'redirect' && typeof none.to !== 'string' ? none.to([]) : '', '/projects');
  });

  it('the old project tabs become sections: a workbook is Upload, a single test case is New test case', () => {
    assert.equal(target('/projects/book-market', '?tab=runs'), '/projects/book-market/runs');
    assert.equal(target('/projects/book-market', '?tab=cases'), '/projects/book-market/cases');
    assert.equal(target('/projects/book-market', '?tab=rules'), '/projects/book-market/settings');
    assert.equal(target('/projects/book-market', '?tab=settings'), '/projects/book-market/settings');
    assert.equal(target('/projects/book-market', '?tab=single'), '/projects/book-market/new-case');
    assert.equal(target('/projects/book-market', '?tab=workbook'), '/projects/book-market/upload');
    assert.deepEqual(routeOf('/projects/book-market/upload', ''), { kind: 'project', projectId: 'book-market', section: 'upload' });
  });

  it('an unknown section is the overview, not a blank page', () => {
    assert.deepEqual(routeOf('/projects/book-market/nope', ''), { kind: 'project', projectId: 'book-market', section: 'overview' });
  });
});
