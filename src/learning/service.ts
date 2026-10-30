import path from 'node:path';
import type { Project, Store } from '../db/store.js';
import { knowledgeFromRuns } from '../engine/knowledge/from-runs.js';
import { workspaceName } from '../generator/index.js';
import { ruleKey } from '../parser/rules.js';
import type { ApprovalPayload, LabelPayload, LearnedEntry, ReadingPayload } from './entries.js';
import { type MigrationContext, type MigrationSummary, type PlannedEntry, planRuleMigration, summarize } from './plan.js';
import { approvalParts, norm, type Outcome, validateApproval, validateLabel, validateReading } from './validate.js';

/**
 * Every way an entry is made or changed goes through here, so the checks are made in one place and a caller cannot set a status
 * the content does not earn. A tester's answer that fails its checks is refused with the reason. An entry that was switched on by
 * hand in the database is checked again when a run reads it (`adapter.ts`).
 */

export class EntryRefused extends Error {}

/** The names the application was seen to show, from the explorations of earlier runs (only the same application). */
export async function knownNamesFor(project: Pick<Project, 'id' | 'baseUrl'>, exploreDir: string): Promise<ReadonlySet<string> | undefined> {
  const app = await knowledgeFromRuns(workspaceName(project.baseUrl), project.baseUrl, exploreDir);
  if (!app) return undefined;
  const names = new Set<string>();
  for (const page of app.pages) for (const c of page.components) for (const n of [c.name, ...c.aliases]) names.add(norm(n));
  return names;
}

export class LearningService {
  constructor(
    private readonly store: Store,
    private readonly options: { exploreDir?: string } = {},
  ) {}

  private get exploreDir(): string {
    return this.options.exploreDir ?? path.join('.auto-qa', 'explore');
  }

  private async activeReadings(projectId: string): Promise<Array<{ from: string; to: string }>> {
    return (await this.store.learnedEntries(projectId, { kind: 'reading', status: 'active' })).map((e) => {
      const p = e.payload as unknown as ReadingPayload;
      return { from: p.from, to: p.to };
    });
  }

  /** A word a tester wrote for an element, picked on the screen: the tester chose it on the page, so the name is known to be there. */
  async saveLabel(projectId: string, payload: LabelPayload, source: string, actor: string, options: { seenOnScreen?: boolean } = {}): Promise<LearnedEntry> {
    const project = await this.store.project(projectId);
    const known = options.seenOnScreen ? new Set([norm(payload.means)]) : project ? await knownNamesFor(project, this.exploreDir) : undefined;
    const given = { ...payload, label: ruleKey(payload.label) };
    const outcome = validateLabel(given, known);
    if (outcome.status === 'quarantined') throw new EntryRefused(outcome.validation.problem);
    // A word given on one screen (E0.14b) is its own entry: the same word may mean another element on another screen.
    const where = given.screen ? `screen:${given.screen}` : norm(given.page ?? '');
    return this.keep(projectId, 'label', `${norm(given.label)}|${where}`, given, outcome, source, actor);
  }

  /** A sentence read as another one. Refused when it does not read as a real step or a check that judges something. */
  async saveReading(projectId: string, payload: ReadingPayload, source: string, actor: string): Promise<LearnedEntry> {
    const given = { ...payload, from: ruleKey(payload.from) };
    const outcome = validateReading(given);
    if (outcome.status === 'quarantined') throw new EntryRefused(outcome.validation.problem);
    return this.keep(projectId, 'reading', `${given.readingKind}|${given.from}`, given, outcome, source, actor);
  }

  /** A person accepted an assumption. An acceptance only: it is never evidence that a test passed. */
  async approve(projectId: string, assumption: string, source: string, actor: string): Promise<LearnedEntry> {
    const payload: ApprovalPayload = { assumption, ...approvalParts(assumption) };
    const outcome = validateApproval(payload, await this.activeReadings(projectId));
    if (outcome.status === 'quarantined') throw new EntryRefused(outcome.validation.problem);
    return this.keep(projectId, 'approval', ruleKey(assumption), { ...payload }, outcome, source, actor);
  }

  private keep(
    projectId: string,
    kind: LearnedEntry['kind'],
    key: string,
    payload: Record<string, unknown>,
    outcome: Outcome,
    source: string,
    actor: string,
  ): Promise<LearnedEntry> {
    return this.store.saveLearnedEntry(projectId, { kind, status: outcome.status, key, payload, source, author: actor, validation: outcome.validation }, actor);
  }

  /** The checks of an entry, made again from its content now. */
  private async recheck(e: LearnedEntry): Promise<Outcome> {
    if (e.kind === 'reading') return validateReading(e.payload as unknown as ReadingPayload);
    if (e.kind === 'approval') return validateApproval(e.payload as unknown as ApprovalPayload, await this.activeReadings(e.projectId));
    if (e.kind === 'label') {
      const project = await this.store.project(e.projectId);
      return validateLabel(e.payload as unknown as LabelPayload, project ? await knownNamesFor(project, this.exploreDir) : undefined);
    }
    return {
      status: 'quarantined',
      validation: { ok: false, checks: [], problem: `Entries of kind "${e.kind}" are not switched on by hand.`, validator: 'learning-service/1' },
    };
  }

  /**
   * Switches an entry on. It is checked again first: a quarantined entry cannot be switched on until it passes, and a `pending` one
   * (a name nobody has seen) can be, by a person who says so, because the structure is sound and the person vouches for the name.
   */
  async activate(projectId: string, id: string, actor: string, reason: string): Promise<LearnedEntry> {
    const entry = await this.store.learnedEntry(projectId, id);
    if (!entry) throw new EntryRefused('There is no such entry.');
    const outcome = await this.recheck(entry);
    if (outcome.status === 'quarantined') throw new EntryRefused(`It cannot be switched on: ${outcome.validation.problem}`);
    if (!reason.trim()) throw new EntryRefused('Say why it is switched on.');
    return (await this.store.setLearnedStatus(projectId, id, 'active', actor, reason)) as LearnedEntry;
  }

  async disable(projectId: string, id: string, actor: string, reason: string): Promise<LearnedEntry> {
    const entry = await this.store.setLearnedStatus(projectId, id, 'disabled', actor, reason || 'switched off');
    if (!entry) throw new EntryRefused('There is no such entry.');
    return entry;
  }

  /** Takes an entry out of the list. Its row and history stay; no run reads it. */
  async remove(projectId: string, id: string, actor: string, reason: string): Promise<LearnedEntry> {
    const entry = await this.store.setLearnedStatus(projectId, id, 'removed', actor, reason || 'removed');
    if (!entry) throw new EntryRefused('There is no such entry.');
    return entry;
  }

  // ---- the migration of the project rules (migration 0005) ----

  async context(projectIds: readonly string[]): Promise<MigrationContext> {
    const known = new Map<string, ReadonlySet<string> | undefined>();
    for (const id of projectIds) {
      const project = await this.store.project(id);
      known.set(id, project ? await knownNamesFor(project, this.exploreDir) : undefined);
    }
    return { knownNames: (projectId) => known.get(projectId) };
  }

  /** What the migration would do, with nothing written. */
  async planMigration(projectIds?: readonly string[]): Promise<{ plan: PlannedEntry[]; summary: MigrationSummary }> {
    const ids = projectIds ?? (await this.store.projects()).map((p) => p.id);
    const rules = (await Promise.all(ids.map((id) => this.store.rules(id)))).flat();
    const plan = planRuleMigration(rules, await this.context(ids));
    return { plan, summary: summarize(plan) };
  }

  /**
   * Writes the plan. Idempotent: an entry that exists already (the same rule, or the same thing) is left as it is, so a person's
   * later change is never undone by running it again. The project rules themselves are not changed.
   */
  async applyMigration(projectIds?: readonly string[]): Promise<{ written: number; skipped: number; summary: MigrationSummary }> {
    const { plan, summary } = await this.planMigration(projectIds);
    let written = 0;
    let skipped = 0;
    for (const entry of plan) {
      const existing = await this.store.learnedEntries(entry.projectId, { kind: entry.kind });
      if (existing.some((e) => e.key === entry.key || (entry.legacyRuleId && e.legacyRuleId === entry.legacyRuleId))) {
        skipped++;
        continue;
      }
      const { projectId, ...input } = entry;
      await this.store.saveLearnedEntry(projectId, input, 'migration', 'migrate');
      written++;
    }
    return { written, skipped, summary };
  }

  /**
   * Switches off every entry the migration made and nobody has changed since. The project rules are untouched, so the data is back
   * as it was; nothing a person decided afterwards is lost.
   */
  async rollbackMigration(projectIds?: readonly string[]): Promise<{ disabled: number; kept: number }> {
    const ids = projectIds ?? (await this.store.projects()).map((p) => p.id);
    let disabled = 0;
    let kept = 0;
    for (const projectId of ids) {
      for (const e of await this.store.learnedEntries(projectId)) {
        if (!e.legacyRuleId || e.author !== 'migration') continue;
        const history = await this.store.learnedHistory(e.id);
        const touchedByAPerson = history.some((h) => h.actor !== 'migration');
        // Only what is switched on, or waiting, is switched off: a quarantined entry keeps its reason, and a removed one stays removed.
        if (touchedByAPerson || (e.status !== 'active' && e.status !== 'pending')) {
          kept++;
          continue;
        }
        await this.store.setLearnedStatus(projectId, e.id, 'disabled', 'migration', 'rollback of the project rule migration');
        disabled++;
      }
    }
    return { disabled, kept };
  }
}
