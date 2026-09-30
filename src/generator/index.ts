import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type GenerateInput, type ProjectPlan, planProject } from './plan.js';
import { renderProject } from './render.js';

export type { GenerateInput, ProjectPlan } from './plan.js';

/**
 * Code generation (M5): explored test cases → a standalone Playwright project (D5, D15).
 * Returns the files; `writeProject` puts them on disk.
 */
export async function generateProject(inputs: GenerateInput[], name: string): Promise<{ plan: ProjectPlan; files: Record<string, string> }> {
  const plan = planProject(inputs);
  return { plan, files: await renderProject(plan, name) };
}

/** Writes every file, and reports which ones changed so review can show a diff (FR-RV-04). */
export async function writeProject(dir: string, files: Record<string, string>): Promise<{ written: string[]; unchanged: string[] }> {
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    const before = await readFile(file, 'utf8').catch(() => undefined);
    if (before === content) {
      unchanged.push(rel);
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    written.push(rel);
  }
  return { written, unchanged };
}

/** `https://www.saucedemo.com` → saucedemo, `http://127.0.0.1:4173` → 127-0-0-1-4173. */
export function workspaceName(baseUrl: string): string {
  const u = new URL(baseUrl);
  const host = u.hostname.replace(/^www\./, '');
  const label = /^[\d.]+$/.test(host) || host === 'localhost' ? `${host}${u.port ? `-${u.port}` : ''}` : host.split('.')[0];
  return label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}
