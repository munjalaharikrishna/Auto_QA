import type { Page } from 'playwright';
import { type Box, pageBoxes } from './frame-boxes.js';
import { flatten, parseSnapshot, type SnapshotNode } from './snapshot-parser.js';

/**
 * The MCP and the page snapshot (the one with boxes) describe the same page in the same order, but each numbers its elements by
 * itself: the same button is `e120` for one and `e43` for the other. A step, its candidates and the element the tester picks all
 * use the MCP's numbers, so anything measured on the page (where an element is, which ones can be shown on the screenshot) has to
 * be turned into those numbers first. Elements are matched by what they are (role, name, text, depth) in document order, so a
 * page that changed a little between the two snapshots still lines up, and an element that cannot be matched is left out.
 */
const identity = (n: SnapshotNode): string => `${n.role}|${n.name}|${n.text ?? ''}|${n.depth}`;

/** The page snapshot's ref → the MCP's ref, for every element that can be matched. */
export function refsToMcp(mcp: SnapshotNode[], page: SnapshotNode[]): Map<string, string> {
  const waiting = new Map<string, string[]>();
  for (const n of mcp) {
    if (!n.ref) continue;
    const key = identity(n);
    waiting.set(key, [...(waiting.get(key) ?? []), n.ref]);
  }
  const out = new Map<string, string>();
  for (const n of page) {
    if (!n.ref) continue;
    const ref = waiting.get(identity(n))?.shift();
    if (ref) out.set(n.ref, ref);
  }
  return out;
}

/** Where each element of the page is now, by the MCP's refs (what the screenshot shows), given the MCP's snapshot of the same page. */
export async function boxesByMcpRef(page: Page, mcpSnapshot: string): Promise<Map<string, Box>> {
  const nodes = flatten(parseSnapshot(await page.ariaSnapshot({ mode: 'ai', boxes: true })));
  const boxes = await pageBoxes(page, nodes);
  const toMcp = refsToMcp(flatten(parseSnapshot(mcpSnapshot)), nodes);
  const out = new Map<string, Box>();
  for (const [ref, box] of boxes) {
    const mcp = toMcp.get(ref);
    if (mcp) out.set(mcp, box);
  }
  return out;
}
