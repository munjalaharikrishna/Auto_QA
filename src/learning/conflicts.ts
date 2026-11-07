import { ruleKey } from '../parser/rules.js';
import type { LabelPayload, ReadingPayload } from './entries.js';
import { norm } from './validate.js';

/**
 * E0.18 step 6, the conflict check of learned entries. An entry is refused when it would not mean one thing on its own:
 *  - a reading whose new sentence another active reading rewrites again (a chain: which of the two is meant?), or whose sentence is
 *    what another reading produces (it would rewrite that reading's result), or the two read each other back (a cycle);
 *  - a label "A means B" where B is itself a word that means something else in the same place (a chain), or where "B means A" is
 *    active there (a cycle).
 * The same sentence or word saved again is not a conflict: it replaces the entry, and the old one stays in its history.
 */

export function readingConflict(p: Pick<ReadingPayload, 'from' | 'to'>, active: ReadonlyArray<Pick<ReadingPayload, 'from' | 'to'>>): string | undefined {
  const from = ruleKey(p.from);
  const to = ruleKey(p.to);
  for (const a of active) {
    const aFrom = ruleKey(a.from);
    const aTo = ruleKey(a.to);
    if (aFrom === from) continue;
    if (aFrom === to && aTo === from) return `"${p.from}" and "${a.from}" would be read as each other: two readings may not undo each other`;
    if (aFrom === to) return `"${p.to}" is itself read as "${a.to}" by another reading: say "${a.to}" directly, or change that reading first`;
    if (aTo === from) return `"${p.from}" is what the reading of "${a.from}" produces: this would rewrite that reading's result`;
  }
  return undefined;
}

const scopeOf = (p: Pick<LabelPayload, 'screen' | 'page'>): string => (p.screen ? `screen:${p.screen}` : norm(p.page ?? ''));

export function labelConflict(p: LabelPayload, active: readonly LabelPayload[]): string | undefined {
  const label = norm(p.label);
  const means = norm(p.means);
  for (const a of active) {
    if (scopeOf(a) !== scopeOf(p) || norm(a.label) === label) continue;
    const aLabel = norm(a.label);
    const aMeans = norm(a.means);
    if (aLabel === means && aMeans === label) return `"${p.label}" means "${p.means}" and "${a.label}" means "${a.means}": two words may not mean each other`;
    if (aLabel === means && aMeans !== means)
      return `"${p.means}" is itself a word that means "${a.means}" here: say which element is meant, "${a.means}" or "${p.means}"`;
  }
  return undefined;
}
