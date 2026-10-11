import type { QaIr } from '../ir/schema.js';
import { type ComponentVersions, componentVersions } from '../versions.js';
import type { DecisionEntry } from './decision-log.js';
import { DecisionLog } from './decision-log.js';
import { PipelineError, runStages, type StageName } from './pipeline.js';
import { type CompileOptions, compileStages, type Plan } from './stages.js';

export type CompileStatus =
  /** Every stage ran: there is a valid QA-IR and a plan. */
  | 'compiled'
  /** Some of the text was not understood, so nothing was built on it (the legacy platform sets it aside the same way). */
  | 'needs-review'
  /** A stage broke its contract or failed. */
  | 'error';

export interface CompileResult {
  testId: string;
  status: CompileStatus;
  ir?: QaIr;
  plan?: Plan;
  pages?: Record<string, string | null>;
  unparsed: Array<{ id: string; raw: string; why: string }>;
  /** The stage that stopped or failed it. */
  stage?: StageName;
  error?: string;
  /** The stages that ran, in order. */
  ran: StageName[];
  log: DecisionEntry[];
  versions: ComponentVersions;
}

/** Runs one test case through the compilation stages of GV-15. Deterministic: the same input gives an identical result (GV-05). */
export async function compileCase(input: unknown, options: CompileOptions = {}): Promise<CompileResult> {
  const testId = typeof (input as { id?: unknown })?.id === 'string' ? (input as { id: string }).id : 'UNKNOWN';
  const log = new DecisionLog(testId);
  const base = { testId, unparsed: [], versions: componentVersions() };
  try {
    const run = await runStages(compileStages(options), input, { log, testId });
    if (run.stopped) {
      const unparsed = (run.output as { unparsed: CompileResult['unparsed'] }).unparsed;
      return { ...base, status: 'needs-review', unparsed, stage: run.stopped.stage, ran: run.ran, log: log.toJSON() };
    }
    const out = run.output as { ir: QaIr; plan: Plan; pages: Record<string, string | null> };
    return { ...base, status: 'compiled', ir: out.ir, plan: out.plan, pages: out.pages, ran: run.ran, log: log.toJSON() };
  } catch (e) {
    const stage = e instanceof PipelineError ? e.stage : undefined;
    return { ...base, status: 'error', stage, error: (e as Error).message, ran: [], log: log.toJSON() };
  }
}
