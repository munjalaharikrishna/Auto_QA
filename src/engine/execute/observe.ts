import type { Page } from 'playwright';
import { CONTAINER_SELECTOR, HEADING_SELECTOR } from '../locate/containers.js';
import { contentFrameOf, prepareFrame, readSettled, visibleFrames } from '../locate/frames.js';
import { inspectPageDetailed } from '../locate/inspector.js';
import type { DomElement } from '../locate/types.js';

/**
 * Layer 39, the observation engine (EX-04). What the page looks like at one moment, as facts: its address and title, the
 * text that is shown, the elements a person could use or read (with their value, state and name), the messages on it and
 * the errors tied to their fields. Every step stores one observation before it and one after it. An observation holds
 * only what is visible, and never the value of a password.
 */

export interface ObservedElement {
  /** What identifies the element across two observations: its test id, its id, or its place in the page. */
  identity: string;
  role: string;
  /** What a person would call it. */
  name: string;
  tag: string;
  value?: string;
  checked?: boolean;
  disabled: boolean;
  invalid: boolean;
  /** The titles of the named containers it is inside, nearest first (UI-07). */
  inside?: string[];
}

/** A named container on the page and the text it shows: what a check on "the Backpack card" is judged on (UI-07). */
export interface ObservedContainer {
  name: string;
  lines: string[];
}

export interface FieldError {
  field: string;
  message: string;
}

export interface Observation {
  url: string;
  /**
   * The address of the screen a person is on when the page itself is only a shell (E8): the frame that takes the most room. OrangeHRM
   * keeps the address of the page the same and loads every screen into one frame, so only this one changes from screen to screen.
   */
  contentUrl?: string;
  /**
   * The frames that could not be read, even after the page settled and the read was made again (E0.13). Nothing can be said to be
   * absent from a frame that was not read: a check that rests on absence is not decided while this is not empty.
   */
  unreadFrames?: string[];
  title: string;
  /** The text shown on the page, one line after the other. */
  lines: string[];
  elements: ObservedElement[];
  /** The text of the visible alerts and status messages. */
  messages: string[];
  /** The error of each field that has one, tied to the field (UI-04). */
  fieldErrors: FieldError[];
  /** The named containers (cards, list items, sections) that are shown, with their text. */
  containers?: ObservedContainer[];
  /** The element that has the focus. */
  focus?: string;
  /** The number of tabs open. */
  tabs: number;
}

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['alert', 'status', 'alertdialog', 'log']);
const WORTH_NOTING: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'spinbutton',
  'slider',
  'tab',
  'menuitem',
  'option',
  'heading',
  'dialog',
  'tooltip',
  'row',
  'img',
]);

const nameOf = (e: DomElement): string => e.ariaName || e.labels[0] || e.text || e.placeholder || e.nameAttr || e.id || '';

/** The facts of a page that matter between two moments. */
export function observed(
  url: string,
  title: string,
  lines: string[],
  elements: readonly DomElement[],
  tabs = 1,
  containers: ObservedContainer[] = [],
  frames: { contentUrl?: string; unread?: string[] } = {},
): Observation {
  const shown = elements.filter((e) => e.visible);
  const out: ObservedElement[] = [];
  for (const e of shown) {
    if (!WORTH_NOTING.has(e.role) && !MESSAGE_ROLES.has(e.role)) continue;
    out.push({
      identity: `${(e.frame ?? []).join('>')}${e.frame?.length ? '|' : ''}${e.testId ?? e.id ?? e.xpath}`,
      role: e.role,
      name: nameOf(e),
      tag: e.tag,
      ...(e.value !== undefined ? { value: e.value } : {}),
      ...(e.checked !== undefined ? { checked: e.checked } : {}),
      disabled: e.disabled,
      invalid: e.invalid,
      ...(e.containers?.length ? { inside: e.containers } : {}),
    });
  }
  const focused = shown.find((e) => e.focused);
  return {
    url,
    ...(frames.contentUrl ? { contentUrl: frames.contentUrl } : {}),
    ...(frames.unread?.length ? { unreadFrames: frames.unread } : {}),
    title,
    lines,
    elements: out,
    ...(containers.length ? { containers } : {}),
    messages: shown.filter((e) => MESSAGE_ROLES.has(e.role) && e.text).map((e) => e.text),
    fieldErrors: shown.filter((e) => e.invalid && e.describedBy).map((e) => ({ field: nameOf(e), message: e.describedBy as string })),
    ...(focused ? { focus: nameOf(focused) } : {}),
    tabs,
  };
}

/** The visible text lines of the page. Runs in the page. */
function readLines(): string[] {
  const out: string[] = [];
  for (const raw of (document.body?.innerText ?? '').split('\n')) {
    const line = raw.trim();
    if (line) out.push(line.length > 200 ? line.slice(0, 200) : line);
    if (out.length >= 500) break;
  }
  return out;
}

/** The named containers that are shown, with their visible text. Runs in the page. */
function readContainers(args: { containerSelector: string; headingSelector: string }): ObservedContainer[] {
  const squash = (s: string | null | undefined): string => {
    let out = '';
    let space = false;
    for (const ch of s ?? '') {
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ' ') space = true;
      else {
        if (space && out) out += ' ';
        space = false;
        out += ch;
      }
    }
    return out;
  };
  const textOfIds = (ids: string | null): string =>
    squash(ids)
      .split(' ')
      .map((id) => squash(document.getElementById(id)?.textContent))
      .join(' ');
  const out: ObservedContainer[] = [];
  for (const c of Array.from(document.querySelectorAll(args.containerSelector))) {
    let name = squash(c.getAttribute('aria-label')) || squash(textOfIds(c.getAttribute('aria-labelledby')));
    if (!name) {
      for (const h of Array.from(c.querySelectorAll(args.headingSelector))) {
        if (h.closest(args.containerSelector) !== c) continue;
        name = squash(h.textContent);
        if (name) break;
      }
    }
    if (!name) continue;
    const box = c.getBoundingClientRect();
    const style = getComputedStyle(c);
    if (box.width === 0 || box.height === 0 || style.display === 'none' || style.visibility === 'hidden') continue;
    const lines = ((c as HTMLElement).innerText ?? '')
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 60)
      .map((l) => (l.length > 200 ? l.slice(0, 200) : l));
    out.push({ name: name.length > 80 ? name.slice(0, 80) : name, lines });
    if (out.length >= 300) break;
  }
  return out;
}

export interface ObserveOptions {
  testIdAttribute?: string;
  tabs?: number;
}

/** Reads the page as it is now (EX-04). */
export async function observe(page: Page, options: ObserveOptions = {}): Promise<Observation> {
  // The text of the page and of every frame a person can see: what is shown in a frame is shown on the page.
  const lines: string[] = [];
  const containers: ObservedContainer[] = [];
  const unread = new Set<string>();
  const frames = await visibleFrames(page);
  for (const { frame, path } of frames) {
    await prepareFrame(frame);
    // A frame that changes under the read is read again once it has settled; one that still cannot be read is said so, not left empty.
    const text = await readSettled(frame, () => frame.evaluate(readLines));
    if (text.ok) lines.push(...text.value);
    else unread.add(path.join(' > ') || 'the page');
    const boxes = await readSettled(frame, () => frame.evaluate(readContainers, { containerSelector: CONTAINER_SELECTOR, headingSelector: HEADING_SELECTOR }));
    if (boxes.ok) containers.push(...boxes.value);
    else unread.add(path.join(' > ') || 'the page');
    if (lines.length >= 500) break;
  }
  const seen = await inspectPageDetailed(page, { testIdAttribute: options.testIdAttribute, includeText: false });
  for (const path of seen.unread) unread.add(path.join(' > '));
  const content = contentFrameOf(seen.frames);
  return observed(page.url(), await page.title(), lines, seen.elements, options.tabs ?? 1, containers, {
    ...(content ? { contentUrl: content.url } : {}),
    unread: [...unread],
  });
}
