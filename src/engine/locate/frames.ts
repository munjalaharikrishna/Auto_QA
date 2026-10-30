import type { Frame, Page } from 'playwright';

/**
 * Frames (UI-01). A page can hold other pages in iframes, and a product such as OrangeHRM shows its screens in one. An
 * element in a frame is named by the iframes around it, outermost first, each by its XPath in the frame that holds it.
 * Everything that reads, waits for or acts on a page goes through here, so that no layer sees only the outer page.
 */

/** Makes functions sent into a frame work when the tools that compile this file added a `__name` helper to them. */
export async function prepareFrame(frame: Frame): Promise<void> {
  await frame.evaluate('globalThis.__name = globalThis.__name || ((fn) => fn)').catch(() => {});
}

/** Runs in the page that holds an iframe: where the iframe is, and whether anyone can see it. */
function describeIframe(el: Element): { xpath: string; shown: boolean; area: number } {
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
  }
  const xpath = steps[0]?.startsWith('//') ? steps.join('/') : `/${steps.join('/')}`;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    xpath,
    shown: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
    area: Math.round(rect.width * rect.height),
  };
}

/**
 * The iframes around a frame, outermost first, or `undefined` for a frame nobody can see (a hidden or removed one, such as
 * a tracking frame): such a frame is not part of the page a person uses.
 */
export async function framePath(frame: Frame): Promise<string[] | undefined> {
  return (await frameChain(frame))?.path;
}

/** The iframes around a frame, outermost first, and the area the innermost one takes on its page; undefined for a frame nobody can see. */
async function frameChain(frame: Frame): Promise<{ path: string[]; area: number } | undefined> {
  const chain: string[] = [];
  let area = 0;
  for (let f: Frame | null = frame; f?.parentFrame(); f = f.parentFrame()) {
    const parent = f.parentFrame() as Frame;
    try {
      const handle = await f.frameElement();
      await prepareFrame(parent);
      const found = await handle.evaluate(describeIframe);
      await handle.dispose();
      if (!found.shown) return undefined;
      if (chain.length === 0) area = found.area;
      chain.unshift(found.xpath);
    } catch {
      return undefined;
    }
  }
  return { path: chain, area };
}

export interface VisibleFrame {
  frame: Frame;
  path: string[];
  /** The address the frame shows now. */
  url: string;
  /** The room the frame takes on the page that holds it: a screen shown in an iframe fills most of the page. */
  area: number;
}

/** Every frame a person can see, the page's own first, each with its path. */
export async function visibleFrames(page: Page): Promise<VisibleFrame[]> {
  const main = page.mainFrame();
  const out: VisibleFrame[] = [{ frame: main, path: [], url: main.url(), area: 0 }];
  for (const frame of page.frames()) {
    if (frame === main || frame.isDetached()) continue;
    const found = await frameChain(frame);
    if (found) out.push({ frame, path: found.path, url: frame.url(), area: found.area });
  }
  return out;
}

/**
 * Where each visible frame is on the page, by its path joined with `>` (the page itself is `''`): a box read inside a frame is moved by
 * this much to land on a picture of the whole page (E0.14). A frame whose place cannot be read is left out.
 */
export async function frameOffsets(page: Page, frames?: readonly VisibleFrame[]): Promise<Record<string, { x: number; y: number }>> {
  const out: Record<string, { x: number; y: number }> = { '': { x: 0, y: 0 } };
  for (const { frame, path } of frames ?? (await visibleFrames(page))) {
    if (!path.length) continue;
    const at = await frame
      .frameElement()
      .then((el) => el.boundingBox())
      .catch(() => null);
    if (at) out[path.join('>')] = { x: Math.round(at.x), y: Math.round(at.y) };
  }
  return out;
}

/**
 * The frame that holds the screen a person is on when the page itself is only a shell (E8): the visible frame that takes the most room,
 * and then, while a frame inside it takes at least a quarter of its room, that one: a menu frame that wraps the content frame is not the
 * screen. OrangeHRM shows every screen in one frame while the address of the page never changes.
 */
export function contentFrameOf(frames: readonly VisibleFrame[]): VisibleFrame | undefined {
  const usable = frames.filter((f) => f.path.length > 0 && f.area > 0 && f.url !== 'about:blank');
  const biggest = (list: readonly VisibleFrame[]) => [...list].sort((x, y) => y.area - x.area || y.path.length - x.path.length)[0];
  let current = biggest(usable);
  while (current) {
    const here = current;
    const inside = biggest(usable.filter((f) => f.path.length > here.path.length && here.path.every((step, i) => f.path[i] === step)));
    if (!inside || inside.area * 4 < here.area) break;
    current = inside;
  }
  return current;
}

/**
 * Whether a failure is a page that changed under a read: the document was replaced, or the frame went away. It is not an error of the
 * test case or the application; the read is made again once the page has settled. A closed browser is not this.
 */
export function isNavigationRace(error: unknown): boolean {
  const text = String((error as { message?: unknown })?.message ?? error);
  if (text.includes('has been closed')) return false;
  return [
    'Execution context was destroyed',
    'frame was detached',
    'Frame was detached',
    'Cannot find context with specified id',
    'Frame has been detached',
  ].some((w) => text.includes(w));
}

/**
 * Reads a frame, and reads it again once if the page changed under the first read (E0.13). A frame that still cannot be read is
 * reported as such, never as an empty frame: a page whose frame could not be read has not shown that something is absent from it.
 */
export async function readSettled<T>(frame: Frame, read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { ok: true, value: await read() };
    } catch (error) {
      if (!isNavigationRace(error)) throw error;
      if (attempt === 1) return { ok: false, error };
      // The page changed while it was read: wait for the document that replaced it, and read that one.
      await frame.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
    }
  }
  return { ok: false, error: new Error('the frame could not be read') };
}

export const sameFrame = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The start of a selector that goes into the frames, so the part after it is read inside the last one. */
export const frameSelector = (frame: readonly string[]): string => frame.map((x) => `xpath=${x} >> internal:control=enter-frame >> `).join('');

/** A selector for an XPath inside a frame; the XPath alone for the page itself. */
export const selectorIn = (frame: readonly string[], xpath: string): string => `${frameSelector(frame)}xpath=${xpath}`;
