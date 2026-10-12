import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compactKey } from '../text/compound.js';
import { type Application, ApplicationSchema } from './schema.js';

/**
 * Layer 20, the application knowledge base (AK-01) as a store: one file for the current knowledge of an application and
 * one for every version it has had, so a run can say which knowledge it was made with and a change can be undone.
 * The files are plain JSON, written the same way every time, so a diff shows exactly what changed.
 */

const fileName = (app: string): string => `${compactKey(app) || 'application'}`;

export class KnowledgeStore {
  constructor(private readonly dir: string) {}

  /** Saves the knowledge as the next version and returns it. The version in the data is ignored: the store counts. */
  async save(app: Omit<Application, 'version'> & { version?: number }): Promise<Application> {
    const parsed = ApplicationSchema.parse(app);
    const next = (await this.versions(parsed.name)).at(-1) ?? 0;
    const saved: Application = { ...parsed, version: next + 1 };
    await mkdir(this.dir, { recursive: true });
    const text = `${JSON.stringify(saved, null, 2)}\n`;
    await writeFile(path.join(this.dir, `${fileName(saved.name)}.json`), text);
    await writeFile(path.join(this.dir, `${fileName(saved.name)}.v${saved.version}.json`), text);
    return saved;
  }

  /** The current knowledge, or one version of it. A file that does not fit the schema is an error naming the field. */
  async load(name: string, version?: number): Promise<Application | undefined> {
    const file = path.join(this.dir, version === undefined ? `${fileName(name)}.json` : `${fileName(name)}.v${version}.json`);
    if (!existsSync(file)) return undefined;
    return ApplicationSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  }

  /** The versions that exist, oldest first. */
  async versions(name: string): Promise<number[]> {
    if (!existsSync(this.dir)) return [];
    const prefix = `${fileName(name)}.v`;
    const found = (await readdir(this.dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => Number(f.slice(prefix.length, -5)));
    return found.filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  }
}

export interface KnowledgeChange {
  kind: 'page' | 'component' | 'alias' | 'route' | 'vocabulary' | 'rule';
  change: 'added' | 'removed' | 'changed';
  what: string;
}

/** What differs between two versions, in words: for the review of an edit. */
export function diffKnowledge(before: Application, after: Application): KnowledgeChange[] {
  const out: KnowledgeChange[] = [];
  const pagesBefore = new Map(before.pages.map((p) => [p.name, p]));
  const pagesAfter = new Map(after.pages.map((p) => [p.name, p]));
  for (const [name, page] of pagesAfter) {
    const old = pagesBefore.get(name);
    if (!old) {
      out.push({ kind: 'page', change: 'added', what: name });
      continue;
    }
    if (old.route !== page.route) out.push({ kind: 'route', change: 'changed', what: `${name}: ${old.route ?? '(none)'} → ${page.route ?? '(none)'}` });
    const before_ = new Map(old.components.map((c) => [c.name, c]));
    const after_ = new Map(page.components.map((c) => [c.name, c]));
    for (const [cn, c] of after_) {
      const oc = before_.get(cn);
      if (!oc) out.push({ kind: 'component', change: 'added', what: `${name}: ${cn}` });
      else
        for (const alias of c.aliases.filter((a) => !oc.aliases.includes(a)))
          out.push({ kind: 'alias', change: 'added', what: `${name}: ${cn} also called "${alias}"` });
    }
    for (const cn of before_.keys()) if (!after_.has(cn)) out.push({ kind: 'component', change: 'removed', what: `${name}: ${cn}` });
  }
  for (const name of pagesBefore.keys()) if (!pagesAfter.has(name)) out.push({ kind: 'page', change: 'removed', what: name });
  const terms = (a: Application) => new Set(a.vocabulary.map((v) => v.term));
  for (const t of terms(after)) if (!terms(before).has(t)) out.push({ kind: 'vocabulary', change: 'added', what: t });
  for (const t of terms(before)) if (!terms(after).has(t)) out.push({ kind: 'vocabulary', change: 'removed', what: t });
  const rules = (a: Application) => new Set(a.rules.map((r) => r.id));
  for (const r of rules(after)) if (!rules(before).has(r)) out.push({ kind: 'rule', change: 'added', what: r });
  return out;
}

/**
 * An application's own words (PD-3). A term is the class it stands for in this application, or nothing: the core
 * ontology has no application words, and another application's knowledge does not have this one's.
 */
export function applicationClass(kb: Application | undefined, term: string): string | undefined {
  if (!kb) return undefined;
  const key = compactKey(term);
  const hit = kb.vocabulary.find((v) => [v.term, ...v.aliases].some((t) => compactKey(t) === key));
  return hit?.ontology;
}
