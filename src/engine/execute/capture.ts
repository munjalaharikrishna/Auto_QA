import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readScreens, SCREENS_FILE } from '../knowledge/from-runs.js';
import { diffScreens, elementIdentity, mergeScreens, type Screen, type ScreenChange } from '../knowledge/screens.js';
import { screenKeyOf } from '../locate/page-identity.js';
import type { RunTrace } from './executor.js';
import type { Observation } from './observe.js';

/**
 * Run capture (E0.14a): the screens a run reached, read from the observations it already makes before and after every step. Nothing
 * is visited or clicked for it. Values are left out: a screen model says what is on a screen, never what was typed into it.
 */

/** One observation as a screen. */
export function screenOf(o: Observation, caseId: string, seenAt?: string, source: Screen['source'] = 'run'): Screen {
  const key = o.screen ?? screenKeyOf(o.contentUrl ?? o.url, o.dialog);
  const elements = new Map<string, Screen['elements'][number]>();
  for (const e of o.elements) {
    // A layout row or a picture with no name and nothing that identifies it is not something a test case can mean.
    if (!e.name && !e.label && !e.testId && !e.htmlId && !e.nameAttr) continue;
    const id = elementIdentity({ ...e, ...(e.frame ? { frame: e.frame } : {}), ...(e.inside ? { inside: e.inside } : {}) });
    if (elements.has(id)) continue;
    elements.set(id, {
      id,
      role: e.role,
      name: e.name,
      ...(e.label ? { label: e.label } : {}),
      ...(e.placeholder ? { placeholder: e.placeholder } : {}),
      ...(e.type ? { type: e.type } : {}),
      ...(e.testId ? { testId: e.testId } : {}),
      ...(e.htmlId ? { htmlId: e.htmlId } : {}),
      ...(e.nameAttr ? { nameAttr: e.nameAttr } : {}),
      frame: [...(e.frame ?? [])],
      inside: [...(e.inside ?? [])],
    });
  }
  return {
    key,
    ...((o.dialog ?? o.headings?.[0] ?? o.title) ? { title: o.dialog ?? o.headings?.[0] ?? o.title } : {}),
    headings: [...(o.headings ?? [])],
    tables: (o.tables ?? []).map((t) => [...t]),
    elements: [...elements.values()],
    source,
    cases: [caseId],
    ...(seenAt ? { seenAt } : {}),
    words: [],
  };
}

/**
 * Keeps the screens a run reached in the case's folder, and says what changed on them since the case's last run there. A screen the run
 * reached replaces what was kept of it; a screen it did not reach (the run stopped earlier) is kept as it was.
 */
export async function keepScreens(
  caseDir: string,
  trace: RunTrace,
  options: { seenAt?: string; source?: Screen['source'] } = {},
): Promise<{ screens: Screen[]; changes: ScreenChange[] }> {
  const file = path.join(caseDir, SCREENS_FILE);
  const before = await readScreens(file);
  const reached = screensOf(trace, options.seenAt, options.source);
  const keys = new Set(reached.map((s) => s.key));
  const screens = [...before.filter((s) => !keys.has(s.key)), ...reached];
  await mkdir(caseDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(screens, null, 2)}\n`);
  // The first capture of a case is not a change.
  return { screens, changes: before.length ? diffScreens(before, reached) : [] };
}

/** Every screen a run was on, once each, in the order reached: each step's page before it and after it. */
export function screensOf(trace: RunTrace, seenAt = new Date().toISOString(), source: Screen['source'] = 'run'): Screen[] {
  let out: Screen[] = [];
  for (const s of trace.steps) {
    for (const o of [s.before, s.after]) {
      // The empty tab before the first step, and a page with nothing a test could mean, are not screens of the application.
      if (!o || o.url === 'about:blank') continue;
      const screen = screenOf(o, trace.testId, seenAt, source);
      if (screen.elements.length) out = mergeScreens(out, [screen]);
    }
  }
  return out;
}
