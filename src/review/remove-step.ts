import type { RawTestCase } from '../model/test-model.js';
import { numbered, ruleKey } from '../parser/rules.js';

/**
 * U1 step 5, "Remove this step": a step line that asks a question nobody needs answered ("Verify Broswer should be Opened": the browser
 * opens by itself) is taken out of the test case. The lines after it move up by one, numbered lines are numbered again, and the expected
 * result written for each step follows its step; the expected result of the removed step goes with it. Undefined when the case has no
 * such line, so nothing is changed by mistake.
 */
export function removeStep(raw: RawTestCase, sentence: string): RawTestCase | undefined {
  const want = ruleKey(sentence);
  const lines = raw.steps.split('\n');
  const at = lines.findIndex((l) => ruleKey(numbered(l).text) === want);
  if (at < 0) return undefined;
  const removedNo =
    Number(
      numbered(lines[at] as string)
        .lead.trim()
        .replace(/[.):-]$/, ''),
    ) || undefined;
  const kept: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (i === at) continue;
    const { lead, text } = numbered(line);
    const n = Number(lead.trim().replace(/[.):-]$/, ''));
    if (lead && removedNo !== undefined && Number.isInteger(n) && n > removedNo) kept.push(lead.replace(String(n), String(n - 1)) + text);
    else kept.push(line);
  }
  const out: RawTestCase = { ...raw, steps: kept.join('\n') };
  if (raw.stepExpected && removedNo !== undefined) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.stepExpected)) {
      const n = Number(k);
      if (n === removedNo) continue;
      next[String(n > removedNo ? n - 1 : n)] = v;
    }
    out.stepExpected = next;
  }
  return out;
}
