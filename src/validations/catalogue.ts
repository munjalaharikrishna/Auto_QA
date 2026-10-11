import { SPECS } from './registry.js';

/**
 * Every kind of check, as a list a tester can choose from when adding an assertion to a test case (Web Automation).
 * It is the registry itself, so a check added there appears here without another change.
 */

export interface CatalogueEntry {
  /** The catalogue number, e.g. VAL-F01. */
  id: string;
  type: string;
  title: string;
  /** The family the check belongs to, from VALIDATIONS.md §3. */
  family: string;
  /** What the check needs from the page: nothing (page-level), one element, or two. */
  targets: 'none' | 'one' | 'two';
  /** Sentences the platform understands for this check. The tester edits one to name their own element or value. */
  examples: string[];
}

export const FAMILIES: Record<string, string> = {
  A: 'Page and navigation',
  B: 'Element presence and state',
  C: 'Text and content',
  D: 'Forms and input',
  E: 'Messages, dialogs and loading',
  F: 'Layout and visual',
  G: 'Tables and lists',
  H: 'Network',
  I: 'Health and errors',
  J: 'Login, session and security',
  K: 'Storage and state',
  L: 'Accessibility',
  M: 'Performance',
  N: 'Files',
  O: 'Data correctness',
  P: 'Timing and dynamic content',
  X: 'Other',
};

/** The URL checks (VAL-A01 to A03) are read by the parser itself, not by a spec in the registry. */
const IN_PARSER: CatalogueEntry[] = [
  {
    id: 'VAL-A01',
    type: 'url',
    title: 'URL contains / matches',
    family: FAMILIES.A,
    targets: 'none',
    examples: ['User is redirected to /dashboard', 'URL contains /orders'],
  },
  {
    id: 'VAL-A02',
    type: 'url',
    title: 'On a named page',
    family: FAMILIES.A,
    targets: 'none',
    examples: ['User is on the Dashboard page', 'Home page is displayed'],
  },
  {
    id: 'VAL-A03',
    type: 'url',
    title: 'Stays on the same page',
    family: FAMILIES.A,
    targets: 'none',
    examples: ['User remains on the Login page', 'User cannot open the Admin page'],
  },
];

export function catalogue(): CatalogueEntry[] {
  const fromRegistry = SPECS.map(
    (s): CatalogueEntry => ({
      id: s.id,
      type: s.type,
      title: s.title,
      family: FAMILIES[s.id.replace(/^VAL-/, '')[0]] ?? FAMILIES.X,
      targets: s.targets,
      examples: s.examples,
    }),
  );
  return [...IN_PARSER, ...fromRegistry].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
