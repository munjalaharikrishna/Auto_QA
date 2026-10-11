import type { z } from 'zod';
import { pathText } from '../ir/validate.js';
import type { DecisionLog } from './decision-log.js';

/**
 * The compilation sequence (GV-15): one stage per step, each a separate component with a typed output.
 * A stage whose output does not match its declared shape stops the pipeline, naming the stage.
 */

export const STAGE_NAMES = [
  'Read',
  'Understand',
  'Validate',
  'BuildIr',
  'ResolveData',
  'ResolvePage',
  'ResolveTarget',
  'BuildPlan',
  'ValidatePlan',
  'Execute',
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface StageContext {
  log: DecisionLog;
  testId: string;
}

export interface Stage<I, O> {
  name: StageName;
  /** The shape the stage must return. */
  output: z.ZodType<O>;
  run(input: I, ctx: StageContext): O | Promise<O>;
  /** A reason to stop here without an error: the later stages have nothing to work on (e.g. the text was not understood). */
  stopWhen?(output: O): string | undefined;
}

export class PipelineError extends Error {
  constructor(
    readonly stage: StageName,
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(`Stage ${stage}: ${message}`);
    this.name = 'PipelineError';
  }
}

export interface PipelineRun {
  /** The last stage's output (or the one that stopped the pipeline). */
  output: unknown;
  /** The stages that ran, in order. */
  ran: StageName[];
  stopped?: { stage: StageName; reason: string };
}

// biome-ignore lint/suspicious/noExplicitAny: a pipeline chains stages of different types; each one is checked against its own schema
export type AnyStage = Stage<any, any>;

export async function runStages(stages: AnyStage[], input: unknown, ctx: StageContext): Promise<PipelineRun> {
  let value = input;
  const ran: StageName[] = [];
  for (const stage of stages) {
    let produced: unknown;
    try {
      produced = await stage.run(value, ctx);
    } catch (e) {
      if (e instanceof PipelineError) throw e;
      ctx.log.add(stage.name, 'error', (e as Error).message);
      throw new PipelineError(stage.name, (e as Error).message);
    }
    const checked = stage.output.safeParse(produced);
    if (!checked.success) {
      const issues = checked.error.issues.map((i) => ({ path: pathText(i.path), message: i.message }));
      ctx.log.add(stage.name, 'error', 'returned data in the wrong shape', { fields: issues.map((i) => i.path) });
      throw new PipelineError(stage.name, `returned data in the wrong shape (${issues.map((i) => `${i.path}: ${i.message}`).join('; ')})`, issues);
    }
    value = checked.data;
    ran.push(stage.name);
    const reason = stage.stopWhen?.(value);
    if (reason) {
      ctx.log.add(stage.name, 'decision', `stopped: ${reason}`);
      return { output: value, ran, stopped: { stage: stage.name, reason } };
    }
  }
  return { output: value, ran };
}
