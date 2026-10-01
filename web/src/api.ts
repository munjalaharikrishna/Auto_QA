import type { BatchSummary } from '../../src/importer/results.js';
import type { RawTestCase } from '../../src/model/test-model.js';
import type { ReviewReason, TestVerdict } from '../../src/results/verdict.js';
import type { Job, Project, Question, TestCaseRecord, TestCaseRun } from '../../src/server/store.js';

/** Typed calls to the platform API (src/server/app.ts). */

export type { BatchSummary, Job, Project, Question, RawTestCase, ReviewReason, TestCaseRecord, TestCaseRun, TestVerdict };

export interface ProjectView extends Project {
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
  status: 'done' | 'skipped' | 'failed';
  locator?: { code: string; strategy: string; source: string; validated: boolean };
  score?: number;
  resolvedBy?: 'rules' | 'tester';
  page?: string;
  effect?: string;
  screenshot?: string;
  warnings: string[];
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
  runTestCase: (projectId: string, id: string) => call<Job>(`/api/projects/${projectId}/test-cases/${encodeURIComponent(id)}/run`, json('POST', {})),
  answer: (questionId: number, answer: unknown) => call(`/api/questions/${questionId}/answer`, json('POST', { answer })),
};

/** A screenshot or trace kept by the platform. */
export const fileUrl = (file: string) => `/api/files?path=${encodeURIComponent(file)}`;
export const resultsUrl = (jobId: string) => `/api/jobs/${jobId}/results`;
