import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactStore } from './artifacts.js';
import type { Store } from './store.js';

/**
 * `db verify`, the file half (DATABASE.md §7.6): every reference in the database names a file that exists, and the evidence
 * folder of a run holds no file the database does not know. Reports only; it never deletes anything.
 *
 * Runs recorded before evidence rows existed have none, so their folders are not checked: a file can only be an orphan
 * of a run that has evidence rows.
 */
export async function fileProblems(store: Store, artifacts: ArtifactStore, dataDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const r of await store.storageRefs()) {
    if (!artifacts.exists(r.ref)) found.push(`${r.table} ${r.id} points to a missing file ${r.ref}`);
  }
  const projects = path.join(dataDir, 'projects');
  if (!existsSync(projects)) return found;
  for (const project of readdirSync(projects)) {
    const runs = path.join(projects, project, 'runs');
    if (!existsSync(runs)) continue;
    for (const execId of readdirSync(runs).filter((n) => n.startsWith('EXEC-'))) {
      const known = await store.executionEvidenceRefs(project, execId);
      if (!known.size) continue;
      const dir = path.join(runs, execId, 'evidence');
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const file = path.join(dir, f);
        if (!statSync(file).isFile()) continue;
        const ref = artifacts.toRef(file);
        if (ref && !known.has(ref)) found.push(`orphan file ${ref}: no evidence row names it`);
      }
    }
  }
  return found;
}
