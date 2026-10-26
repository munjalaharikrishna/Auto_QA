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
function describeIframe(el: Element): { xpath: string; shown: boolean } {
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
  return { xpath, shown: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' };
}

/**
 * The iframes around a frame, outermost first, or `undefined` for a frame nobody can see (a hidden or removed one, such as
 * a tracking frame): such a frame is not part of the page a person uses.
 */
export async function framePath(frame: Frame): Promise<string[] | undefined> {
  const chain: string[] = [];
  for (let f: Frame | null = frame; f?.parentFrame(); f = f.parentFrame()) {
    const parent = f.parentFrame() as Frame;
    try {
      const handle = await f.frameElement();
      await prepareFrame(parent);
      const found = await handle.evaluate(describeIframe);
      await handle.dispose();
      if (!found.shown) return undefined;
      chain.unshift(found.xpath);
    } catch {
      return undefined;
    }
  }
  return chain;
}

/** Every frame a person can see, the page's own first, each with its path. */
export async function visibleFrames(page: Page): Promise<Array<{ frame: Frame; path: string[] }>> {
  const main = page.mainFrame();
  const out: Array<{ frame: Frame; path: string[] }> = [{ frame: main, path: [] }];
  for (const frame of page.frames()) {
    if (frame === main || frame.isDetached()) continue;
    const path = await framePath(frame);
    if (path) out.push({ frame, path });
  }
  return out;
}

export const sameFrame = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The start of a selector that goes into the frames, so the part after it is read inside the last one. */
export const frameSelector = (frame: readonly string[]): string => frame.map((x) => `xpath=${x} >> internal:control=enter-frame >> `).join('');

/** A selector for an XPath inside a frame; the XPath alone for the page itself. */
export const selectorIn = (frame: readonly string[], xpath: string): string => `${frameSelector(frame)}xpath=${xpath}`;
