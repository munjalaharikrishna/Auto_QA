import type { ModelWarning, TestModel } from '../model/test-model.js';
import type { ParserConfig } from './config.js';
import { containsPhrase } from './text.js';

/**
 * Basic quality check (FR-QC-01, FR-QC-02): problems a tester should fix before exploration.
 * These are warnings; unparsed steps are already listed by the parser.
 */
export function checkQuality(model: TestModel, config: ParserConfig): ModelWarning[] {
  const warnings: ModelWarning[] = [];

  // Vague words that are also fillers were removed and already reported as FILLER_REMOVED.
  const vagueWords = config.lexicon.vague.filter((w) => !config.lexicon.fillers.includes(w));
  for (const item of [...model.steps, ...model.assertions.filter((a) => a.source === 'step')]) {
    const vague = containsPhrase(item.raw, vagueWords) ?? (/\breach\b.*\bstep\b/i.test(item.raw) ? 'reach … step' : undefined);
    if (vague) {
      warnings.push({
        at: item.id,
        code: 'VAGUE_STEP',
        text: `"${vague}" is vague. Name the exact element or page, or use a named flow for a sequence of steps.`,
      });
    }
  }

  const first = model.steps[0];
  const firstIsCheck = model.assertions.some((a) => a.source === 'step' && first && stepNumber(a.step) < stepNumber(first.id));
  const hasStart = model.preconditions.some((p) => p.kind === 'flow' || p.kind === 'logged-in');
  if ((!first || first.action !== 'navigate' || firstIsCheck) && !hasStart) {
    warnings.push({
      code: 'NO_START',
      text: 'The test does not say where it starts. Make step 1 "Open <page>", or add a precondition such as "On Login page".',
    });
  }

  if (!model.assertions.some((a) => a.source !== 'builtin' && a.status === 'parsed')) {
    warnings.push({ code: 'NO_CHECKS', text: 'No check could be read from the Expected Result, so only the "no crash" health check will run.' });
  }
  return warnings;
}

function stepNumber(id: string | undefined): number {
  return id ? Number(id.slice(1)) : Infinity;
}
