import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Page URLs learned during exploration, kept per environment (D19). The server keeps them as page routes in the
 * database; the command line, which has no database, keeps them in a file keyed by the base URL's origin.
 */
export interface PageStore {
  load(): Promise<Record<string, string>>;
  /** `confirmed`: the pages of `learned` a person confirmed (E0.18); the others were learned without one. */
  save(learned: Record<string, string>, confirmed?: readonly string[]): Promise<void>;
  /**
   * The pages whose address was saved without a person (E0.18, owner 7 Nov 2026): they still open pages, but never prove a URL check.
   * A store that cannot tell gives none.
   */
  unconfirmed?(): Promise<ReadonlySet<string>>;
}

/** Where the command line keeps the pages a person confirmed, beside the addresses: the address file keeps its shape. */
const confirmedFile = (file: string): string => file.replace(/.json$/, '.confirmed.json');

async function readConfirmed(file: string): Promise<Record<string, string[]>> {
  const at = confirmedFile(file);
  return existsSync(at) ? (JSON.parse(await readFile(at, 'utf8')) as Record<string, string[]>) : {};
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
  const origin = new URL(baseUrl).origin;
  return {
    load: () => loadPageUrls(baseUrl, file),
    save: async (learned, confirmed = []) => {
      await savePageUrls(baseUrl, learned, file);
      if (!confirmed.length) return;
      const all = await readConfirmed(file);
      all[origin] = [...new Set([...(all[origin] ?? []), ...confirmed])];
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        confirmedFile(file),
        `${JSON.stringify(all, null, 2)}
`,
      );
    },
    unconfirmed: async () => {
      const yes = new Set((await readConfirmed(file))[origin] ?? []);
      return new Set(Object.keys(await loadPageUrls(baseUrl, file)).filter((n) => !yes.has(n)));
    },
  };
}
