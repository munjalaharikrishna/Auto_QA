import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FIELDS, type Field } from '../importer/columns.js';
import { readWorkbook } from '../importer/workbook.js';
import { POLICIES } from '../model/policy.js';
import { RawTestCaseSchema } from '../model/test-model.js';
import { parseTestCase } from '../parser/index.js';
import { describeEnv, writeEnvFile } from './credentials.js';
import type { Decision, JobRunner, ServerEvent } from './jobs.js';
import type { Project, Store } from './store.js';

/**
 * The platform's HTTP API and WebSocket (M7a, D20). Local and single-user in V1 (§3): it listens on
 * 127.0.0.1 and every record belongs to the default user.
 */

export interface AppOptions {
  store: Store;
  runner: JobRunner;
  dataDir: string;
  /** Where project workspaces (generated projects) go. */
  workspacesDir: string;
  /** Built web UI to serve, if present. */
  webDir?: string;
}

const ProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().url(),
  testIdAttribute: z
    .string()
    .trim()
    .regex(/^[\w-]+$/)
    .default('data-testid'),
  // D18: the field exists from V1; only Chromium is enabled.
  browser: z.literal('chromium').default('chromium'),
  username: z.string().optional(),
  password: z.string().optional(),
  /** Other variables the tests read, e.g. TEST_WRONG_PASSWORD. An empty value keeps the current one; null removes it. */
  variables: z.record(z.string().regex(/^[A-Za-z_]\w*$/), z.string().nullable()).default({}),
  policy: z.enum(POLICIES).default('balanced'),
});
/** An update: only what is sent changes. No defaults here, or an update would reset them. */
const ProjectPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().url().optional(),
  testIdAttribute: z
    .string()
    .trim()
    .regex(/^[\w-]+$/)
    .optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  variables: z.record(z.string().regex(/^[A-Za-z_]\w*$/), z.string().nullable()).optional(),
  policy: z.enum(POLICIES).optional(),
});
const MappingBody = z.object({ mapping: z.partialRecord(z.enum(FIELDS), z.string()).default({}) });
const AnswerBody = z.object({ answer: z.unknown() });
const EditBody = z.object({ case: RawTestCaseSchema.omit({ row: true }) });

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { store, runner } = options;
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  await app.register(websocket);

  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: z.prettifyError(error) });
    return reply.status(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({ error: error.message });
  });
  const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { statusCode: 404 });
  const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  const projectOf = async (id: string): Promise<Project> =>
    (await store.project(id)) ??
    (() => {
      throw notFound('Project');
    })();
  const withEnv = async (p: Project) => ({ ...p, env: describeEnv(p.workspace), policy: await store.projectPolicy(p.id) });

  // Live events for every open page (FR-RUN-02).
  const sockets = new Set<{ send(data: string): void }>();
  runner.on('event', (e: ServerEvent) => {
    const data = JSON.stringify(e);
    for (const s of sockets) s.send(data);
  });
  app.get('/api/events', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/me', async () => ({ id: 1, name: 'Owner', role: 'admin' }));

  // Projects and their run settings (FR-IN-04, FR-ENV-01, FR-ENV-05)

  app.get('/api/projects', async () => Promise.all((await store.projects()).map(withEnv)));

  app.post('/api/projects', async (req, reply) => {
    const body = ProjectBody.parse(req.body);
    const base =
      body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'project';
    let id = base;
    for (let n = 2; await store.project(id); n++) id = `${base}-${n}`;
    const workspace = path.resolve(options.workspacesDir, id);
    const project = await store.createProject({
      id,
      name: body.name,
      baseUrl: body.baseUrl,
      testIdAttribute: body.testIdAttribute,
      browser: 'chromium',
      workspace,
    });
    await writeEnvFile(workspace, { BASE_URL: body.baseUrl, TEST_USERNAME: body.username, TEST_PASSWORD: body.password, ...body.variables });
    await store.setSetting('project', project.id, 'policy', body.policy);
    return reply.status(201).send(await withEnv(project));
  });

  app.get('/api/projects/:id', async (req) => withEnv(await projectOf((req.params as { id: string }).id)));

  app.patch('/api/projects/:id', async (req) => {
    const project = await projectOf((req.params as { id: string }).id);
    const body = ProjectPatch.parse(req.body);
    const updated = (await store.updateProject(project.id, { name: body.name, baseUrl: body.baseUrl, testIdAttribute: body.testIdAttribute }))!;
    await writeEnvFile(project.workspace, { BASE_URL: body.baseUrl, TEST_USERNAME: body.username, TEST_PASSWORD: body.password, ...body.variables });
    if (body.policy) {
      await store.setSetting('project', project.id, 'policy', body.policy);
      await store.audit('project.policy', 'project', project.id, project.id, { policy: body.policy });
    }
    return withEnv(updated);
  });

  // Workbook upload, column mapping, batch run (FR-IN-01, FR-IN-02, FR-IN-08)

  app.post('/api/projects/:id/uploads', async (req, reply) => {
    const project = await projectOf((req.params as { id: string }).id);
    const part = await req.file();
    if (!part) throw bad('Attach a .xlsx or .csv file.');
    const name = path.basename(part.filename).replace(/[^\w. -]+/g, '_');
    if (!/\.(xlsx|xlsm|csv)$/i.test(name)) throw bad('Only .xlsx and .csv workbooks can be imported (save .xls as .xlsx first).');
    const dir = runner.projectDir(project, 'uploads', `${Date.now().toString(36)}`);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(file, await part.toBuffer());
    const upload = await store.createUpload({ projectId: project.id, file, originalName: part.filename });
    // FR-IN-02: the mapping used last time is reused when this sheet has its headers; otherwise the automatic match.
    const saved = await savedMapping(project);
    const withSaved = Object.keys(saved).length ? await preview(file, saved) : undefined;
    if (withSaved?.ok) return reply.status(201).send({ uploadId: upload.id, mapping: saved, ...withSaved });
    return reply.status(201).send({ uploadId: upload.id, mapping: {}, ...(await preview(file, {})) });
  });

  app.post('/api/uploads/:id/preview', async (req) => {
    const upload =
      (await store.upload((req.params as { id: string }).id)) ??
      (() => {
        throw notFound('Upload');
      })();
    const { mapping } = MappingBody.parse(req.body ?? {});
    return { uploadId: upload.id, ...(await preview(upload.file, mapping)) };
  });

  app.post('/api/uploads/:id/run', async (req, reply) => {
    const upload =
      (await store.upload((req.params as { id: string }).id)) ??
      (() => {
        throw notFound('Upload');
      })();
    const { mapping } = MappingBody.parse(req.body ?? {});
    const checked = await preview(upload.file, mapping); // Refuse a mapping that does not work before queueing.
    if (!checked.ok) throw bad(checked.error ?? 'The columns do not work.');
    const project = await projectOf(upload.projectId);
    await writeFile(mappingFile(project), `${JSON.stringify(mapping, null, 2)}\n`);
    const job = await store.createJob({
      projectId: upload.projectId,
      kind: 'workbook',
      input: { uploadId: upload.id, mapping, originalName: upload.originalName },
    });
    runner.enqueue(job);
    return reply.status(202).send(job);
  });

  // One test case from the form (FR-IN-04), reviewed before it runs (FR-RV-01, FR-RV-03)

  app.post('/api/projects/:id/cases', async (req, reply) => {
    const project = await projectOf((req.params as { id: string }).id);
    const raw = RawTestCaseSchema.omit({ row: true }).parse(req.body);
    const model = parseTestCase(raw);
    await store.upsertTestCase(project.id, { ...raw, id: model.id }, { kind: 'form' }, 'written in the form');
    const job = await store.createJob({ projectId: project.id, kind: 'single', input: { case: { ...raw, id: model.id } } });
    runner.enqueue(job);
    return reply.status(202).send(job);
  });

  // The test case list: every case written or imported, kept with its versions and runs (item 1, item 3)

  const caseOf = async (projectId: string, extId: string) =>
    (await store.testCase(projectId, extId)) ??
    (() => {
      throw notFound('Test case');
    })();

  app.get('/api/projects/:id/test-cases', async (req) => store.testCases((await projectOf((req.params as { id: string }).id)).id));

  app.get('/api/projects/:id/test-cases/:caseId', async (req) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const record = await caseOf(project.id, params.caseId);
    return { ...record, versions: await store.testCaseVersions(record.id), runs: await store.testCaseRuns(project.id, record.extId) };
  });

  /** Edit a saved test case: it becomes a new version; running it again explores the changed steps. */
  app.put('/api/projects/:id/test-cases/:caseId', async (req) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const current = await caseOf(project.id, params.caseId);
    const raw = RawTestCaseSchema.omit({ row: true }).parse(req.body);
    parseTestCase(raw); // refuses a case that cannot be read at all
    return store.upsertTestCase(
      project.id,
      { ...raw, id: current.extId },
      { kind: current.sourceKind, ref: current.sourceRef, row: current.sourceRow },
      'edited',
    );
  });

  app.delete('/api/projects/:id/test-cases/:caseId', async (req) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    if (!(await store.deleteTestCase(project.id, params.caseId))) throw notFound('Test case');
    return { ok: true };
  });

  /**
   * "Save what was seen as the expected result" (FR-VAL-13): the check could not be verified, the tester looked at what the
   * page showed and says it is right, so the sentence is replaced by checks that say it. They are verified from now on.
   */
  app.post('/api/projects/:id/test-cases/:caseId/accept-observation', async (req) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const record = await caseOf(project.id, params.caseId);
    const body = z
      .object({
        check: z.string().min(1),
        facts: z.object({
          path: z.string().optional(),
          headings: z.array(z.string()).default([]),
          messages: z.array(z.string()).default([]),
          dialogs: z.array(z.string()).default([]),
        }),
      })
      .parse(req.body);
    const lines = [
      ...(body.facts.path && body.facts.path !== '/' ? [`The URL contains "${body.facts.path}"`] : []),
      ...body.facts.headings.slice(0, 1).map((h) => `"${h}" is displayed`),
      ...body.facts.messages.slice(0, 2).map((m) => `Message "${m}" is shown`),
      ...body.facts.dialogs.slice(0, 1).map((d) => `The browser shows ${/"([\s\S]*)"/.exec(d)?.[1] ?? d}`),
    ];
    if (!lines.length) throw bad('The page showed nothing that can be saved as a check.');
    if (!record.raw.expected.includes(body.check)) throw Object.assign(new Error('That sentence is no longer in the expected result.'), { statusCode: 409 });
    const raw = { ...record.raw, expected: record.raw.expected.replace(body.check, lines.join('; ')) };
    return store.upsertTestCase(
      project.id,
      { ...raw, id: record.extId },
      { kind: record.sourceKind, ref: record.sourceRef, row: record.sourceRow },
      'edited: what the page showed was saved as the expected result',
    );
  });

  /** Run a saved test case again. If its steps are unchanged the earlier exploration is reused and it runs straight away. */
  app.post('/api/projects/:id/test-cases/:caseId/run', async (req, reply) => {
    const params = req.params as { id: string; caseId: string };
    const project = await projectOf(params.id);
    const record = await caseOf(project.id, params.caseId);
    const job = await store.createJob({ projectId: project.id, kind: 'single', input: { case: { ...record.raw, id: record.extId }, rerun: true } });
    runner.enqueue(job);
    return reply.status(202).send(job);
  });

  // Jobs, questions, results (FR-RV-02, FR-HI-01, FR-HI-06)

  app.get('/api/projects/:id/jobs', async (req) => store.jobs((await projectOf((req.params as { id: string }).id)).id));

  app.get('/api/jobs/:id', async (req) => {
    const job =
      (await store.job((req.params as { id: string }).id)) ??
      (() => {
        throw notFound('Job');
      })();
    return { ...job, logs: await store.logs(job.id), questions: await store.openQuestions(job.id), verdicts: await store.verdicts(job.id) };
  });

  const decide = (action: Decision['action']) => async (req: { params: unknown; body: unknown }) => {
    const id = (req.params as { id: string }).id;
    const decision: Decision = action === 'edit' ? { action, case: EditBody.parse(req.body).case } : ({ action } as Decision);
    if (!runner.decide(id, decision)) throw bad('This job is not waiting for review.');
    return { ok: true };
  };
  app.post('/api/jobs/:id/approve', decide('approve'));
  app.post('/api/jobs/:id/regenerate', decide('regenerate'));
  app.post('/api/jobs/:id/edit', decide('edit'));

  app.post('/api/jobs/:id/cancel', async (req) => {
    await runner.cancel((req.params as { id: string }).id);
    return { ok: true };
  });

  /** A workbook's review queue, answered interactively in the UI. */
  app.post('/api/jobs/:id/review-queue', async (req, reply) => {
    const job =
      (await store.job((req.params as { id: string }).id)) ??
      (() => {
        throw notFound('Job');
      })();
    if (job.kind !== 'workbook') throw bad('Only a workbook job has a review queue.');
    const next = await store.createJob({ projectId: job.projectId, kind: 'workbook', input: { ...job.input, onlyReview: true } });
    runner.enqueue(next);
    return reply.status(202).send(next);
  });

  app.post('/api/questions/:id/answer', async (req) => {
    const { answer } = AnswerBody.parse(req.body);
    if (!(await runner.answer(Number((req.params as { id: string }).id), answer))) throw bad('This question is not waiting for an answer.');
    return { ok: true };
  });

  app.get('/api/jobs/:id/results', async (req, reply) => {
    const job =
      (await store.job((req.params as { id: string }).id)) ??
      (() => {
        throw notFound('Job');
      })();
    const file = job.output.resultsFile as string | undefined;
    if (!file || !existsSync(file)) throw notFound('Results workbook');
    return reply
      .header('content-disposition', `attachment; filename="${path.basename(file)}"`)
      .type(file.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(createReadStream(file));
  });

  /** Screenshots and traces, only from the platform's own folders. */
  app.get('/api/files', async (req, reply) => {
    const requested = path.resolve(String((req.query as { path?: string }).path ?? ''));
    const roots = [path.resolve(options.dataDir), path.resolve(options.workspacesDir)];
    if (!roots.some((r) => requested === r || requested.startsWith(r + path.sep))) throw Object.assign(new Error('Not allowed'), { statusCode: 403 });
    if (!existsSync(requested) || !(await stat(requested)).isFile()) throw notFound('File');
    const type = requested.endsWith('.png') ? 'image/png' : requested.endsWith('.zip') ? 'application/zip' : 'application/octet-stream';
    return reply.type(type).send(createReadStream(requested));
  });

  // The web UI (M7b), with its routes falling back to index.html.
  if (options.webDir && existsSync(path.join(options.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: path.resolve(options.webDir) });
    // Read on every request: a rebuilt UI has new asset names, and a running server must serve them.
    const indexFile = path.join(options.webDir, 'index.html');
    app.setNotFoundHandler(async (req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Not found' }) : reply.type('text/html').send(await readFile(indexFile, 'utf8')),
    );
  }
  return app;

  function mappingFile(project: Project): string {
    return runner.projectDir(project, 'mapping.json');
  }
  async function savedMapping(project: Project): Promise<Partial<Record<Field, string>>> {
    return JSON.parse(await readFile(mappingFile(project), 'utf8').catch(() => '{}'));
  }
}

/** What the mapping screen shows: the columns found and the first rows as test cases (FR-IN-02). */
async function preview(file: string, mapping: Partial<Record<Field, string>>) {
  try {
    const r = await readWorkbook(file, { mapping });
    return {
      ok: true,
      fileName: path.basename(file),
      sheet: r.sheet,
      headerRow: r.headerRow,
      headers: r.headers,
      columns: r.columns,
      unmatched: r.unmatched,
      total: r.cases.length,
      problems: r.problems,
      warnings: r.warnings,
      sample: r.cases.slice(0, 5).map((c) => ({ row: c.row, id: c.raw.id, title: c.raw.title, steps: c.raw.steps, expected: c.raw.expected })),
      fields: FIELDS,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, fields: FIELDS };
  }
}
