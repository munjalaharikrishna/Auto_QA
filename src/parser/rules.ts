/**
 * Project rules (REAL-WORLD-TEST-CASES.md M3, FR-RULE): every answer a tester gives in review is kept for the project,
 * so the same wording is never asked about again.
 *
 *   step     "Do the needful"   →  "Click the Login button"     how a step is read
 *   check    "It works fine"    →  "Dashboard is displayed"     how an expected result is read
 *   element  "username"         →  "Login Name"                 which name on the screen a word means
 *   approved "S3: …"            →  (a learned or assumed value the tester looked at and accepted)
 */

export const RULE_KINDS = ['step', 'check', 'element', 'approved'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface ProjectRule {
  id: string;
  projectId: string;
  kind: RuleKind;
  /** The tester's wording, in the form `ruleKey` makes. */
  pattern: string;
  /** What it means: the replacement wording, or the name on the screen. Empty for `approved`. */
  meaning: string;
  /** Where the rule came from: "picked on the screenshot", "grouped review", "imported"… */
  source: string;
  enabled: boolean;
  createdAt: string;
}

/** The rules the parser and the explorer look things up in. */
export interface ParserRules {
  step: Record<string, string>;
  check: Record<string, string>;
  element: Record<string, string>;
}

/** Wording compared without case, quotes, extra spaces or a final full stop. */
export function ruleKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/["“”‘’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .trim();
}

/** Only the rules that are switched on. */
export function rulesFor(rules: Iterable<Pick<ProjectRule, 'kind' | 'pattern' | 'meaning' | 'enabled'>>): ParserRules {
  const out: ParserRules = { step: {}, check: {}, element: {} };
  for (const r of rules) {
    if (!r.enabled || r.kind === 'approved') continue;
    out[r.kind][ruleKey(r.pattern)] = r.meaning;
  }
  return out;
}

/** The text a rule says to read instead, or the text itself. `rule` is set when one applied. */
export function applyWording(text: string, table: Record<string, string> | undefined): { text: string; rule?: { from: string; to: string } } {
  const to = table?.[ruleKey(text)];
  return to === undefined ? { text } : { text: to, rule: { from: text, to } };
}
