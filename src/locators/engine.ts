import type { McpBrowser, PageState } from '../explorer/mcp-browser.js';
import { contextOf, parseSnapshot, type SnapshotNode } from '../explorer/snapshot-parser.js';
import type { ParserConfig } from '../parser/config.js';
import { buildLadder, type Fingerprint, fingerprint, type PageRef, pageOf } from './ladder.js';
import { type LocatorSpec, parseLocatorCode, spec } from './locator.js';
import { type Candidate, findCandidates, type TargetQuery } from './match.js';
import type { LocatorProbe, Validation } from './probe.js';

/**
 * Locator engine (FR-LO-03…11) for one step on the current page:
 * snapshot → candidates → pin the chosen element → ladder → first valid locator.
 */

export interface LocateOptions {
  config: ParserConfig;
  testIdAttribute: string;
  /** The page name the tester used, e.g. "Login" from "Open Login page" (FR-LO-10). */
  pageHint?: string;
  /** Validate every rung, not just up to the first valid one, so review can show them all. */
  allRungs?: boolean;
}

export type LocateResult =
  | {
      status: 'resolved';
      page: PageRef;
      match: Candidate;
      candidates: Candidate[];
      locator: Validation;
      /** Every rung tried, in order, with the reason each failed (NFR-08). */
      tried: Validation[];
      fingerprint: Fingerprint;
    }
  | {
      status: 'needs-review';
      page: PageRef;
      code: string;
      text: string;
      candidates: Candidate[];
      tried: Validation[];
    };

/**
 * `given.state` reuses a snapshot the caller already took. `given.node` skips matching and
 * locates that element, e.g. the candidate the tester picked for a NEEDS_REVIEW step.
 */
export async function locate(
  query: TargetQuery,
  mcp: McpBrowser,
  probe: LocatorProbe,
  options: LocateOptions,
  given: { state?: PageState; node?: SnapshotNode } = {},
): Promise<LocateResult> {
  const state = given.state ?? (await mcp.snapshot());
  const page = pageOf(state.url, state.title, options.pageHint);
  const found = findCandidates(query, parseSnapshot(state.snapshotYaml), options.config);
  let best: Candidate;
  if (given.node) {
    const ref = given.node.ref;
    best = found.candidates.find((c) => c.node.ref === ref) ?? {
      node: given.node,
      score: 0,
      matchedName: given.node.name,
      source: 'name',
      how: 'exact',
      notes: ['picked by the tester'],
    };
  } else if (found.status === 'needs-review') {
    return { ...found, page, tried: [] };
  } else {
    best = found.best;
  }
  const match = { best, candidates: found.candidates };

  const { node } = match.best;
  const review = (code: string, text: string, tried: Validation[] = []): LocateResult => ({
    status: 'needs-review',
    page,
    code,
    text,
    candidates: match.candidates,
    tried,
  });

  // Pin the snapshot element in the probe's view of the page. MCP knows which element the ref is,
  // so its generated locator is the anchor; role + name is the fallback; last, the probe's own
  // snapshot, whose refs are MCP's when the page has not changed (aria-ref).
  const browserPage = probe.page(state.url);
  const suggestion = await suggestLocator(mcp, node.ref!, node.name || node.role);
  const pins = [suggestion, node.name ? spec('getByRole', node.role, { name: node.name, exact: true }) : undefined].filter((s): s is LocatorSpec => !!s);
  let anchor: Awaited<ReturnType<LocatorProbe['resolve']>>['handle'];
  for (const s of pins) {
    anchor = (await probe.resolve(browserPage, s)).handle;
    if (anchor) break;
  }
  anchor ??= await probe.resolveRef(browserPage, node.ref!, state.snapshotYaml);
  if (!anchor) return review('CANNOT_PIN', `Found ${node.role} "${node.name}" [${node.ref}] but could not point to it on its own. Pick it on the screenshot.`);

  try {
    const facts = await probe.facts(anchor, options.testIdAttribute);
    const tried: Validation[] = [];
    for (const s of buildLadder(node, facts, suggestion ? [suggestion] : [])) {
      tried.push(await probe.validate(browserPage, s, query.kind, anchor));
      if (tried.at(-1)?.ok && !options.allRungs) break;
    }
    const winner = tried.find((v) => v.ok);
    if (winner) {
      return {
        status: 'resolved',
        page,
        match: match.best,
        candidates: match.candidates,
        locator: winner,
        tried,
        fingerprint: fingerprint(node, facts, contextOf(node)),
      };
    }
    return review('NO_VALID_LOCATOR', `No locator for ${node.role} "${node.name}" passed validation. ${tried.at(-1)?.reason ?? ''}`.trim(), tried);
  } finally {
    await anchor.dispose();
  }
}

/** MCP's own locator for a snapshot ref (FR-LO-07). A suggestion only: it is validated like the rest. */
async function suggestLocator(mcp: McpBrowser, ref: string, element: string): Promise<LocatorSpec | undefined> {
  if (!mcp.tools.has('browser_generate_locator')) return undefined;
  try {
    const reply = await mcp.callTool('browser_generate_locator', { target: ref, element });
    return parseLocatorCode(reply.sections.Result ?? '');
  } catch {
    return undefined;
  }
}
