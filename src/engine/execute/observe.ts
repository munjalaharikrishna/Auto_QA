import type { Page } from 'playwright';
import { prepareFrame, visibleFrames } from '../locate/frames.js';
import { inspectPage } from '../locate/inspector.js';
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
}

export interface FieldError {
  field: string;
  message: string;
}

export interface Observation {
  url: string;
  title: string;
  /** The text shown on the page, one line after the other. */
  lines: string[];
  elements: ObservedElement[];
  /** The text of the visible alerts and status messages. */
  messages: string[];
  /** The error of each field that has one, tied to the field (UI-04). */
  fieldErrors: FieldError[];
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
export function observed(url: string, title: string, lines: string[], elements: readonly DomElement[], tabs = 1): Observation {
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
    });
  }
  const focused = shown.find((e) => e.focused);
  return {
    url,
    title,
    lines,
    elements: out,
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

export interface ObserveOptions {
  testIdAttribute?: string;
  tabs?: number;
}

/** Reads the page as it is now (EX-04). */
export async function observe(page: Page, options: ObserveOptions = {}): Promise<Observation> {
  // The text of the page and of every frame a person can see: what is shown in a frame is shown on the page.
  const lines: string[] = [];
  for (const { frame } of await visibleFrames(page)) {
    await prepareFrame(frame);
    lines.push(...(await frame.evaluate(readLines).catch(() => [] as string[])));
    if (lines.length >= 500) break;
  }
  const elements = await inspectPage(page, { testIdAttribute: options.testIdAttribute, includeText: false });
  return observed(page.url(), await page.title(), lines, elements, options.tabs ?? 1);
}
