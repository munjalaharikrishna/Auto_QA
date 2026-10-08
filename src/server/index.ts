/**
 * Starts the Auto QA server and web UI (M7).
 *
 *   npm run serve                 http://127.0.0.1:4400
 *   PORT=5000 npm run serve
 *
 * Data (database, uploads, explorations, runs) is kept in .auto-qa/; generated projects in workspaces/.
 */

import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalArtifactStore } from '../db/artifacts.js';
import { readAll } from '../explorer/page-store.js';
import { defaultParserConfig } from '../parser/index.js';
import { buildApp } from './app.js';
import { JobRunner } from './jobs.js';
import { Store } from './store.js';

// node:sqlite is built into Node 22 and works; its "experimental" notice is noise here.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  (emitWarning as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.AUTO_QA_DATA ?? path.join(root, '.auto-qa'));
const workspacesDir = path.resolve(process.env.AUTO_QA_WORKSPACES ?? path.join(root, 'workspaces'));
// Files are named in the database by reference to these two folders, never by absolute path (D27).
const artifacts = new LocalArtifactStore({ local: dataDir, workspace: workspacesDir });
const store = await Store.open(path.join(dataDir, 'auto-qa.db'), { artifacts }).catch((e: Error) => {
  // A database from a newer version, or a failed upgrade: say what happened and stop, changing nothing.
  console.error(`Auto QA cannot open its database.
${e.message}`);
  process.exit(1);
});
// Page URLs older versions kept in pages.json are page routes now (D19). The file is kept, renamed, as a copy.
const pagesFile = path.join(dataDir, 'pages.json');
if (existsSync(pagesFile)) {
  const added = await store.importPageUrls(await readAll(pagesFile));
  renameSync(pagesFile, path.join(dataDir, 'pages.imported.json'));
  if (added) console.log(`Moved ${added} learned page URL(s) from pages.json into the database.`);
}
const runner = new JobRunner({ store, config: defaultParserConfig(), dataDir, headless: process.env.AUTO_QA_HEADED !== '1' });
const app = await buildApp({ store, runner, dataDir, workspacesDir, webDir: path.join(root, 'web', 'dist') });

const port = Number(process.env.PORT ?? 4400);
// V1 is single-user on the owner's laptop (§3): only this machine can reach it.
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });
console.log(`Auto QA on http://${host}:${port}`);
