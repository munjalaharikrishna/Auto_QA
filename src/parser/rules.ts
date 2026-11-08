import type { RawTestCase } from '../model/test-model.js';

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

/** A step line split into its number ("17. ") and its sentence, so a reading matches the sentence however the line is numbered. */
function numbered(line: string): { lead: string; text: string } {
  let i = 0;
  while (i < line.length && line[i] === ' ') i += 1;
  const start = i;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i += 1;
  if (i === start || !['.', ')', ':', '-'].includes(line[i] ?? '')) return { lead: '', text: line };
  i += 1;
  while (i < line.length && line[i] === ' ') i += 1;
  return { lead: line.slice(0, i), text: line.slice(i) };
}

const readLine = (
  line: string,
  first: Record<string, string> | undefined,
  second: Record<string, string> | undefined,
  applied: Array<{ from: string; to: string }>,
): string => {
  const { lead, text } = numbered(line);
  const key = ruleKey(text);
  const to = key ? (first?.[key] ?? second?.[key]) : undefined;
  if (to === undefined) return line;
  applied.push({ from: text.trim(), to });
  return `${lead}${to}`;
};

/**
 * E0.19 step 3: the test case as a person's answers say it is meant. Each step line, expected result and step result whose sentence
 * a project reading names is read as the reading's sentence (steps by the step readings first, results by the check readings first).
 * The new engine reads the case this way, so one answer holds for every case and every sheet of the project that has that sentence.
 */
export function withReadings(
  raw: RawTestCase,
  rules: Pick<ParserRules, 'step' | 'check'> | undefined,
): { raw: RawTestCase; applied: Array<{ from: string; to: string }> } {
  const applied: Array<{ from: string; to: string }> = [];
  if (!rules || (!Object.keys(rules.step).length && !Object.keys(rules.check).length)) return { raw, applied };
  const lines = (text: string, first: Record<string, string>, second: Record<string, string>) =>
    text
      .split('\n')
      .map((l) => readLine(l, first, second, applied))
      .join('\n');
  const out: RawTestCase = {
    ...raw,
    steps: lines(raw.steps, rules.step, rules.check),
    expected: lines(raw.expected, rules.check, rules.step),
    ...(raw.stepExpected ? { stepExpected: Object.fromEntries(Object.entries(raw.stepExpected).map(([k, v]) => [k, lines(v, rules.check, rules.step)])) } : {}),
  };
  return applied.length ? { raw: out, applied } : { raw, applied };
}

/** The text a rule says to read instead, or the text itself. `rule` is set when one applied. */
export function applyWording(text: string, table: Record<string, string> | undefined): { text: string; rule?: { from: string; to: string } } {
  const to = table?.[ruleKey(text)];
  return to === undefined ? { text } : { text: to, rule: { from: text, to } };
}
