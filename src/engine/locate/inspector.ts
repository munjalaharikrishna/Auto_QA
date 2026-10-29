import type { Frame, Page } from 'playwright';
import { CONTAINER_SELECTOR, HEADING_SELECTOR } from './containers.js';
import { readSettled, type VisibleFrame, visibleFrames } from './frames.js';
import type { DomElement } from './types.js';

/**
 * Layer 25, DOM semantic inspection (DM-01). For every element a person could mean, the inspector reads what the page
 * says about it and what the browser shows of it: tag, role, names, labels, visibility, whether something covers it,
 * its box, whether it has focus, the elements around it, the text that sits next to it and its address in the page.
 * That is the evidence the candidate engine works from. It reads; it changes nothing (apart from scrolling an element
 * into view to see whether something covers it, which a click does too).
 *
 * `readDom` is run inside the page, so it is one self-contained function: it uses nothing outside itself, and no
 * regular expressions (RX-01).
 */

export interface InspectOptions {
  /** The attribute that holds the test id: `data-testid` unless the project says otherwise. */
  testIdAttribute?: string;
  /** Also read plain text elements (a paragraph, a table cell) for the text level; off for a page of controls only. */
  includeText?: boolean;
}

/** Runs in the page. Keep it self-contained. */
export function readDom(opts: { testIdAttribute: string; includeText: boolean; containerSelector: string; headingSelector: string }): DomElement[] {
  const squash = (s: string | null | undefined): string => {
    let out = '';
    let space = false;
    for (const ch of s ?? '') {
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ' ') space = true;
      else {
        if (space && out) out += ' ';
        space = false;
        out += ch;
      }
    }
    return out;
  };
  const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

  const IMPLICIT_BY_TAG: Record<string, string> = {
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    a: 'link',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    img: 'img',
    table: 'table',
    tr: 'row',
    td: 'cell',
    th: 'columnheader',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    nav: 'navigation',
    form: 'form',
    dialog: 'dialog',
    label: 'label',
    p: 'paragraph',
    option: 'option',
  };
  const INPUT_ROLE: Record<string, string> = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
    file: 'button',
  };
  const roleOf = (el: Element): string => {
    const written = el.getAttribute('role');
    if (written) return squash(written).split(' ')[0] as string;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return INPUT_ROLE[(el.getAttribute('type') ?? 'text').toLowerCase()] ?? 'textbox';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'select') return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    return IMPLICIT_BY_TAG[tag] ?? 'generic';
  };

  const textOfIds = (ids: string | null): string => {
    if (!ids) return '';
    const parts: string[] = [];
    for (const id of squash(ids).split(' ')) {
      const ref = document.getElementById(id);
      if (ref) parts.push(squash(ref.textContent));
    }
    return parts.join(' ');
  };

  /** The title of a named container: its aria-label, what aria-labelledby points at, or the first heading that is its own. */
  const titles = new Map<Element, string>();
  const titleOf = (c: Element): string => {
    const known = titles.get(c);
    if (known !== undefined) return known;
    let t = squash(c.getAttribute('aria-label')) || squash(textOfIds(c.getAttribute('aria-labelledby')));
    if (!t) {
      for (const h of Array.from(c.querySelectorAll(opts.headingSelector))) {
        if (h.closest(opts.containerSelector) !== c) continue;
        t = squash(h.textContent);
        if (t) break;
      }
    }
    t = clip(t, 80);
    titles.set(c, t);
    return t;
  };
  const containersOf = (el: Element): string[] => {
    const names: string[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (!p.matches(opts.containerSelector)) continue;
      const t = titleOf(p);
      if (t) names.push(t);
    }
    return names;
  };

  const describe = (el: Element): string => {
    const id = el.getAttribute('id');
    return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}`;
  };

  const xpathOf = (el: Element): string => {
    const steps: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1) {
      const id = node.getAttribute('id');
      if (id && document.querySelectorAll(`[id="${id}"]`).length === 1) {
        steps.unshift(`//*[@id='${id}']`);
        break;
      }
      let n = 1;
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === node.tagName) n++;
      steps.unshift(`${node.tagName.toLowerCase()}[${n}]`);
      node = node.parentElement;
      if (node === document.documentElement) {
        steps.unshift('html[1]');
        break;
      }
    }
    return steps[0]?.startsWith('//') ? steps.join('/') : `/${steps.join('/')}`;
  };

  /** The text that sits next to an element and names it: the cell before it in a row, or the text before it in a line. */
  const nearby = (el: Element): string => {
    const cell = el.closest('td,th');
    if (cell) {
      const before = cell.previousElementSibling;
      if (before) return clip(squash(before.textContent), 80);
    }
    const prev = el.previousElementSibling;
    if (prev && !['input', 'select', 'textarea', 'button', 'a'].includes(prev.tagName.toLowerCase())) {
      const t = squash(prev.textContent);
      if (t) return clip(t, 80);
    }
    let node: Node | null = el.previousSibling;
    while (node) {
      if (node.nodeType === 3) {
        const t = squash(node.textContent);
        if (t) return clip(t, 80);
      } else if (node.nodeType === 1) break;
      node = node.previousSibling;
    }
    return '';
  };

  const hiddenReason = (el: Element, rect: DOMRect): string | undefined => {
    if (el.hasAttribute('hidden')) return 'hidden attribute';
    for (let e: Element | null = el; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.display === 'none') return e === el ? 'display:none' : `display:none on ${describe(e)}`;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'visibility:hidden';
      if (e.getAttribute('aria-hidden') === 'true' && e === el) return 'aria-hidden';
    }
    if (Number(getComputedStyle(el).opacity) === 0) return 'opacity:0';
    if (rect.width === 0 || rect.height === 0) return 'no size';
    return undefined;
  };

  const interactive = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (['input', 'button', 'select', 'textarea', 'option'].includes(tag)) return (el.getAttribute('type') ?? '') !== 'hidden';
    if (tag === 'a') return el.hasAttribute('href') || el.hasAttribute('role') || el.hasAttribute('tabindex');
    return el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('contenteditable');
  };

  const out: DomElement[] = [];
  const all = Array.from(document.querySelectorAll('*'));
  let index = 0;
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'head', 'meta', 'title', 'link', 'html', 'body', 'noscript', 'template'].includes(tag)) continue;
    const testId = el.getAttribute(opts.testIdAttribute) ?? undefined;
    const ariaLabel = el.getAttribute('aria-label') ?? '';
    const hasText = opts.includeText && !interactive(el);
    const own = (): string => {
      let t = '';
      for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += ` ${n.textContent ?? ''}`;
      return squash(t);
    };
    const isLabelled = ariaLabel !== '' || el.hasAttribute('aria-labelledby');
    if (
      !interactive(el) &&
      !testId &&
      !isLabelled &&
      !(hasText && own() !== '') &&
      !['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'table', 'tr', 'form', 'dialog'].includes(tag)
    )
      continue;

    let rect = el.getBoundingClientRect();
    const reason = hiddenReason(el, rect);
    const visible = reason === undefined;
    let covered = false;
    let coveredBy: string | undefined;
    if (visible) {
      let cx = rect.left + rect.width / 2;
      let cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
        (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
        rect = el.getBoundingClientRect();
        cx = rect.left + rect.width / 2;
        cy = rect.top + rect.height / 2;
      }
      const top = document.elementFromPoint(cx, cy);
      const labelFor = top?.closest('label');
      const isMyLabel = labelFor !== null && labelFor !== undefined && (labelFor as HTMLLabelElement).control === el;
      if (top && top !== el && !el.contains(top) && !top.contains(el) && !isMyLabel) {
        covered = true;
        coveredBy = describe(top);
      }
    }
    const labels: string[] = [];
    const controlLabels = (el as HTMLInputElement).labels;
    if (controlLabels) for (const l of Array.from(controlLabels)) labels.push(squash(l.textContent));
    const ariaName =
      squash(ariaLabel) ||
      squash(textOfIds(el.getAttribute('aria-labelledby'))) ||
      squash(el.getAttribute('alt')) ||
      squash(el.getAttribute('title')) ||
      (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((el.getAttribute('type') ?? '').toLowerCase()) ? squash(el.getAttribute('value')) : '');
    const role = roleOf(el);
    const full = ['button', 'link', 'option', 'tab', 'menuitem', 'heading', 'cell', 'columnheader'].includes(role) || ['label', 'legend', 'li'].includes(tag);
    // An element that is not shown has no inner text; its words are still its name.
    const shown = squash((el as HTMLElement).innerText);
    const text = clip(full ? shown || squash(el.textContent) : own(), 120);
    // What the field holds now. A password is never read.
    const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
    const typeAttr = (el.getAttribute('type') ?? '').toLowerCase();
    const control = el as HTMLInputElement;
    const heldValue = !isInput ? undefined : typeAttr === 'password' ? (control.value ? '••••' : '') : control.value;
    const selectedText = tag === 'select' ? squash((el as HTMLSelectElement).selectedOptions[0]?.textContent) : undefined;
    const checked =
      typeAttr === 'checkbox' || typeAttr === 'radio'
        ? control.checked
        : el.getAttribute('aria-checked') === 'true'
          ? true
          : el.getAttribute('aria-checked') === 'false'
            ? false
            : undefined;
    const describing: string[] = [];
    for (const id of squash(el.getAttribute('aria-describedby')).split(' ')) {
      const ref = id ? document.getElementById(id) : null;
      if (ref && !ref.hasAttribute('hidden') && getComputedStyle(ref).display !== 'none') {
        const t = squash(ref.textContent);
        if (t) describing.push(t);
      }
    }
    const ancestors: string[] = [];
    for (let p = el.parentElement; p && ancestors.length < 4; p = p.parentElement)
      if (p !== document.body && p !== document.documentElement) ancestors.push(describe(p));
    const holders = containersOf(el);
    const formEl = el.closest('form');
    const active = document.activeElement === el;
    out.push({
      index: index++,
      tag,
      ...(el.getAttribute('type') ? { type: (el.getAttribute('type') as string).toLowerCase() } : {}),
      role,
      ariaName,
      ...(squash(ariaLabel) ? { ariaLabel: squash(ariaLabel) } : {}),
      labels,
      ...(el.getAttribute('placeholder') ? { placeholder: squash(el.getAttribute('placeholder')) } : {}),
      ...(testId ? { testId } : {}),
      ...(el.getAttribute('name') ? { nameAttr: el.getAttribute('name') as string } : {}),
      ...(el.getAttribute('id') ? { id: el.getAttribute('id') as string } : {}),
      text,
      visible,
      ...(reason ? { hiddenReason: reason } : {}),
      disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || el.closest('fieldset[disabled]') !== null,
      readOnly: (el as HTMLInputElement).readOnly === true || el.getAttribute('aria-readonly') === 'true',
      covered,
      ...(coveredBy ? { coveredBy } : {}),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      focused: active,
      focusable: interactive(el) && (el as HTMLElement).tabIndex >= 0,
      parents: ancestors,
      ...(holders.length ? { containers: holders } : {}),
      nearbyText: nearby(el),
      xpath: xpathOf(el),
      ...(formEl ? { form: formEl.getAttribute('id') ?? formEl.getAttribute('name') ?? 'form' } : {}),
      inDialog: el.closest('dialog[open], [role="dialog"], [aria-modal="true"]') !== null,
      ...(heldValue !== undefined ? { value: heldValue } : {}),
      ...(selectedText ? { selectedText } : {}),
      ...(checked !== undefined ? { checked } : {}),
      invalid: el.getAttribute('aria-invalid') === 'true',
      ...(describing.length ? { describedBy: describing.join(' ') } : {}),
      frame: [],
    });
  }
  return out;
}

/** Reads every element of one frame. */
async function readFrame(frame: Frame, options: InspectOptions): Promise<DomElement[]> {
  // The tools that compile this file add a helper called `__name` to the functions inside `readDom`; the page does not have it.
  await frame.evaluate('globalThis.__name = globalThis.__name || ((fn) => fn)');
  return frame.evaluate(readDom, {
    testIdAttribute: options.testIdAttribute ?? 'data-testid',
    includeText: options.includeText ?? true,
    containerSelector: CONTAINER_SELECTOR,
    headingSelector: HEADING_SELECTOR,
  });
}

/**
 * Reads every element of the page that a person could mean (DM-01): the page's own, then each frame that can be seen,
 * with `frame` telling which iframes an element is in. A frame that changes while it is read is left out, not an error.
 */
export async function inspectPage(page: Page, options: InspectOptions = {}): Promise<DomElement[]> {
  return (await inspectPageDetailed(page, options)).elements;
}

export interface InspectResult {
  elements: DomElement[];
  /** The frames a person can see that could not be read, even after the page settled and the read was made again (E0.13). */
  unread: string[][];
  /** Every frame that can be seen, with its address and the room it takes. */
  frames: VisibleFrame[];
}

/**
 * `inspectPage`, and what could not be read. A frame that changes under the read is read again once it has settled; one that still
 * cannot be read is listed in `unread`, never returned as an empty frame, because nothing can be said to be absent from a frame that
 * was not read. The page itself that cannot be read is an error.
 */
export async function inspectPageDetailed(page: Page, options: InspectOptions = {}): Promise<InspectResult> {
  const main = await readSettled(page.mainFrame(), () => readFrame(page.mainFrame(), options));
  if (!main.ok) throw main.error;
  const elements: DomElement[] = main.value;
  const unread: string[][] = [];
  const frames = await visibleFrames(page);
  for (const { frame, path, url } of frames) {
    if (path.length === 0) continue;
    const inside = await readSettled(frame, () => readFrame(frame, options)).catch((error) => ({ ok: false as const, error }));
    if (!inside.ok) {
      unread.push(path);
      continue;
    }
    for (const e of inside.value) elements.push({ ...e, index: elements.length, frame: path, frameUrl: url });
  }
  return { elements, unread, frames };
}
