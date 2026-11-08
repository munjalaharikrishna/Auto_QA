/**
 * E0.19 step 1: the review KPIs of real runs, measured at run time against the frozen baseline (test/baseline/kpi-baseline.json).
 *
 *   npm run engine:kpi -- --batch .auto-qa/batches/ohrm-add-dd25ddc3.json      a batch run of the command line (repeat for more)
 *   npm run engine:kpi -- --job JOB-13d1754e64                                  a run of the app, with review time and walkthroughs
 *   npm run engine:kpi -- --project book-market                                 the last workbook run of a project
 *   ... --key answer-key.json     also count wrong PASS and wrong FAIL against an answer key
 *   ... --json                    the numbers as JSON          --save file.json   also write them to a file
 *
 * The database is read from a snapshot, so the live file is never opened for writing. The baseline is never changed by this tool.
 */
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { LocalArtifactStore } from '../db/artifacts.js';
import { type Job, Store } from '../db/store.js';
import { type AnswerKey, AnswerKeySchema, REVIEW_REDUCTION_MINIMUM } from '../engine/governance/index.js';
import type { TestVerdict } from '../results/verdict.js';
import type { StoredVerdict } from '../review/cards.js';
import { inForce } from '../review/holds.js';
import { type KpiBaseline, KpiBaselineSchema, kpiText, kpiTotal, type RunKpi, runKpiOf } from '../review/kpi.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flags = (name: string): string[] => args.filter((_a, i) => args[i - 1] === name);
const flag = (name: string): string | undefined => flags(name)[0];

const batches = flags('--batch');
const jobIds = flags('--job');
const projects = flags('--project');
if (!batches.length && !jobIds.length && !projects.length) {
  console.error(
    'Usage: npm run engine:kpi -- (--batch <file> | --job <id> | --project <id>)... [--key <answer key>] [--baseline <file>] [--json] [--save <file>]',
  );
  process.exit(1);
}

const baseline: KpiBaseline = KpiBaselineSchema.parse(
  JSON.parse(await readFile(path.resolve(flag('--baseline') ?? path.join(root, 'test/baseline/kpi-baseline.json')), 'utf8')),
);
const keyFile = flag('--key');
const key: AnswerKey | undefined = keyFile ? AnswerKeySchema.parse(JSON.parse(await readFile(path.resolve(keyFile), 'utf8'))) : undefined;

const kpis: RunKpi[] = [];

for (const file of batches) {
  const data = JSON.parse(await readFile(path.resolve(file), 'utf8')) as { file?: string; verdicts?: Record<string, TestVerdict> };
  const rows: StoredVerdict[] = Object.values(data.verdicts ?? {}).map((v) => ({ testId: v.testId, status: v.status, verdict: v }));
  if (!rows.length) throw new Error(`${file} holds no verdicts.`);
  kpis.push(runKpiOf({ run: path.basename(file), rows, baseline, ...(key ? { key } : {}) }));
}

if (jobIds.length || projects.length) {
  const dataDir = path.resolve(flag('--data-dir') ?? process.env.AUTO_QA_DATA ?? path.join(root, '.auto-qa'));
  const workspacesDir = path.resolve(process.env.AUTO_QA_WORKSPACES ?? path.join(root, 'workspaces'));
  const live = path.join(dataDir, 'auto-qa.db');
  if (!existsSync(live)) throw new Error(`No database at ${live}.`);
  const snapshot = path.join(mkdtempSync(path.join(tmpdir(), 'aq-kpi-')), 'snapshot.db');
  const source = new DatabaseSync(live, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${snapshot.split("'").join("''")}'`);
  } catch {
    copyFileSync(live, snapshot);
  } finally {
    source.close();
  }
  const store = await Store.open(snapshot, { artifacts: new LocalArtifactStore({ local: dataDir, workspace: workspacesDir }) });
  try {
    const jobs: Job[] = [];
    for (const id of jobIds) {
      const job = await store.job(id);
      if (!job) throw new Error(`There is no job ${id}.`);
      jobs.push(job);
    }
    for (const p of projects) {
      const last = (await store.jobs(p, 500)).find((j) => (j.kind === 'workbook' || j.kind === 'single') && j.finishedAt);
      if (!last) throw new Error(`Project ${p} has no finished run.`);
      jobs.push(last);
    }
    for (const job of jobs) {
      const rows = (await store.verdicts(job.id)).map((r) => ({ ...r, verdict: r.verdict as TestVerdict }));
      if (!rows.length) throw new Error(`Job ${job.id} holds no verdicts.`);
      // Walkthroughs after this run and before the next run of the project: the person's time spent teaching, part of review.
      const all = await store.jobs(job.projectId, 500);
      const next = all
        .filter((j) => j.kind !== 'walkthrough' && j.createdAt > job.createdAt)
        .map((j) => j.createdAt)
        .sort()[0];
      const walkthroughs = all.filter((j) => j.kind === 'walkthrough' && j.createdAt > job.createdAt && (!next || j.createdAt < next));
      kpis.push(
        runKpiOf({
          run: job.id,
          rows,
          baseline,
          ...(key ? { key } : {}),
          activity: await store.reviewActivity(job.id),
          held: new Map([...inForce(await store.heldCases(job.projectId))].map(([id, h]) => [id, { owner: h.owner, until: h.until }])),
          walkthroughs: walkthroughs.map((w) => ({
            ...(w.startedAt ? { startedAt: w.startedAt } : {}),
            ...(w.finishedAt ? { finishedAt: w.finishedAt } : {}),
          })),
        }),
      );
    }
  } finally {
    await store.close();
  }
}

const report = { baseline: { version: baseline.version, frozenOn: baseline.frozenOn }, runs: kpis, total: kpiTotal(kpis) };
const save = flag('--save');
if (save) await writeFile(path.resolve(save), `${JSON.stringify(report, null, 2)}\n`);
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : kpiText(kpis, baseline, REVIEW_REDUCTION_MINIMUM));
// Any wrong PASS against the key fails the command, as the benchmark does (GV-09).
if (kpis.some((k) => (k.answerKey?.wrongPass.length ?? 0) > 0)) process.exitCode = 1;
