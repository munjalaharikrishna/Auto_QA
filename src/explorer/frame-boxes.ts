import type { Page } from 'playwright';
import type { SnapshotNode } from './snapshot-parser.js';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where every element of a snapshot taken with `boxes: true` is on the page (what the screenshot shows).
 *
 * The snapshot measures an element inside an iframe from the top-left of that iframe, not of the page. Drawn as they
 * come, such boxes land in the wrong place (a button 100px down the page shows at the top). Every frame's elements
 * share one offset, so it is worked out once per frame: from Playwright's own measurement of one element of the frame
 * (which is relative to the page), or, if that cannot be taken, from where the iframe element itself sits.
 */
export async function pageBoxes(page: Page, nodes: SnapshotNode[]): Promise<Map<string, Box>> {
  const reported = new Map<string, Box>();
  for (const n of nodes) {
    const box = boxOf(n);
    if (n.ref && box) reported.set(n.ref, box);
  }
  const offsets = new Map<string, { x: number; y: number }>();

  const offsetOf = async (prefix: string): Promise<{ x: number; y: number }> => {
    const known = offsets.get(prefix);
    if (known) return known;
    const inFrame = nodes.filter((n) => n.ref && frameOf(n.ref) === prefix && reported.has(n.ref));
    let offset: { x: number; y: number } | undefined;
    for (const n of inFrame.slice(0, 3)) {
      const measured = await page
        .locator(`aria-ref=${n.ref}`)
        .boundingBox({ timeout: 1500 })
        .catch(() => null);
      const own = reported.get(n.ref as string);
      if (measured && own) {
        offset = { x: measured.x - own.x, y: measured.y - own.y };
        break;
      }
    }
    // Fallback: the frame starts where its iframe element is (plus that iframe's own frame, when it is nested).
    if (!offset) {
      const holder = inFrame[0] && iframeAbove(inFrame[0]);
      const holderBox = holder?.ref ? reported.get(holder.ref) : undefined;
      const outer = holder?.ref && frameOf(holder.ref) ? await offsetOf(frameOf(holder.ref) as string) : { x: 0, y: 0 };
      offset = holderBox ? { x: holderBox.x + outer.x, y: holderBox.y + outer.y } : { x: 0, y: 0 };
    }
    offsets.set(prefix, offset);
    return offset;
  };

  const out = new Map<string, Box>();
  for (const [ref, box] of reported) {
    const prefix = frameOf(ref);
    const offset = prefix ? await offsetOf(prefix) : { x: 0, y: 0 };
    out.set(ref, { x: box.x + offset.x, y: box.y + offset.y, width: box.width, height: box.height });
  }
  return out;
}

/** `f2` for `f2e20`: the frame a ref belongs to (the top page's refs have none). */
const frameOf = (ref: string): string | undefined => /^(f\d+)e/.exec(ref)?.[1];

function boxOf(n: SnapshotNode): Box | undefined {
  const box = typeof n.attributes.box === 'string' ? n.attributes.box.split(',').map(Number) : [];
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v)) || box[2] <= 0 || box[3] <= 0) return undefined;
  return { x: box[0], y: box[1], width: box[2], height: box[3] };
}

function iframeAbove(n: SnapshotNode): SnapshotNode | undefined {
  for (let p = n.parent; p; p = p.parent) if (p.role === 'iframe') return p;
  return undefined;
}
