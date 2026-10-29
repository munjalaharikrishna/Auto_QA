import { createHash } from 'node:crypto';
import { maskDeep } from '../data/secret.js';
import type { LocatorContractRef, RunTrace, StepRecord } from '../execute/executor.js';
import type { ExecutionPlan } from '../execute/planner.js';
import type { Tried } from '../locate/types.js';

/**
 * Layer 74, the audit trail (GV-02). Every call the engine made in a run, in the order it made it, tied to the step it served and
 * to the locator contract it acted on: Page → Component → Semantic name → Selector chain. From any entry a person can go to the
 * step and the contract; from any step to its calls; from any contract to the calls made through it. The trail is built from the
 * run's own record, so it holds exactly what happened, and is the same every time for the same record (GV-05).
 */

export interface AuditEntry {
  /** The number of the call in the run, from 1 with no gaps. */
  seq: number;
  at: number;
  ms: number;
  step: string;
  stepStatus: StepRecord['status'];
  action: string;
  /** The tester's own words for the step. */
  original: string;
  /** The function of the action planner, and how it was done. */
  fn: string;
  via: 'mcp' | 'page';
  tool: string;
  /** What the tool was given. A secret is masked. */
  args: Record<string, unknown>;
  outcome: 'ok' | 'failed';
  error?: string;
  /** The contract of the locator this call acted on, when the call names the selector of the step's element. */
  contract?: string;
}

export interface AuditContract extends LocatorContractRef {
  step: string;
  /** The candidate level the element was found at, and the chain of levels that were tried. */
  level: string;
  weight: number;
  selector: string;
  chain: Tried[];
  element: { tag: string; role: string };
}

export interface AuditStep {
  step: string;
  action: string;
  original: string;
  status: StepRecord['status'];
  code?: string;
  reason?: string;
  /** The numbers of its calls, in order. */
  calls: number[];
  contract?: string;
  notes: string[];
}

export interface AuditTrail {
  version: 1;
  testId: string;
  status: RunTrace['status'];
  /** The versions of the components that made the plan (GV-12). */
  versions: Record<string, string>;
  steps: AuditStep[];
  entries: AuditEntry[];
  contracts: AuditContract[];
  stoppedAt?: RunTrace['stoppedAt'];
}

export interface AuditOptions {
  /** Values that must not appear in the trail (typed secrets, a one-time code): they are masked wherever they would show. */
  secrets?: Iterable<string>;
}

/** The id a contract has: the same page, name and selector give the same one (see the executor). */
export const contractIdOf = (page: string, semantic: string, selector: string): string =>
  createHash('sha256').update(`${page}|${semantic}|${selector}`).digest('hex').slice(0, 12);

export function auditOf(trace: RunTrace, plan: ExecutionPlan, options: AuditOptions = {}): AuditTrail {
  const contracts: AuditContract[] = [];
  const entries: AuditEntry[] = [];
  const steps: AuditStep[] = [];
  for (const s of trace.steps) {
    const loc = s.located;
    if (loc) {
      contracts.push({
        ...loc.contract,
        step: s.step,
        level: loc.level,
        weight: loc.weight,
        selector: loc.selector,
        chain: loc.tried,
        element: { tag: loc.element.tag, role: loc.element.role },
      });
    }
    for (const c of s.calls) {
      entries.push({
        seq: c.seq,
        at: c.at,
        ms: c.ms,
        step: s.step,
        stepStatus: s.status,
        action: s.action,
        original: s.original,
        fn: c.fn,
        via: c.via,
        tool: c.tool,
        args: c.args,
        outcome: c.outcome,
        ...(c.error ? { error: c.error } : {}),
        ...(loc && c.args.target === loc.selector ? { contract: loc.contract.id } : {}),
      });
    }
    steps.push({
      step: s.step,
      action: s.action,
      original: s.original,
      status: s.status,
      ...(s.code ? { code: s.code } : {}),
      ...(s.reason ? { reason: s.reason } : {}),
      calls: s.calls.map((c) => c.seq),
      ...(loc ? { contract: loc.contract.id } : {}),
      notes: s.notes,
    });
  }
  entries.sort((a, b) => a.seq - b.seq);
  const trail: AuditTrail = {
    version: 1,
    testId: trace.testId,
    status: trace.status,
    versions: plan.versions,
    steps,
    entries,
    contracts,
    ...(trace.stoppedAt ? { stoppedAt: trace.stoppedAt } : {}),
  };
  return options.secrets ? maskDeep(trail, options.secrets) : trail;
}

/**
 * Whether the trail is complete and sound against the run it was made from. It returns every problem, in words; none means every
 * call of the run is in it, once, in order, and every step and contract it names exists. A trail that fails is not evidence.
 */
export function checkTrail(trail: AuditTrail, trace: RunTrace, plan: ExecutionPlan): string[] {
  const problems: string[] = [];
  const calls = trace.steps.flatMap((s) => s.calls.map((c) => ({ ...c, step: s.step })));
  if (trail.entries.length !== calls.length) problems.push(`the run made ${calls.length} call(s) and the trail has ${trail.entries.length}`);
  const seqs = trail.entries.map((e) => e.seq);
  seqs.forEach((n, i) => {
    if (n !== i + 1) problems.push(`the call numbers are not 1, 2, 3 …: the ${i + 1}th is numbered ${n}`);
  });
  const planned = new Map(plan.chains.map((c) => [c.step, c]));
  const traced = new Map(trace.steps.map((s) => [s.step, s]));
  const contractIds = new Set(trail.contracts.map((c) => c.id));
  for (const e of trail.entries) {
    if (!traced.has(e.step)) problems.push(`call ${e.seq} names step ${e.step}, which the run does not have`);
    if (!planned.has(e.step)) problems.push(`call ${e.seq} names step ${e.step}, which the plan does not have`);
    if (e.outcome === 'failed' && !e.error) problems.push(`call ${e.seq} failed and says nothing about why`);
    if (e.contract && !contractIds.has(e.contract)) problems.push(`call ${e.seq} names contract ${e.contract}, which the trail does not have`);
  }
  for (const c of trail.contracts) {
    if (contractIdOf(c.page, c.semantic, c.selector) !== c.id)
      problems.push(`contract ${c.id} (${c.semantic}) is not the contract of its page, name and selector`);
    if (!traced.has(c.step)) problems.push(`contract ${c.id} names step ${c.step}, which the run does not have`);
    if (c.chain.length === 0) problems.push(`contract ${c.id} (${c.semantic}) has no chain of levels that were tried`);
  }
  for (const s of trail.steps) {
    const chain = planned.get(s.step);
    const record = traced.get(s.step);
    if (!chain || !record) continue;
    const acts = chain.ops.some((o) => o.op === 'act' && o.function !== undefined);
    // A step that was done and was to act through the tool, but made no call, must say why ("already ticked").
    if (s.status === 'done' && acts && s.calls.length === 0 && s.notes.length === 0)
      problems.push(`step ${s.step} (${s.original}) was done, made no call and gives no reason`);
    if (s.status === 'done' && chain.ops.some((o) => o.op === 'resolve-locator') && !s.contract && chain.target)
      problems.push(`step ${s.step} (${s.original}) found an element and has no locator contract`);
    if (s.status === 'done' && s.contract) {
      const linked = trail.entries.filter((e) => e.step === s.step && e.contract === s.contract).length;
      if (linked === 0 && s.calls.length > 0 && chain.ops.some((o) => o.op === 'act' && o.function !== undefined && o.function !== 'navigate'))
        problems.push(`step ${s.step} (${s.original}) acted through the tool but no call names its locator contract ${s.contract}`);
    }
  }
  return problems;
}

/** The trail as lines a person can read: call by call, with the step and the contract it came from. */
export function renderTrail(trail: AuditTrail): string {
  const byContract = new Map(trail.contracts.map((c) => [c.id, c]));
  const lines = [`Audit of ${trail.testId}: ${trail.status}, ${trail.entries.length} call(s), ${trail.contracts.length} locator contract(s)`];
  for (const s of trail.steps) {
    lines.push(`${s.step} ${s.action} [${s.status}] "${s.original}"${s.reason ? `: ${s.reason}` : ''}`);
    for (const e of trail.entries.filter((x) => x.step === s.step)) {
      const c = e.contract ? byContract.get(e.contract) : undefined;
      lines.push(
        `  #${e.seq} ${e.via} ${e.tool} (${e.fn}) ${e.outcome} ${e.ms}ms${e.error ? ` — ${e.error}` : ''}${c ? `  ⇒ ${c.id}: ${c.page} → ${c.component ?? '(no component)'} → ${c.semantic} @ ${c.level}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}
