import { contextOf, flatten, nearbyText, type SnapshotNode } from '../explorer/snapshot-parser.js';
import type { Action, AssertionType } from '../model/test-model.js';
import { normKey, type ParserConfig, synonymsOf } from '../parser/config.js';

/**
 * Candidate search and scoring (FR-LO-03, FR-LO-04, FR-LO-05): which snapshot element does a step mean?
 *
 * Pure and deterministic: the same step and snapshot always give the same ranking (NFR-02).
 * It never guesses (D6): no match, or two close matches, is NEEDS_REVIEW with the candidates.
 */

/** What the matcher needs from a step or an assertion. */
export interface TargetQuery {
  kind: Action | AssertionType;
  target?: string;
  alternatives: string[];
  exact?: boolean;
  roleHint?: string;
}

export type NameSource = 'name' | 'text' | 'nearby' | 'heading';

export interface Candidate {
  node: SnapshotNode;
  /** 0–1. See SCORE for how it is built. */
  score: number;
  /** Which of the node's names matched, and how, for the review screen (NFR-08). */
  matchedName: string;
  source: NameSource;
  how: 'exact' | 'synonym' | 'contains' | 'fuzzy' | 'only-one';
  notes: string[];
}

export type MatchResult =
  | { status: 'matched'; best: Candidate; candidates: Candidate[] }
  | { status: 'needs-review'; code: 'NO_MATCH' | 'AMBIGUOUS' | 'NO_TARGET'; text: string; candidates: Candidate[] };

/** Scoring constants. Changing them changes which element wins, so tests pin the behaviour. */
export const SCORE = {
  exact: 1,
  synonym: 0.9,
  /** Scaled by the fourth root of how much of the longer name the shorter one covers: "Add" in "Add to cart" ≈ 0.65. */
  contains: 0.85,
  /** Scaled by the similarity; only similarity >= fuzzyFloor counts. */
  fuzzy: 0.75,
  fuzzyFloor: 0.75,
  /** An unnamed element that is the only one of the role the tester named ("Select Option 2 from the dropdown"). */
  onlyOne: 0.7,
  /** Names taken from nearby text or a heading are less certain than a real accessible name. */
  sourceWeight: { name: 1, text: 1, nearby: 0.95, heading: 0.9 } as Record<NameSource, number>,
  roleHintMatch: 0.05,
  roleHintMismatch: -0.15,
  inDialog: 0.05,
  /** Below this nothing is picked. */
  minimum: 0.6,
  /** If the second candidate is within this of the first, nothing is picked. */
  margin: 0.1,
};

/** Roles an action can work on (FR-LO-03). Assertions not listed accept any element. */
const ROLES: Partial<Record<TargetQuery['kind'], string[]>> = {
  fill: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  clear: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  click: ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem', 'checkbox', 'radio', 'switch'],
  select: ['combobox', 'listbox'],
  check: ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'],
  uncheck: ['checkbox', 'switch', 'menuitemcheckbox'],
  upload: ['button', 'textbox'],
  checked: ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'],
  value: ['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox', 'slider'],
  enabled: ['button', 'link', 'textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'switch', 'listbox', 'slider', 'tab', 'menuitem'],
  disabled: ['button', 'link', 'textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'switch', 'listbox', 'slider', 'tab', 'menuitem'],
};

/** Roles that are page structure, never a step's target. */
const STRUCTURE = new Set([
  'generic',
  'text',
  'paragraph',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'region',
  'form',
  'group',
  'list',
  'separator',
  'document',
]);

export function rolesFor(kind: TargetQuery['kind']): string[] | undefined {
  return ROLES[kind];
}

export function findCandidates(query: TargetQuery, nodes: SnapshotNode[], config: ParserConfig): MatchResult {
  const roles = rolesFor(query.kind);
  // A check that something is shown may point at plain text, e.g. saucedemo's "Products" title is a span.
  const textOk = query.kind === 'visible' || query.kind === 'text';
  const pool = flatten(nodes).filter(
    (n) => n.ref && (!STRUCTURE.has(n.role) || (textOk && !!n.text && !n.children.length)) && (!roles || roles.includes(n.role)),
  );
  const wanted = [query.target, ...query.alternatives].filter((w): w is string => !!w?.trim());

  if (!wanted.length) return onlyOfRole(query, pool);

  const candidates = pool
    .map((node) => scoreNode(node, wanted, query, config))
    .filter((c): c is Candidate => !!c)
    .sort((a, b) => b.score - a.score);
  // Stable sort keeps document order for equal scores.

  return decide(candidates, wanted[0]);
}

function decide(candidates: Candidate[], label: string): MatchResult {
  const [first, second] = candidates;
  if (!first || first.score < SCORE.minimum) {
    return {
      status: 'needs-review',
      code: 'NO_MATCH',
      text: `No element on the page matches "${label}"${first ? ` well enough (best: "${first.matchedName}", ${first.score.toFixed(2)})` : ''}. Pick it on the screenshot.`,
      candidates,
    };
  }
  if (second && first.score - second.score < SCORE.margin) {
    const close = candidates.filter((c) => first.score - c.score < SCORE.margin);
    return {
      status: 'needs-review',
      code: 'AMBIGUOUS',
      text: `${close.length} elements match "${label}" almost equally (${close.map(describe).join(', ')}). Pick the right one.`,
      candidates,
    };
  }
  return { status: 'matched', best: first, candidates };
}

function onlyOfRole(query: TargetQuery, pool: SnapshotNode[]): MatchResult {
  const hinted = query.roleHint ? pool.filter((n) => n.role === query.roleHint) : [];
  if (hinted.length === 1) {
    const best: Candidate = {
      node: hinted[0],
      score: SCORE.onlyOne,
      matchedName: '',
      source: 'name',
      how: 'only-one',
      notes: [`the only ${query.roleHint} on the page`],
    };
    return { status: 'matched', best, candidates: [best] };
  }
  return {
    status: 'needs-review',
    code: 'NO_TARGET',
    text: query.roleHint
      ? `The step names no element and the page has ${hinted.length} ${query.roleHint} elements. Name the element or pick it.`
      : 'The step names no element. Name the element or pick it.',
    candidates: hinted.map((node) => ({ node, score: 0, matchedName: '', source: 'name', how: 'only-one', notes: [] })),
  };
}

function scoreNode(node: SnapshotNode, wanted: string[], query: TargetQuery, config: ParserConfig): Candidate | undefined {
  let best: Omit<Candidate, 'node' | 'notes'> | undefined;
  for (const [name, source] of namesOf(node)) {
    for (const w of wanted) {
      const m = compare(w, name, !!query.exact, config);
      if (!m) continue;
      const score = m.score * SCORE.sourceWeight[source];
      if (!best || score > best.score) best = { score, matchedName: name, source, how: m.how };
    }
  }
  if (!best) return undefined;

  const notes: string[] = [];
  let score = best.score;
  if (best.source !== 'name' && best.source !== 'text') notes.push(`named by ${best.source === 'nearby' ? 'nearby text' : 'the heading above it'}`);
  if (query.roleHint && query.roleHint !== 'page') {
    if (query.roleHint === node.role) score += SCORE.roleHintMatch;
    else {
      score += SCORE.roleHintMismatch;
      notes.push(`the step says ${query.roleHint}, the element is a ${node.role}`);
    }
  }
  if (inDialog(node)) {
    score += SCORE.inDialog;
    notes.push('inside an open dialog');
  }
  return { node, ...best, score: round(Math.min(1, Math.max(0, score))), notes };
}

/** Every name a node can be called by, best source first. */
export function namesOf(node: SnapshotNode): Array<[string, NameSource]> {
  const names: Array<[string, NameSource]> = [];
  if (node.name) names.push([node.name, 'name']);
  if (node.text && node.text !== node.name) names.push([node.text, 'text']);
  if (!node.name) {
    const near = nearbyText(node);
    if (near) names.push([near, 'nearby']);
    const heading = headingBefore(node);
    if (heading) names.push([heading, 'heading']);
  }
  return names;
}

/** An unnamed field right after a heading is often captioned by it, e.g. heading "Dropdown List" then a combobox. */
function headingBefore(node: SnapshotNode): string | undefined {
  const siblings = node.parent?.children ?? [];
  const prev = siblings[siblings.indexOf(node) - 1];
  return prev?.role === 'heading' && prev.name ? prev.name : undefined;
}

function compare(wanted: string, name: string, exact: boolean, config: ParserConfig): { score: number; how: Candidate['how'] } | undefined {
  const a = normKey(wanted);
  const b = normKey(name);
  if (!a || !b) return undefined;
  if (a === b) return { score: SCORE.exact, how: 'exact' };
  // A quoted name means exactly that text: no synonyms, partial or fuzzy matches.
  if (exact) return undefined;

  if (synonymsOf(config, wanted).includes(b)) return { score: SCORE.synonym, how: 'synonym' };

  const wordsA = words(wanted);
  const wordsB = words(name);
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  if (shorter.length && containsRun(longer, shorter)) {
    return { score: round(SCORE.contains * (shorter.join('').length / longer.join('').length) ** 0.25), how: 'contains' };
  }

  const similarity = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  if (similarity >= SCORE.fuzzyFloor) return { score: round(SCORE.fuzzy * similarity), how: 'fuzzy' };
  return undefined;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whether `inner` appears as consecutive whole words inside `outer`. */
function containsRun(outer: string[], inner: string[]): boolean {
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

function inDialog(node: SnapshotNode): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.role === 'dialog' || p.role === 'alertdialog') return true;
  return false;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function describe(c: Candidate): string {
  const ctx = contextOf(c.node);
  return `${c.node.role} "${c.matchedName || c.node.name}"${ctx ? ` in ${ctx}` : ''} [${c.node.ref}] ${c.score.toFixed(2)}`;
}
