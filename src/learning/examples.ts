import { compileCase } from '../engine/pipeline/compile.js';
import type { ReadingPayload } from './entries.js';

/**
 * E0.18 step 6, the worked example of a reading. When a reading is saved, the engine reads its new sentence and the result is kept with
 * it: for a step, the action and its target; for a check, the kind of check, its target, its expected value and whether it is negated.
 * Every run reads the sentence again and compares. When a change of the engine reads it otherwise, the reading is set aside with the
 * reason, so what a person approved is never changed in silence.
 */
export async function readsAs(kind: ReadingPayload['readingKind'], sentence: string): Promise<string | undefined> {
  const raw =
    kind === 'step'
      ? { id: 'EXAMPLE', title: 'example', steps: `1. ${sentence}`, expected: 'The Example heading is displayed' }
      : { id: 'EXAMPLE', title: 'example', steps: '1. Open the application', expected: sentence };
  const compiled = await compileCase(raw, { env: {} }).catch(() => undefined);
  const ir = compiled?.ir;
  if (!ir) return undefined;
  if (kind === 'step') {
    const step = ir.steps.find((s) => s.original === sentence) ?? ir.steps[0];
    if (!step) return undefined;
    const t = step.target;
    return [step.action, t?.ontology ?? '', t?.name ?? t?.label ?? '', t?.within ?? '', (t?.row ?? []).join(',')].join('|');
  }
  const checks = ir.expectations.map((e) => {
    const c = e.condition;
    return [e.negated ? 'not' : '', c.type, c.target?.ontology ?? '', c.target?.name ?? c.target?.label ?? '', c.expect ?? ''].join('|');
  });
  return checks.length ? checks.join(' ; ') : undefined;
}

/** Whether the engine still reads a reading's sentence as it did when it was saved; the reason when it does not. */
export async function exampleProblem(p: ReadingPayload): Promise<string | undefined> {
  if (!p.readsAs) return undefined;
  const now = await readsAs(p.readingKind, p.to);
  if (now === p.readsAs) return undefined;
  return `"${p.to}" was read as ${p.readsAs} when it was saved, and is read as ${now ?? 'nothing'} now: a person checks the reading again`;
}
