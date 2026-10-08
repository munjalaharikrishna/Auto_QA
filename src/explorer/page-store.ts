import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Page URLs learned during exploration, kept per environment (D19). The server keeps them as page routes in the
 * database; the command line, which has no database, keeps them in a file keyed by the base URL's origin.
 */
export interface PageStore {
  load(): Promise<Record<string, string>>;
  save(learned: Record<string, string>): Promise<void>;
}

const FILE = path.join('.auto-qa', 'pages.json');

export async function loadPageUrls(baseUrl: string, file = FILE): Promise<Record<string, string>> {
  return (await readAll(file))[new URL(baseUrl).origin] ?? {};
}

export async function savePageUrls(baseUrl: string, learned: Record<string, string>, file = FILE): Promise<void> {
  if (!Object.keys(learned).length) return;
  const all = await readAll(file);
  const key = new URL(baseUrl).origin;
  all[key] = { ...all[key], ...learned };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(all, null, 2)}
`,
  );
}

/** Everything in the file, by origin: what `Store.importPageUrls` moves into the database. */
export async function readAll(file = FILE): Promise<Record<string, Record<string, string>>> {
  if (!existsSync(file)) return {};
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, string>>;
}

export function filePageStore(baseUrl: string, file = FILE): PageStore {
  return { load: () => loadPageUrls(baseUrl, file), save: (learned) => savePageUrls(baseUrl, learned, file) };
}
