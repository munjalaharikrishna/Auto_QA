import type { ResolvedValue } from '../data/resolver.js';
import type { QaIr } from '../ir/schema.js';
import type { CaseLanguage, Unit } from '../language/case.js';
import type { Issue } from '../language/types.js';
import { type ProductionPattern, redactProduction } from '../patterns/redact.js';
import { type ComponentVersions, componentVersions } from '../versions.js';
import type { DecisionEntry } from './decision-log.js';
import { DecisionLog } from './decision-log.js';
import { PipelineError, runStages, type StageName } from './pipeline.js';
import { type CompileOptions, compileStages, type Plan, settleData } from './stages.js';

export type CompileStatus =
  /** Every stage ran: there is a valid QA-IR and a plan. */
  | 'compiled'
  /** Some of the text was not understood, or a person must decide something first: not safe to run unattended. */
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
  /** Everything the language layers could not read cleanly, with the tester's words and a clearer way to write it (GV-14, BP-5). */
  issues: Issue[];
  /** Each sentence of the test case and whether it was understood (the unit of the coverage report). */
  units: Unit[];
  /** How often each grammar model was used. */
  models: CaseLanguage['models'];
  /** The values for the run (DR-01), in memory only: a secret is a `Secret`, written as `***` by anything that turns it into text. */
  values?: Record<string, ResolvedValue>;
  /** The stage that stopped or failed it. */
  stage?: StageName;
  error?: string;
  /** The stages that ran, in order. */
  ran: StageName[];
  log: DecisionEntry[];
  versions: ComponentVersions;
}

const summary = (language: CaseLanguage): Pick<CompileResult, 'issues' | 'units' | 'models'> => ({
  issues: language.issues,
  units: language.units,
  models: language.models,
});

/** Runs one test case through the compilation stages of GV-15. Deterministic: the same input gives an identical result (GV-05). */
export async function compileCase(input: unknown, options: CompileOptions = {}): Promise<CompileResult> {
  const result = await compileOnce(input, options);
  return options.productionPatterns?.length ? withoutProductionIds(result, options.productionPatterns) : result;
}

/**
 * DS-01: production identifiers are taken out of everything the compile writes (the document, the log, the issues). The
 * values for the run are left as they are: they are in memory, and a secret in them cannot be written anyway.
 */
function withoutProductionIds(result: CompileResult, patterns: ProductionPattern[]): CompileResult {
  const { values, ...rest } = result;
  const clean = JSON.parse(redactProduction(JSON.stringify(rest), patterns).text) as Omit<CompileResult, 'values'>;
  return { ...clean, ...(values ? { values } : {}) };
}

async function compileOnce(input: unknown, options: CompileOptions): Promise<CompileResult> {
  const testId = typeof (input as { id?: unknown })?.id === 'string' ? (input as { id: string }).id : 'UNKNOWN';
  const log = new DecisionLog(testId);
  const base = { testId, unparsed: [], issues: [] as Issue[], units: [] as Unit[], models: {} as CaseLanguage['models'], versions: componentVersions() };
  try {
    const run = await runStages(compileStages(options), input, { log, testId });
    if (run.stopped) {
      const out = run.output as { unparsed: CompileResult['unparsed']; language: CaseLanguage };
      // The values are settled all the same, so the report does not ask about what the resolver can answer.
      const settled = out.language.ir ? await settleData(options, out.language, out.language.ir) : undefined;
      const language = settled ? { ...out.language, issues: settled.issues } : out.language;
      return { ...base, status: 'needs-review', unparsed: out.unparsed, ...summary(language), stage: run.stopped.stage, ran: run.ran, log: log.toJSON() };
    }
    const out = run.output as { ir: QaIr; plan: Plan; pages: Record<string, string | null>; language: CaseLanguage; values?: Record<string, ResolvedValue> };
    // A document that was built can still hold something a person must decide (missing data, an unknown branch, a reference).
    const review = out.language.issues.some((i) => i.severity !== 'info');
    return {
      ...base,
      status: review ? 'needs-review' : 'compiled',
      ir: out.ir,
      plan: out.plan,
      pages: out.pages,
      ...(out.values ? { values: out.values } : {}),
      ...summary(out.language),
      ran: run.ran,
      log: log.toJSON(),
    };
  } catch (e) {
    const stage = e instanceof PipelineError ? e.stage : undefined;
    return { ...base, status: 'error', stage, error: (e as Error).message, ran: [], log: log.toJSON() };
  }
}
