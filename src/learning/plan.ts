import { type ProjectRule, ruleKey } from '../parser/rules.js';
import type { ApprovalPayload, LabelPayload, NewEntry, ReadingPayload } from './entries.js';
import { approvalParts, norm, validateApproval, validateLabel, validateReading } from './validate.js';

/**
 * The plan for moving the project rules of migration 0005 into learned entries. Nothing is written here: the plan says, for each
 * rule, what entry it becomes and why it has the status it has. A rule is never carried over as it is:
 *
 *   step / check  → a reading, which must read as a real step or a check that judges something, or it is quarantined
 *   element       → a label, active only when the application was seen to show that name, otherwise pending for a person
 *   approved      → an approval, active only when what it accepts is still active, otherwise quarantined
 *
 * A rule that was switched off stays off. A rule that fails its checks is quarantined even if it was switched on.
 */

export interface MigrationContext {
  /** The names the application was seen to show, per project (from what earlier runs saw), in `norm` form. Absent: nothing is known. */
  knownNames?: (projectId: string) => ReadonlySet<string> | undefined;
}

export type PlannedEntry = NewEntry & { projectId: string };

const SOURCE = (rule: ProjectRule): string => `migrated from project rule ${rule.id} (${rule.source})`;

export function planRuleMigration(rules: readonly ProjectRule[], ctx: MigrationContext = {}): PlannedEntry[] {
  const out: PlannedEntry[] = [];
  const settle = (rule: ProjectRule, outcome: { status: 'active' | 'pending' | 'quarantined' }): PlannedEntry['status'] =>
    outcome.status === 'quarantined' ? 'quarantined' : rule.enabled ? outcome.status : 'disabled';

  // Readings first: an approval can depend on one.
  const readings = new Map<string, Array<{ from: string; to: string }>>();
  for (const rule of rules.filter((r) => r.kind === 'step' || r.kind === 'check')) {
    const payload: ReadingPayload = { readingKind: rule.kind as 'step' | 'check', from: rule.pattern, to: rule.meaning };
    const outcome = validateReading(payload);
    const status = settle(rule, outcome);
    out.push({
      projectId: rule.projectId,
      kind: 'reading',
      status,
      key: `${rule.kind}|${ruleKey(rule.pattern)}`,
      payload: { ...payload },
      source: SOURCE(rule),
      author: 'migration',
      legacyRuleId: rule.id,
      validation: outcome.validation,
    });
    if (status === 'active') readings.set(rule.projectId, [...(readings.get(rule.projectId) ?? []), { from: rule.pattern, to: rule.meaning }]);
  }

  for (const rule of rules.filter((r) => r.kind === 'element')) {
    const payload: LabelPayload = { label: rule.pattern, means: rule.meaning };
    const outcome = validateLabel(payload, ctx.knownNames?.(rule.projectId));
    out.push({
      projectId: rule.projectId,
      kind: 'label',
      status: settle(rule, outcome),
      key: `${norm(rule.pattern)}|`,
      payload: { ...payload },
      source: SOURCE(rule),
      author: 'migration',
      legacyRuleId: rule.id,
      validation: outcome.validation,
    });
  }

  for (const rule of rules.filter((r) => r.kind === 'approved')) {
    const payload: ApprovalPayload = { assumption: rule.pattern, ...approvalParts(rule.pattern) };
    const outcome = validateApproval(payload, readings.get(rule.projectId) ?? []);
    out.push({
      projectId: rule.projectId,
      kind: 'approval',
      status: settle(rule, outcome),
      key: ruleKey(rule.pattern),
      payload: { ...payload },
      source: SOURCE(rule),
      author: 'migration',
      legacyRuleId: rule.id,
      validation: outcome.validation,
    });
  }
  return out;
}

export interface MigrationSummary {
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, Record<string, number>>;
  /** Everything that is not active, with the reason. */
  notActive: Array<{ legacyRuleId?: string; projectId: string; kind: string; status: string; key: string; reason: string }>;
}

export function summarize(plan: readonly PlannedEntry[]): MigrationSummary {
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, Record<string, number>> = {};
  const notActive: MigrationSummary['notActive'] = [];
  for (const e of plan) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    byKind[e.kind] = { ...byKind[e.kind], [e.status]: (byKind[e.kind]?.[e.status] ?? 0) + 1 };
    if (e.status !== 'active')
      notActive.push({
        ...(e.legacyRuleId ? { legacyRuleId: e.legacyRuleId } : {}),
        projectId: e.projectId,
        kind: e.kind,
        status: e.status,
        key: e.key,
        reason: e.validation.problem ?? 'switched off in the project rules',
      });
  }
  return { total: plan.length, byStatus, byKind, notActive };
}
