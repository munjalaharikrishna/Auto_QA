import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RawTestCaseSchema } from '../model/test-model.js';
import { parseTestCase } from '../parser/index.js';
import { type CaseStatus, daysBetween, isDate, suggestDate, summarize } from '../releases/impact.js';
import { catalogue } from '../validations/catalogue.js';
import type { JobRunner } from './jobs.js';
import type { Project, ReleaseFeature, ReleaseRecord, Store, TestCaseRecord } from './store.js';
import { buildZip, zipEntriesOf } from './zip.js';

/**
 * The pages beside the project screens: the dashboard, approval of test cases, Web Automation (record, execute, download
 * the script, add assertions) and release tracking.
 */

interface Context {
  app: FastifyInstance;
  store: Store;
  runner: JobRunner;
  projectOf(id: string): Promise<Project>;
  caseOf(projectId: string, extId: string): Promise<TestCaseRecord>;
  notFound(what: string): Error;
  bad(message: string): Error;
}

const DateText = z.string().refine(isDate, 'Use a date like 2026-10-31');
const CaseIds = z.array(z.string().trim().min(1)).default([]);
const FeatureBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).default(''),
  requirementId: z.string().trim().max(60).optional(),
  effortDays: z.number().min(0).max(1000).default(0),
  caseIds: CaseIds,
});
const ChangeBody = z.object({ reason: z.string().trim().max(2000).default(''), newDate: DateText.optional() });
const ReleaseStatusEnum = z.enum(['planned', 'in-progress', 'released', 'cancelled']);

/** `planned` / `recorded` state of a script, for the Web Automation list. */
export type ScriptState = 'none' | 'ready' | 'out-of-date';
const scriptState = (c: TestCaseRecord): ScriptState => (c.recordedVersion === undefined ? 'none' : c.recordedVersion === c.version ? 'ready' : 'out-of-date');

export function registerAutomationRoutes(ctx: Context): void {
  const { app, store, runner, projectOf, caseOf, notFound, bad } = ctx;
  const scriptDir = (project: Project, extId: string) => runner.projectDir(project, 'single', extId, 'workspace');
  const statusOf = (c: TestCaseRecord): CaseStatus => ({ extId: c.extId, lastStatus: c.lastStatus, approved: c.approval === 'approved' });

  // Approval: only approved test cases are offered in Web Automation

  app.put('/api/projects/:id/test-cases/:caseId/approval', async (req) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const { approval } = z.object({ approval: z.enum(['draft', 'approved']) }).parse(req.body);
    const record = await store.setApproval(project.id, params.caseId, approval);
    if (!record) throw notFound('Test case');
    return record;
  });

  // Web Automation: the approved test cases of every project, with the state of each one's script

  app.get('/api/automation', async () => {
    const out: Array<TestCaseRecord & { projectName: string; script: ScriptState; scriptReady: boolean; running: boolean }> = [];
    for (const project of await store.projects()) {
      const jobs = await store.jobs(project.id, 100);
      const busy = new Set(
        jobs.filter((j) => ['queued', 'running', 'waiting', 'review'].includes(j.status)).map((j) => (j.input.case as { id?: string } | undefined)?.id ?? ''),
      );
      for (const c of await store.testCases(project.id)) {
        if (c.approval !== 'approved') continue;
        const script = scriptState(c);
        out.push({
          ...c,
          projectName: project.name,
          script,
          scriptReady: script !== 'none' && existsSync(scriptDir(project, c.extId)),
          running: busy.has(c.extId),
        });
      }
    }
    return out;
  });

  /** Record: explore the app from the written steps and keep the generated script. Nothing is run. */
  app.post('/api/projects/:id/test-cases/:caseId/record', async (req, reply) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const record = await caseOf(project.id, params.caseId);
    if (record.approval !== 'approved') throw bad('Approve the test case first.');
    const job = await store.createJob({ projectId: project.id, kind: 'single', input: { case: { ...record.raw, id: record.extId }, record: true } });
    runner.enqueue(job);
    return reply.status(202).send(job);
  });

  const scriptFiles = async (project: Project, extId: string) => {
    const dir = scriptDir(project, extId);
    if (!existsSync(dir)) throw notFound('Script (record the test case first)');
    return { dir, entries: await zipEntriesOf(dir) };
  };

  /** The generated project of one test case, as one zip: tests, page objects, locators, data, config. Never the `.env`. */
  app.get('/api/projects/:id/test-cases/:caseId/script', async (req, reply) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const record = await caseOf(project.id, params.caseId);
    const { entries } = await scriptFiles(project, record.extId);
    if (!entries.length) throw notFound('Script (record the test case first)');
    const name = record.extId.replace(/[^\w.-]+/g, '-');
    return reply.header('content-disposition', `attachment; filename="${name}-playwright.zip"`).type('application/zip').send(buildZip(entries));
  });

  /** The test file itself, to read in the page. */
  app.get('/api/projects/:id/test-cases/:caseId/script/preview', async (req) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const record = await caseOf(project.id, params.caseId);
    const dir = path.join(scriptDir(project, record.extId), 'tests');
    if (!existsSync(dir)) throw notFound('Script (record the test case first)');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.spec.ts'));
    return { files: await Promise.all(files.map(async (name) => ({ name, content: await readFile(path.join(dir, name), 'utf8') }))) };
  });

  // Assertions: every kind of check the platform knows, added to a test case in the words it understands

  app.get('/api/validations', async () => catalogue());

  app.post('/api/projects/:id/test-cases/:caseId/assertions', async (req) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const record = await caseOf(project.id, params.caseId);
    const { text } = z.object({ text: z.string().trim().min(3).max(500) }).parse(req.body);
    if (record.raw.expected.split(/\r?\n/).some((l) => l.trim().replace(/^\d+[.)]\s*/, '') === text)) throw bad('This check is already in the test case.');
    const before = parseTestCase(record.raw).assertions.filter((a) => a.status === 'unparsed').length;
    const raw = RawTestCaseSchema.omit({ row: true }).parse({ ...record.raw, expected: `${record.raw.expected.trimEnd()}\n${text}` });
    const model = parseTestCase(raw);
    const unparsed = model.assertions.filter((a) => a.status === 'unparsed');
    if (unparsed.length > before) {
      const line = unparsed.find((a) => a.raw.includes(text)) ?? unparsed.at(-1)!;
      throw bad(`This sentence is not understood as a check${line.reason?.text ? `: ${line.reason.text}` : ''}. Use one of the examples as a pattern.`);
    }
    return store.upsertTestCase(
      project.id,
      { ...raw, id: record.extId },
      { kind: record.sourceKind, ref: record.sourceRef, row: record.sourceRow },
      'assertion added',
    );
  });

  // Releases

  const loadRelease = async (projectId: string, id: string): Promise<ReleaseRecord> =>
    (await store.release(projectId, id)) ??
    (() => {
      throw notFound('Release');
    })();

  const detail = async (release: ReleaseRecord) => {
    const [features, changes, cases] = await Promise.all([
      store.releaseFeatures(release.id),
      store.releaseChanges(release.id),
      store.testCases(release.projectId),
    ]);
    return {
      ...release,
      features,
      changes,
      summary: summarize(release, features, cases.map(statusOf)),
      cases: cases.map((c) => ({ extId: c.extId, title: c.title, approval: c.approval, lastStatus: c.lastStatus })),
    };
  };

  /** The cases a feature points at must exist in the project, so coverage never counts a case that is not there. */
  const checkCases = async (projectId: string, ids: string[]) => {
    const known = new Set((await store.testCases(projectId)).map((c) => c.extId));
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length) throw bad(`Not test cases of this project: ${unknown.join(', ')}.`);
  };

  app.get('/api/releases', async () => {
    const projects = new Map((await store.projects()).map((p) => [p.id, p]));
    const out = [];
    for (const r of await store.releases()) {
      const [features, cases] = await Promise.all([store.releaseFeatures(r.id), store.testCases(r.projectId)]);
      out.push({ ...r, projectName: projects.get(r.projectId)?.name ?? r.projectId, summary: summarize(r, features, cases.map(statusOf)) });
    }
    return out;
  });

  app.get('/api/projects/:id/releases', async (req) => {
    const project = await projectOf((req.params as { id: string }).id);
    return Promise.all((await store.releases(project.id)).map(detail));
  });

  app.post('/api/projects/:id/releases', async (req, reply) => {
    const project = await projectOf((req.params as { id: string }).id);
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        version: z.string().trim().max(40).default(''),
        scope: z.string().trim().max(8000).default(''),
        teamSize: z.number().int().min(1).max(500).default(1),
        startDate: DateText.optional(),
        plannedDate: DateText,
        features: z.array(FeatureBody).max(200).default([]),
      })
      .parse(req.body);
    if (b.startDate && daysBetween(b.startDate, b.plannedDate) < 0) throw bad('The release date is before its start date.');
    for (const f of b.features) await checkCases(project.id, f.caseIds);
    const release = await store.createRelease(project.id, b);
    for (const f of b.features) await store.addFeature(release, f);
    return reply.status(201).send(await detail(release));
  });

  app.get('/api/projects/:id/releases/:rid', async (req) => {
    const params = req.params as { id: string; rid: string };
    return detail(await loadRelease((await projectOf(params.id)).id, params.rid));
  });

  app.patch('/api/projects/:id/releases/:rid', async (req) => {
    const params = req.params as { id: string; rid: string };
    const project = await projectOf(params.id);
    await loadRelease(project.id, params.rid);
    const b = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        version: z.string().trim().max(40).optional(),
        scope: z.string().trim().max(8000).optional(),
        teamSize: z.number().int().min(1).max(500).optional(),
        startDate: DateText.nullable().optional(),
        status: ReleaseStatusEnum.optional(),
      })
      .parse(req.body);
    await store.updateRelease(project.id, params.rid, b);
    return detail(await loadRelease(project.id, params.rid));
  });

  app.delete('/api/projects/:id/releases/:rid', async (req) => {
    const params = req.params as { id: string; rid: string };
    if (!(await store.deleteRelease((await projectOf(params.id)).id, params.rid))) throw notFound('Release');
    return { ok: true };
  });

  /** Locks the scope: from now on a new requirement is a recorded change that moves the date. */
  app.post('/api/projects/:id/releases/:rid/lock', async (req) => {
    const params = req.params as { id: string; rid: string };
    const project = await projectOf(params.id);
    await loadRelease(project.id, params.rid);
    await store.lockScope(project.id, params.rid);
    return detail(await loadRelease(project.id, params.rid));
  });

  /** What adding this much work does to the date, before it is added: the date it would move to, and the growth. */
  app.post('/api/projects/:id/releases/:rid/impact', async (req) => {
    const params = req.params as { id: string; rid: string };
    const project = await projectOf(params.id);
    const release = await loadRelease(project.id, params.rid);
    const { effortDays } = z.object({ effortDays: z.number().min(0).max(1000) }).parse(req.body);
    const features = await store.releaseFeatures(release.id);
    const live = features.filter((f) => !f.removed).reduce((n, f) => n + f.effortDays, 0);
    const baseline = features.filter((f) => !f.addedAfterBaseline).reduce((n, f) => n + f.effortDays, 0);
    const suggestedDate = suggestDate(release.dueDate, effortDays, release.teamSize);
    return {
      dueDate: release.dueDate,
      suggestedDate,
      extraCalendarDays: daysBetween(release.dueDate, suggestedDate),
      teamSize: release.teamSize,
      effortDaysAfter: live + effortDays,
      scopeGrowthPercentAfter: baseline ? Math.round(((live + effortDays - baseline) / baseline) * 100) : 0,
    };
  });

  app.post('/api/projects/:id/releases/:rid/features', async (req, reply) => {
    const params = req.params as { id: string; rid: string };
    const project = await projectOf(params.id);
    const release = await loadRelease(project.id, params.rid);
    const body = req.body as Record<string, unknown>;
    const feature = FeatureBody.parse(body);
    const change = ChangeBody.parse(body);
    await checkCases(project.id, feature.caseIds);
    // A requirement added after the lock must say why, and the date it moves to is the tester's call (the impact is only suggested).
    if (release.baselinedAt && !change.reason) throw bad('This release is locked: say why the requirement is added.');
    if (change.newDate && daysBetween(release.dueDate, change.newDate) < -3650) throw bad('That date is too far back.');
    const added: ReleaseFeature = await store.addFeature(release, feature, change);
    return reply.status(201).send({ feature: added, release: await detail(await loadRelease(project.id, release.id)) });
  });

  app.patch('/api/projects/:id/releases/:rid/features/:fid', async (req) => {
    const params = req.params as { id: string; rid: string; fid: string };
    const project = await projectOf(params.id);
    const release = await loadRelease(project.id, params.rid);
    const b = FeatureBody.partial()
      .extend({ status: z.enum(['planned', 'in-progress', 'done']).optional(), requirementId: z.string().trim().max(60).nullable().optional() })
      .parse(req.body);
    if (b.caseIds) await checkCases(project.id, b.caseIds);
    if (!(await store.updateFeature(release.id, params.fid, b))) throw notFound('Feature');
    return detail(await loadRelease(project.id, release.id));
  });

  app.delete('/api/projects/:id/releases/:rid/features/:fid', async (req) => {
    const params = req.params as { id: string; rid: string; fid: string };
    const project = await projectOf(params.id);
    const release = await loadRelease(project.id, params.rid);
    const change = ChangeBody.parse(req.body ?? {});
    if (release.baselinedAt && !change.reason) throw bad('This release is locked: say why the requirement is removed.');
    if (!(await store.removeFeature(release, params.fid, change))) throw notFound('Feature');
    return detail(await loadRelease(project.id, release.id));
  });

  app.post('/api/projects/:id/releases/:rid/date', async (req) => {
    const params = req.params as { id: string; rid: string };
    const project = await projectOf(params.id);
    const release = await loadRelease(project.id, params.rid);
    const b = z.object({ newDate: DateText, reason: z.string().trim().max(2000).default('') }).parse(req.body);
    if (release.baselinedAt && !b.reason) throw bad('This release is locked: say why the date moves.');
    await store.moveRelease(release, b.newDate, b.reason);
    return detail(await loadRelease(project.id, release.id));
  });

  // Dashboard

  app.get('/api/dashboard', async () => {
    const projects = await store.projects();
    const cards = [];
    const totals = { projects: projects.length, cases: 0, approved: 0, scripts: 0, pass: 0, fail: 0, notRun: 0 };
    for (const p of projects) {
      const cases = await store.testCases(p.id);
      const approved = cases.filter((c) => c.approval === 'approved');
      const scripts = approved.filter((c) => scriptState(c) === 'ready').length;
      const count = (status: string) => cases.filter((c) => c.lastStatus === status).length;
      const notRun = cases.filter((c) => !c.lastStatus).length;
      totals.cases += cases.length;
      totals.approved += approved.length;
      totals.scripts += scripts;
      totals.pass += count('PASS');
      totals.fail += count('FAIL');
      totals.notRun += notRun;
      const releases = [];
      for (const r of await store.releases(p.id)) {
        if (r.status === 'released' || r.status === 'cancelled') continue;
        releases.push({ ...r, summary: summarize(r, await store.releaseFeatures(r.id), cases.map(statusOf)) });
      }
      cards.push({
        project: { id: p.id, name: p.name, baseUrl: p.baseUrl },
        cases: {
          total: cases.length,
          approved: approved.length,
          draft: cases.length - approved.length,
          scripts,
          pass: count('PASS'),
          fail: count('FAIL'),
          notRun,
        },
        executions: await store.executions(p.id, 5),
        releases,
      });
    }
    return { totals, projects: cards };
  });
}
