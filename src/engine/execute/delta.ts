import type { Observation, ObservedElement } from './observe.js';

/**
 * Layer 40, before and after (EX-05): what an action changed. The state delta is the later observation minus the earlier:
 * the address, the title, the lines of text that appeared or went, the elements that appeared or went, the values and
 * states that changed, the messages and field errors that are new, the pop-ups and the tabs. It lists exactly what
 * differs and nothing else, so a report can say what a click did, and a check can ask whether a message is new (EX-07).
 */

export interface Change {
  element: string;
  property: 'value' | 'checked' | 'disabled' | 'invalid';
  from: string;
  to: string;
}

export interface Delta {
  url?: { from: string; to: string };
  title?: { from: string; to: string };
  textAdded: string[];
  textRemoved: string[];
  appeared: string[];
  disappeared: string[];
  changed: Change[];
  /** Messages that are shown now and were not before. */
  newMessages: string[];
  /** Field errors that are shown now and were not before. */
  newFieldErrors: Array<{ field: string; message: string }>;
  dialogs: string[];
  tabs?: { from: number; to: number };
}

/** The lines of `later` that `earlier` did not have, counting repeats. */
function added(earlier: readonly string[], later: readonly string[]): string[] {
  const have = new Map<string, number>();
  for (const l of earlier) have.set(l, (have.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of later) {
    const n = have.get(l) ?? 0;
    if (n > 0) have.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

const label = (e: ObservedElement): string => `${e.role}${e.name ? ` "${e.name}"` : ''}`;

export function diff(before: Observation, after: Observation, dialogs: readonly string[] = []): Delta {
  const was = new Map(before.elements.map((e) => [e.identity, e]));
  const is = new Map(after.elements.map((e) => [e.identity, e]));
  const changed: Change[] = [];
  for (const [identity, now] of is) {
    const then = was.get(identity);
    if (!then) continue;
    const check = (property: Change['property'], a: unknown, b: unknown): void => {
      if (a !== b) changed.push({ element: label(now), property, from: String(a ?? ''), to: String(b ?? '') });
    };
    check('value', then.value, now.value);
    check('checked', then.checked, now.checked);
    check('disabled', then.disabled, now.disabled);
    check('invalid', then.invalid, now.invalid);
  }
  const errorKey = (e: { field: string; message: string }): string => `${e.field}|${e.message}`;
  const hadErrors = new Set(before.fieldErrors.map(errorKey));
  return {
    ...(before.url !== after.url ? { url: { from: before.url, to: after.url } } : {}),
    ...(before.title !== after.title ? { title: { from: before.title, to: after.title } } : {}),
    textAdded: added(before.lines, after.lines),
    textRemoved: added(after.lines, before.lines),
    appeared: [...is].filter(([id]) => !was.has(id)).map(([, e]) => label(e)),
    disappeared: [...was].filter(([id]) => !is.has(id)).map(([, e]) => label(e)),
    changed,
    newMessages: added(before.messages, after.messages),
    newFieldErrors: after.fieldErrors.filter((e) => !hadErrors.has(errorKey(e))),
    dialogs: [...dialogs],
    ...(before.tabs !== after.tabs ? { tabs: { from: before.tabs, to: after.tabs } } : {}),
  };
}

export const isEmpty = (d: Delta): boolean =>
  !d.url &&
  !d.title &&
  !d.tabs &&
  !d.textAdded.length &&
  !d.textRemoved.length &&
  !d.appeared.length &&
  !d.disappeared.length &&
  !d.changed.length &&
  !d.newMessages.length &&
  !d.newFieldErrors.length &&
  !d.dialogs.length;

/** What changed, in words, one line for each change: what a report shows after a step. */
export function describe(d: Delta): string[] {
  const out: string[] = [];
  if (d.url) out.push(`address: ${d.url.from} → ${d.url.to}`);
  if (d.title) out.push(`title: "${d.title.from}" → "${d.title.to}"`);
  if (d.tabs) out.push(`tabs: ${d.tabs.from} → ${d.tabs.to}`);
  for (const t of d.dialogs) out.push(`pop-up: ${t}`);
  for (const t of d.newMessages) out.push(`new message: "${t}"`);
  for (const e of d.newFieldErrors) out.push(`field error: ${e.field}: "${e.message}"`);
  for (const t of d.textAdded) out.push(`text appeared: "${t}"`);
  for (const t of d.textRemoved) out.push(`text went: "${t}"`);
  for (const e of d.appeared) out.push(`appeared: ${e}`);
  for (const e of d.disappeared) out.push(`went: ${e}`);
  for (const c of d.changed) out.push(`${c.element}: ${c.property} "${c.from}" → "${c.to}"`);
  return out;
}
