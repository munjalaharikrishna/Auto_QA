import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildLedger, type RecordKind } from '../context/ledger.js';
import type { RunTrace } from '../execute/executor.js';
import type { QaIr } from '../ir/schema.js';
import type { ResolvedValue } from './resolver.js';
import { isSecret } from './secret.js';

/**
 * The clean-up list of a run (E0.16 item 4, audit P3). Every record a case saves is written down with the values it was saved
 * with, so a person can find it in the application and remove it. Auto QA deletes nothing by itself (owner, PD-15, 5 Nov 2026):
 * there is no delete flow and no nightly sweep. The values a run makes up are seeded by the run (`seed`), so each run creates
 * records with names of their own, and the same seed makes the same names again.
 *
 * A record is listed when the run reached its Save (`saved`), or when the run stopped on the Save itself (`maybe`: the application
 * may have kept it). A record whose Save was never reached is not created and not listed. Secrets are never written: their value is
 * `***`.
 */

export type CleanupStatus = 'saved' | 'maybe';

export interface CleanupRecord {
  testId: string;
  /** The ledger record, `D1`, `D2`, … in the order the case saves them. */
  record: string;
  /** What kind of thing it is ("Employee"), when a page names it. */
  entity?: string;
  /** `created` or `saved`: a new record. `updated`: a change to one, listed so a person knows the run touched it. */
  kind: RecordKind;
  page?: string;
  /** The step that saved it, and the tester's words for it. */
  savedBy: string;
  status: CleanupStatus;
  /** What the record was saved with, field by field: what a person searches for to find it. */
  values: Array<{ field: string; value: string; step: string }>;
  /** The step that probably emptied the form before the Save (Reset): the record may have been saved empty. */
  wipedBy?: string;
}

export interface CleanupList {
  executionId: string;
  /** The seed the run's made-up values come from. */
  seed: string;
  createdAt: string;
  /** Always `false` in V1: the list is for a person, nothing is deleted by Auto QA. */
  deletes: false;
  records: CleanupRecord[];
}

/** The value of a ledger value, as typed: a made-up or given value as text, a secret as `***`, a file by its name. */
function textOf(value: string, values: Record<string, ResolvedValue> | undefined): string {
  if (!value.startsWith('$data.')) return value;
  const resolved = values?.[value.slice('$data.'.length)];
  if (!resolved) return value;
  return isSecret(resolved.value) ? '***' : String(resolved.value);
}

/** What one case of a run created: the records whose Save the run reached. */
export function createdBy(ir: QaIr, values: Record<string, ResolvedValue> | undefined, trace: Pick<RunTrace, 'steps'>): CleanupRecord[] {
  const ledger = buildLedger(ir.steps, ir.expectations);
  const out: CleanupRecord[] = [];
  for (const r of ledger.records) {
    const save = trace.steps.find((s) => s.step === r.savedBy);
    if (!save || save.status === 'skipped' || save.status === 'blocked') continue;
    out.push({
      testId: ir.testCase.id,
      record: r.id,
      ...(r.entity ? { entity: r.entity } : {}),
      kind: r.kind,
      ...(r.page ? { page: r.page } : {}),
      savedBy: r.savedBy,
      status: save.status === 'done' ? 'saved' : 'maybe',
      values: r.values.map((v) => ({ field: v.field.name ?? v.field.label ?? v.field.ontology, value: textOf(v.value, values), step: v.step })),
      ...(r.wipedBy ? { wipedBy: r.wipedBy } : {}),
    });
  }
  return out;
}

/** The list as a person reads it. */
export function cleanupText(list: CleanupList): string {
  const lines = [
    `Clean-up list of run ${list.executionId} (seed ${list.seed}), ${list.createdAt}`,
    'Auto QA deleted nothing. Remove these records by hand when they are no longer needed.',
    '',
  ];
  if (!list.records.length) lines.push('This run created no records.');
  for (const r of list.records) {
    const thing = r.entity ? r.entity.toLowerCase() : 'record';
    const what = `${r.testId} ${r.record}: ${r.kind === 'updated' ? 'changed' : 'created'} ${/^[aeiou]/.test(thing) ? 'an' : 'a'} ${thing}`;
    const where = r.page ? ` on "${r.page}"` : '';
    const maybe = r.status === 'maybe' ? ' (the Save did not finish: it may not have been kept)' : '';
    const wiped = r.wipedBy ? ` (${r.wipedBy} probably emptied the form before the Save)` : '';
    lines.push(`- ${what}${where}, saved by ${r.savedBy}${maybe}${wiped}`);
    for (const v of r.values) lines.push(`    ${v.field}: ${v.value}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes `cleanup.json` and `cleanup.txt` into the run's folder; returns the path of the JSON. */
export async function writeCleanupList(dir: string, list: CleanupList): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'cleanup.json');
  await writeFile(file, `${JSON.stringify(list, null, 2)}\n`);
  await writeFile(path.join(dir, 'cleanup.txt'), cleanupText(list));
  return file;
}
