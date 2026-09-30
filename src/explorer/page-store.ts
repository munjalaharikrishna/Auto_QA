import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Page URLs learned during exploration, kept per environment (D19): keyed by the base URL's
 * origin, stored as paths, so one app never uses another's pages.
 */
const FILE = path.join('.auto-qa', 'pages.json');

export async function loadPageUrls(baseUrl: string, file = FILE): Promise<Record<string, string>> {
  if (!existsSync(file)) return {};
  const all = JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, string>>;
  return all[new URL(baseUrl).origin] ?? {};
}

export async function savePageUrls(baseUrl: string, learned: Record<string, string>, file = FILE): Promise<void> {
  if (!Object.keys(learned).length) return;
  const all = existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, string>>) : {};
  const key = new URL(baseUrl).origin;
  all[key] = { ...all[key], ...learned };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(all, null, 2)}\n`);
}
