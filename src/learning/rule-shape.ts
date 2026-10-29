import type { ProjectRule } from '../parser/rules.js';
import type { ApprovalPayload, LabelPayload, LearnedEntry, ReadingPayload } from './entries.js';

/**
 * The learned entries in the shape the rules screen and its API have always had (kind step, check, element or approved), so the
 * screen keeps working while there is one store behind it. `enabled` means the entry is active: the only status that changes a run.
 * `status` and `problem` are added so the screen can say why an entry is not.
 */

export type RuleView = ProjectRule & { status: LearnedEntry['status']; problem?: string };

export function toRuleView(e: LearnedEntry): RuleView | undefined {
  const base = {
    id: e.id,
    projectId: e.projectId,
    source: e.source,
    enabled: e.status === 'active',
    createdAt: e.createdAt,
    status: e.status,
    ...(e.validation.problem ? { problem: e.validation.problem } : {}),
  };
  if (e.kind === 'reading') {
    const p = e.payload as unknown as ReadingPayload;
    return { ...base, kind: p.readingKind, pattern: p.from, meaning: p.to };
  }
  if (e.kind === 'label') {
    const p = e.payload as unknown as LabelPayload;
    return { ...base, kind: 'element', pattern: p.label, meaning: p.means };
  }
  if (e.kind === 'approval') {
    const p = e.payload as unknown as ApprovalPayload;
    return { ...base, kind: 'approved', pattern: p.assumption, meaning: '' };
  }
  return undefined;
}
