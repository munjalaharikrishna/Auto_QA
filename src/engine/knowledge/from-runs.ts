import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { cacheEnabled, cacheKeyOf, copyOf, memo } from '../cache/index.js';
import type { Application, Component, Page } from './schema.js';

/**
 * Where an application's own words come from before anyone has written them down (D1, U2). Every exploration of a test
 * case saw real elements with the names the application shows; every project rule of the kind "element" says which name
 * on the screen a tester's word means. Together they are the vocabulary the language layers read a test case with: "Code"
 * is the name of the field the tester calls "Employee ID", a thing called "Save" is a button.
 */

const ONTOLOGY_OF_ROLE: Readonly<Record<string, string>> = {
  textbox: 'Field',
  searchbox: 'Field',
  spinbutton: 'Field',
  combobox: 'Dropdown',
  listbox: 'Dropdown',
  button: 'Button',
  link: 'Link',
  checkbox: 'Checkbox',
  radio: 'RadioButton',
  heading: 'Heading',
};

/** What the tester wrote for an element, and the name on the screen it means (a project rule of the kind `element`). */
export interface ElementWord {
  word: string;
  means: string;
}

interface SavedItem {
  status?: string;
  element?: { role?: string; name?: string };
  page?: { name?: string };
}
interface SavedExploration {
  baseUrl?: string;
  status?: string;
  items?: SavedItem[];
}

/**
 * The application as the explorations in `dir` saw it, with the testers' words for its elements added as aliases.
 *
 * Reading every saved exploration is the slow part (a folder of them is tens of megabytes), so the result is kept for as long as the
 * explorations are the same (GV-11): the key holds the name, the address, the words, and the size and times of every exploration
 * file, so a changed, added or removed exploration is a miss. A hit is a copy.
 */
export async function knowledgeFromRuns(
  name: string,
  baseUrl: string | undefined,
  dir: string,
  words: readonly ElementWord[] = [],
  options: { cache?: boolean } = {},
): Promise<Application | undefined> {
  if (!cacheEnabled(options.cache)) return buildKnowledge(name, baseUrl, dir, words);
  const cache = memo<{ app: Application | undefined }>('knowledge', 50);
  const key = cacheKeyOf({ name, baseUrl: baseUrl ?? null, dir: path.resolve(dir), words, files: await fingerprintOf(dir) });
  const hit = cache.get(key);
  if (hit) return copyOf(hit.app);
  const app = await buildKnowledge(name, baseUrl, dir, words);
  cache.set(key, { app: copyOf(app) });
  return app;
}

/** The name, size and times of every exploration file in the folder: the same list means the same explorations. */
async function fingerprintOf(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const s = await stat(path.join(dir, entry.name, 'exploration.json')).catch(() => undefined);
    if (s) out.push(`${entry.name}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
  }
  return out.sort();
}

async function buildKnowledge(name: string, baseUrl: string | undefined, dir: string, words: readonly ElementWord[]): Promise<Application | undefined> {
  const pages = new Map<string, Map<string, Component>>();
  if (existsSync(dir)) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'exploration.json');
      if (!existsSync(file)) continue;
      let saved: SavedExploration;
      try {
        saved = JSON.parse(await readFile(file, 'utf8')) as SavedExploration;
      } catch {
        continue;
      }
      // Another application's explorations may share the folder: only this application's names are its own.
      if (baseUrl && saved.baseUrl && originOf(saved.baseUrl) !== originOf(baseUrl)) continue;
      for (const item of saved.items ?? []) {
        const label = item.element?.name?.trim();
        const ontology = ONTOLOGY_OF_ROLE[item.element?.role ?? ''];
        if (item.status !== 'done' || !label || !ontology) continue;
        // One list for the whole application: explorations name the same page differently (LoginPage, OrangeHRMLoginPage), and the same
        // element on two pages is not two things to choose between.
        const page = 'Application';
        const components = pages.get(page) ?? new Map<string, Component>();
        pages.set(page, components);
        const key = `${ontology}|${label.toLowerCase()}`;
        if (!components.has(key)) components.set(key, { name: label, aliases: [], ontology, key: false });
      }
    }
  }
  const all = [...pages.values()].flatMap((m) => [...m.values()]);
  for (const w of words) {
    // A word is an alias of the one component it means; a name that fits two components is not guessed.
    const meant = all.filter((c) => c.name.toLowerCase() === w.means.trim().toLowerCase());
    if (meant.length === 1 && !meant[0]?.aliases.includes(w.word)) meant[0]?.aliases.push(w.word);
  }
  if (!pages.size) return undefined;
  const list: Page[] = [...pages.entries()].map(([pageName, components]) => ({
    name: pageName,
    aliases: [],
    sections: [],
    forms: [],
    components: [...components.values()],
    filters: [],
    messages: [],
    expectedStates: [],
  }));
  return {
    version: 1,
    name,
    ...(baseUrl ? { baseUrl } : {}),
    pages: list,
    roles: [],
    modules: [],
    rules: [],
    navigation: [],
    authentication: { mfa: 'none' },
    vocabulary: [],
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
