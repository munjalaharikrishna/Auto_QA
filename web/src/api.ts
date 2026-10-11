import type { BatchSummary } from '../../src/importer/results.js';
import type { RawTestCase } from '../../src/model/test-model.js';
import type { ReleaseSummary } from '../../src/releases/impact.js';
import type { ReviewReason, TestVerdict } from '../../src/results/verdict.js';
import type { Job, Project, Question, ReleaseChange, ReleaseFeature, ReleaseRecord, TestCaseRecord, TestCaseRun } from '../../src/server/store.js';
import type { CatalogueEntry } from '../../src/validations/catalogue.js';

/** Typed calls to the platform API (src/server/app.ts). */

export type {
  BatchSummary,
  CatalogueEntry,
  Job,
  Project,
  Question,
  RawTestCase,
  ReleaseChange,
  ReleaseFeature,
  ReleaseRecord,
  ReleaseSummary,
  ReviewReason,
  TestCaseRecord,
  TestCaseRun,
  TestVerdict,
};

export type Policy = 'strict' | 'balanced' | 'lenient';

export interface ProjectRule {
  id: string;
  kind: 'step' | 'check' | 'element' | 'approved';
  pattern: string;
  meaning: string;
  source: string;
  enabled: boolean;
  createdAt: string;
}

/** The questions of a whole batch grouped by wording, and the learned values waiting for a yes (FR-RV-09, FR-RV-10). */
export interface ReviewGroups {
  questions: Array<{
    key: string;
    kind: 'step' | 'check';
    raw: string;
    headline: string;
    why: string;
    todo: string[];
    cases: Array<{ testId: string; id: string }>;
    rule?: ProjectRule;
  }>;
  assumptions: Array<{ text: string; testIds: string[] }>;
}

export interface ProjectView extends Project {
  /** How much may be decided without asking (D30). */
  policy: Policy;
  env: { username?: string; hasPassword: boolean; variables: Array<{ name: string; secret: boolean; value?: string }> };
}

export interface ProjectInput {
  name: string;
  baseUrl: string;
  testIdAttribute?: string;
  browser?: 'chromium';
  username?: string;
  password?: string;
  variables?: Record<string, string | null>;
  policy?: Policy;
}

export type Field = 'id' | 'title' | 'type' | 'preconditions' | 'steps' | 'testData' | 'expected' | 'requirementId';

export interface Preview {
  uploadId: string;
  /** The mapping reused from the project's last run (FR-IN-02). */
  mapping?: Partial<Record<Field, string>>;
  ok: boolean;
  error?: string;
  fileName?: string;
  sheet?: string;
  headerRow?: number;
  headers?: string[];
  columns?: Partial<Record<Field, number>>;
  unmatched?: string[];
  total?: number;
  problems?: Array<{ row: number; id?: string; title?: string; text: string }>;
  warnings?: string[];
  sample?: Array<{ row: number; id?: string; title: string; steps: string; expected: string }>;
  fields: Field[];
}

export interface ReviewItem {
  id: string;
  phase: 'setup' | 'test';
  kind: 'step' | 'check';
  raw: string;
  action?: string;
  type?: string;
  status: 'done' | 'skipped' | 'failed' | 'not-run';
  locator?: { code: string; strategy: string; source: string; validated: boolean };
  score?: number;
  resolvedBy?: 'rules' | 'tester';
  page?: string;
  effect?: string;
  screenshot?: string;
  warnings: string[];
  error?: string;
  /** Why it was set aside or failed, and what the tester can do. */
  review?: { headline: string; why: string; todo: string[] };
  /** Why there is no screenshot, when there is none. */
  noScreenshot?: string;
}

export interface Review {
  testId: string;
  title: string;
  warnings: Array<{ at?: string; code: string; text: string }>;
  blocked?: { status: string; reason: string; category?: string; review?: ReviewReason[] };
  items: ReviewItem[];
  changes: Array<{ path: string; added: boolean; patch: string }>;
}

export interface JobDetail extends Job {
  logs: Array<{ at: string; message: string }>;
  questions: Question[];
  verdicts: Array<{ testId: string; row?: number; status: string; verdict: TestVerdict & { problem?: string } }>;
}

export type ScriptState = 'none' | 'ready' | 'out-of-date';
export type AutomationCase = TestCaseRecord & { projectName: string; script: ScriptState; scriptReady: boolean; running: boolean };

export interface ReleaseCase {
  extId: string;
  title: string;
  approval: 'draft' | 'approved';
  lastStatus?: string;
}
export interface ReleaseDetail extends ReleaseRecord {
  features: ReleaseFeature[];
  changes: ReleaseChange[];
  summary: ReleaseSummary;
  cases: ReleaseCase[];
}
export interface ReleaseInput {
  name: string;
  version: string;
  scope: string;
  teamSize: number;
  startDate?: string;
  plannedDate: string;
  features: Array<{ title: string; effortDays: number; caseIds: string[] }>;
}
export interface FeatureInput {
  title: string;
  description?: string;
  requirementId?: string;
  effortDays: number;
  caseIds: string[];
  reason?: string;
  newDate?: string;
}
export interface Impact {
  dueDate: string;
  suggestedDate: string;
  extraCalendarDays: number;
  teamSize: number;
  effortDaysAfter: number;
  scopeGrowthPercentAfter: number;
}
export interface Dashboard {
  totals: { projects: number; cases: number; approved: number; scripts: number; pass: number; fail: number; notRun: number };
  projects: Array<{
    project: { id: string; name: string; baseUrl: string };
    cases: { total: number; approved: number; draft: number; scripts: number; pass: number; fail: number; notRun: number };
    executions: Array<{ execId: string; status: string; totals: Record<string, number>; startedAt?: string }>;
    releases: Array<ReleaseRecord & { summary: ReleaseSummary }>;
  }>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof body === 'object' && body?.error ? body.error : `${res.status} ${res.statusText}`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  projects: () => call<ProjectView[]>('/api/projects'),
  project: (id: string) => call<ProjectView>(`/api/projects/${id}`),
  createProject: (p: ProjectInput) => call<ProjectView>('/api/projects', json('POST', p)),
  updateProject: (id: string, p: Partial<ProjectInput>) => call<ProjectView>(`/api/projects/${id}`, json('PATCH', p)),
  upload: (projectId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return call<Preview>(`/api/projects/${projectId}/uploads`, { method: 'POST', body: form });
  },
  preview: (uploadId: string, mapping: Partial<Record<Field, string>>) => call<Preview>(`/api/uploads/${uploadId}/preview`, json('POST', { mapping })),
  importUpload: (uploadId: string, mapping: Partial<Record<Field, string>>) =>
    call<{ added: number; updated: number; kept: number; total: number; problems: string[] }>(`/api/uploads/${uploadId}/import`, json('POST', { mapping })),
  runUpload: (uploadId: string, mapping: Partial<Record<Field, string>>) => call<Job>(`/api/uploads/${uploadId}/run`, json('POST', { mapping })),
  submitCase: (projectId: string, c: Omit<RawTestCase, 'row'>) => call<Job>(`/api/projects/${projectId}/cases`, json('POST', c)),
  jobs: (projectId: string) => call<Job[]>(`/api/projects/${projectId}/jobs`),
  job: (id: string) => call<JobDetail>(`/api/jobs/${id}`),
  approve: (id: string) => call(`/api/jobs/${id}/approve`, json('POST', {})),
  regenerate: (id: string) => call(`/api/jobs/${id}/regenerate`, json('POST', {})),
  edit: (id: string, c: Omit<RawTestCase, 'row'>) => call(`/api/jobs/${id}/edit`, json('POST', { case: c })),
  cancel: (id: string) => call(`/api/jobs/${id}/cancel`, json('POST', {})),
  reviewQueue: (id: string) => call<Job>(`/api/jobs/${id}/review-queue`, json('POST', {})),
  testCases: (projectId: string) => call<TestCaseRecord[]>(`/api/projects/${projectId}/test-cases`),
  testCase: (projectId: string, id: string) =>
    call<TestCaseRecord & { versions: Array<{ version: number; reason: string; createdAt: string; raw: RawTestCase }>; runs: TestCaseRun[] }>(
      `/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}`,
    ),
  updateTestCase: (projectId: string, id: string, c: Omit<RawTestCase, 'row'>) =>
    call<TestCaseRecord>(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}`, json('PUT', c)),
  deleteTestCase: (projectId: string, id: string) => call(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  saveObservation: (projectId: string, id: string, body: { check: string; facts: unknown }) =>
    call<TestCaseRecord>(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}/accept-observation`, json('POST', body)),
  runTestCase: (projectId: string, id: string) => call<Job>(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}/run`, json('POST', {})),
  setApproval: (projectId: string, id: string, approval: 'draft' | 'approved') =>
    call<TestCaseRecord>(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}/approval`, json('PUT', { approval })),
  automation: () => call<AutomationCase[]>('/api/automation'),
  recordCase: (projectId: string, id: string) => call<Job>(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}/record`, json('POST', {})),
  scriptPreview: (projectId: string, id: string) =>
    call<{ files: Array<{ name: string; content: string }> }>(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}/script/preview`),
  validations: () => call<CatalogueEntry[]>('/api/validations'),
  addAssertion: (projectId: string, id: string, text: string) =>
    call<TestCaseRecord>(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}/assertions`, json('POST', { text })),
  dashboard: () => call<Dashboard>('/api/dashboard'),
  allReleases: () => call<Array<ReleaseRecord & { projectName: string; summary: ReleaseSummary }>>('/api/releases'),
  releases: (projectId: string) => call<ReleaseDetail[]>(`/api/projects/${projectId}/releases`),
  createRelease: (projectId: string, r: ReleaseInput) => call<ReleaseDetail>(`/api/projects/${projectId}/releases`, json('POST', r)),
  updateRelease: (
    projectId: string,
    id: string,
    r: Partial<Pick<ReleaseInput, 'name' | 'version' | 'scope' | 'teamSize'>> & { status?: ReleaseRecord['status'] },
  ) => call<ReleaseDetail>(`/api/projects/${projectId}/releases/${id}`, json('PATCH', r)),
  deleteRelease: (projectId: string, id: string) => call(`/api/projects/${projectId}/releases/${id}`, { method: 'DELETE' }),
  lockRelease: (projectId: string, id: string) => call<ReleaseDetail>(`/api/projects/${projectId}/releases/${id}/lock`, json('POST', {})),
  releaseImpact: (projectId: string, id: string, effortDays: number) =>
    call<Impact>(`/api/projects/${projectId}/releases/${id}/impact`, json('POST', { effortDays })),
  addFeature: (projectId: string, id: string, f: FeatureInput) =>
    call<{ feature: ReleaseFeature; release: ReleaseDetail }>(`/api/projects/${projectId}/releases/${id}/features`, json('POST', f)),
  updateFeature: (projectId: string, id: string, fid: string, f: Partial<{ status: ReleaseFeature['status']; caseIds: string[]; effortDays: number }>) =>
    call<ReleaseDetail>(`/api/projects/${projectId}/releases/${id}/features/${fid}`, json('PATCH', f)),
  removeFeature: (projectId: string, id: string, fid: string, c: { reason?: string; newDate?: string }) =>
    call<ReleaseDetail>(`/api/projects/${projectId}/releases/${id}/features/${fid}`, json('DELETE', c)),
  moveRelease: (projectId: string, id: string, newDate: string, reason: string) =>
    call<ReleaseDetail>(`/api/projects/${projectId}/releases/${id}/date`, json('POST', { newDate, reason })),
  rules: (projectId: string) => call<ProjectRule[]>(`/api/projects/${projectId}/rules`),
  saveRule: (projectId: string, r: { kind: string; pattern: string; meaning: string; source?: string }) =>
    call<ProjectRule>(`/api/projects/${projectId}/rules`, json('POST', r)),
  updateRule: (projectId: string, id: string, changes: { meaning?: string; enabled?: boolean }) =>
    call<ProjectRule>(`/api/projects/${projectId}/rules/${id}`, json('PATCH', changes)),
  deleteRule: (projectId: string, id: string) => call(`/api/projects/${projectId}/rules/${id}`, { method: 'DELETE' }),
  importRules: (projectId: string, rules: unknown[]) => call<{ imported: number }>(`/api/projects/${projectId}/rules/import`, json('POST', { rules })),
  approveValues: (projectId: string, texts: string[]) => call(`/api/projects/${projectId}/rules/approve`, json('POST', { texts })),
  reviewGroups: (jobId: string) => call<ReviewGroups>(`/api/jobs/${jobId}/review-groups`),
  answer: (questionId: number, answer: unknown) => call(`/api/questions/${questionId}/answer`, json('POST', { answer })),
};

/** A screenshot or trace kept by the platform. */
export const fileUrl = (file: string) => `/api/files?path=${encodeURIComponent(file)}`;
export const resultsUrl = (jobId: string) => `/api/jobs/${jobId}/results`;
