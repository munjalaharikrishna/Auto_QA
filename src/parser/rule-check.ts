import { parseAssertions } from './assertions.js';
import { defaultParserConfig, type ParserConfig } from './config.js';
import { ruleKey, type ProjectRule } from './rules.js';
import { parseStepLine } from './steps.js';

/**
 * A project rule rewrites a sentence for every test case that uses it (S3), so it is checked before it is saved:
 * what it says must be read as a real step or a check that judges something. The answer is the problem, or
 * `undefined` when the rule is fine. Rules are read without other rules, so one cannot lean on another.
 */
export function ruleProblem(rule: Pick<ProjectRule, 'kind' | 'pattern' | 'meaning'>, config: ParserConfig = defaultParserConfig()): string | undefined {
  if (rule.kind === 'approved') return undefined;
  const meaning = rule.meaning.trim();
  if (!meaning) return 'Say what it means.';
  if (/[\r\n]/.test(meaning)) return 'A rule means one sentence, not several lines.';
  if (meaning.length > 300) return 'A rule means one short sentence.';
  if (ruleKey(rule.pattern) === ruleKey(meaning)) return 'The rule says the same thing as the wording it replaces.';
  if (rule.kind === 'element') return undefined;

  const plain = { ...config, rules: undefined };
  if (rule.kind === 'check') {
    const checks = parseAssertions(meaning, plain, false);
    const bad = checks.find((c) => !c.type || c.reason || c.type === 'observe' || c.type === 'health' || !(c.target || c.expected || c.match));
    return bad ? `"${meaning}" is not read as a check that judges something (${bad.reason?.text ?? 'it names nothing to look for'}). Write it as, for example: Error "…" is shown.` : undefined;
  }
  const line = parseStepLine(meaning, { config: plain, data: new Map() });
  if (line.kind === 'note') return `"${meaning}" is not a step: ${line.text}`;
  if (line.kind === 'checks') return line.checks.every((c) => c.type && !c.reason && c.type !== 'observe') ? undefined : `"${meaning}" is not read as a check that judges something.`;
  const actions = line.kind === 'actions' ? line.actions : [line.action];
  const bad = actions.find((a) => !a.action || a.reason);
  return bad ? `"${meaning}" is not read as a step${bad.reason ? `: ${bad.reason.text}` : ''}.` : undefined;
}
