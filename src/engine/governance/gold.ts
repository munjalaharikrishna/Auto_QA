import { z } from 'zod';
import { CONDITION_TYPES, DATA_CLASSES, IR_ACTIONS, type QaIr } from '../ir/schema.js';
import type { CaseLanguage } from '../language/case.js';
import type { Issue } from '../language/types.js';

/**
 * The gold interpretation set: what a person says each written step and expected result MEANS, worked out from the tester's
 * words and the page, never from the engine's output. It measures understanding on its own, before any browser run, so a
 * misreading cannot hide inside a PASS or FAIL. Like the answer key (GV-06), a set nobody checked is not gold: `review` must
 * name who checked it, and the scorer refuses an unreviewed set unless asked for a draft run.
 *
 * Two people label each case on their own (`labels`), the set reports how often they agree (Cohen's kappa), and the
 * disagreements are settled into `gold`. A clause the two cannot settle is `abstain`: the right answer for the engine is to
 * set it aside for a person, and answering anything is counted as a confident mistake.
 */

const Words = z.string().trim().min(1);

export const GoldStepSchema = z.object({
  /** The tester's words, as written in the cell. The engine's clauses are matched to this text (NM-19). One written step that holds several actions is listed once per action, in order. */
  original: Words,
  /** Set when a person cannot say what the step means: the engine should abstain, not choose. */
  abstain: z.boolean().optional(),
  /** Why a person labelled it the way they did, above all why they could not: the reason a clause is `abstain`. */
  why: z.string().optional(),
  action: z.enum(IR_ACTIONS).optional(),
  /** The element the step acts on, by the name a person would call it: `Username`, `Login`. */
  target: z.string().optional(),
  /** The kind of value (and the value itself when it is written in the case). */
  value: z.object({ class: z.enum(DATA_CLASSES), value: z.string().optional() }).optional(),
});
export type GoldStep = z.infer<typeof GoldStepSchema>;

export const GoldExpectationSchema = z.object({
  original: Words,
  abstain: z.boolean().optional(),
  why: z.string().optional(),
  type: z.enum(CONDITION_TYPES).optional(),
  negated: z.boolean().optional(),
  /** What the check looks at: `Dashboard heading`, `Login page`. */
  target: z.string().optional(),
  /** What a message must say, in the tester's words. */
  text: z.string().optional(),
});
export type GoldExpectation = z.infer<typeof GoldExpectationSchema>;

export const GoldInterpretationSchema = z.object({
  steps: z.array(GoldStepSchema),
  expectations: z.array(GoldExpectationSchema),
});
export type GoldInterpretation = z.infer<typeof GoldInterpretationSchema>;

export const GoldCaseSchema = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    source: z.object({ file: z.string().min(1), sheet: z.string().optional(), row: z.number().int().positive().optional() }),
    /** Each person's own reading, before they compared. Needed for the agreement figure; absent for a single-labelled case. */
    labels: z.record(z.string(), GoldInterpretationSchema).optional(),
    /** How `gold` came about: one person, two who agreed, two who disagreed and settled it, or still open. */
    status: z.enum(['single', 'agreed', 'reconciled', 'disputed']),
    gold: GoldInterpretationSchema,
    /** A known tricky wording kept so the misreading it once caused cannot come back (the same idea as a trap in the answer key). */
    trap: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.status === 'single' && c.labels && Object.keys(c.labels).length > 1) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'two labelled readings are not a single one' });
    }
    if ((c.status === 'agreed' || c.status === 'reconciled') && (!c.labels || Object.keys(c.labels).length < 2)) {
      ctx.addIssue({ code: 'custom', path: ['labels'], message: `a ${c.status} case needs the readings of two people` });
    }
    for (const [i, s] of c.gold.steps.entries()) {
      if (!s.abstain && !s.action)
        ctx.addIssue({ code: 'custom', path: ['gold', 'steps', i, 'action'], message: 'a step is labelled with an action, or marked abstain' });
    }
    for (const [i, e] of c.gold.expectations.entries()) {
      if (!e.abstain && !e.type)
        ctx.addIssue({ code: 'custom', path: ['gold', 'expectations', i, 'type'], message: 'an expectation is labelled with a type, or marked abstain' });
    }
  });
export type GoldCase = z.infer<typeof GoldCaseSchema>;

export const GoldSetSchema = z
  .object({
    version: z.string().min(1),
    /** Who checked the set, and when. Null while it is a draft. */
    review: z.object({ checkedBy: z.string().min(1), checkedOn: z.string().min(1) }).nullable(),
    cases: z.array(GoldCaseSchema).min(1),
  })
  .superRefine((g, ctx) => {
    const seen = new Set<string>();
    for (const [i, c] of g.cases.entries()) {
      const id = `${c.module}/${c.id}`;
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'id'], message: `${id} is in the set twice` });
      seen.add(id);
    }
  });
export type GoldSet = z.infer<typeof GoldSetSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Scoring: the engine's QA-IR against the gold, clause by clause.
// ---------------------------------------------------------------------------------------------------------------------

const isAlnum = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
/** Lower case, every run of other characters one space, trimmed. */
const norm = (s: string | undefined): string =>
  [...(s ?? '').toLowerCase()]
    .map((c) => (isAlnum(c) ? c : ' '))
    .join('')
    .split(' ')
    .filter(Boolean)
    .join(' ');

/** How one clause came out. `wrong` is the dangerous one: the engine was sure and mistaken. `abstained` is the engine saying it did not know. */
export type ClauseOutcome = 'correct' | 'rightly-abstained' | 'wrong' | 'missed' | 'abstained' | 'should-abstain-but-answered';

export interface ClauseScore {
  caseId: string;
  module: string;
  kind: 'step' | 'expectation';
  original: string;
  /** The person's reason, when they gave one. */
  why?: string;
  outcome: ClauseOutcome;
  /** For a wrong clause: the fields that differ, as `action: expected CLICK, got SUBMIT`. */
  differences: string[];
}

export interface Tally {
  gold: number;
  correct: number;
  wrong: number;
  missed: number;
  abstained: number;
  /** Clauses the engine produced that are not in the gold at all (the engine's own guard rails are not counted). */
  spurious: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface GoldReport {
  clauses: ClauseScore[];
  steps: Tally;
  expectations: Tally;
  /** The share of wrong and should-abstain-but-answered clauses among all the engine answered: the confident-mistake rate. Target 0 for a PASS-relevant clause. */
  confidentMistakes: number;
  notRun: string[];
  reviewed: boolean;
}

const ratio = (a: number, b: number): number => (b === 0 ? 1 : a / b);

function tally(scores: readonly ClauseScore[], spurious: number): Tally {
  const count = (o: ClauseOutcome): number => scores.filter((s) => s.outcome === o).length;
  const correct = count('correct') + count('rightly-abstained');
  const wrong = count('wrong') + count('should-abstain-but-answered');
  const precision = ratio(correct, correct + wrong + spurious);
  const recall = ratio(correct, scores.length);
  return {
    gold: scores.length,
    correct,
    wrong,
    missed: count('missed'),
    abstained: count('abstained'),
    spurious,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

/** What the engine made of one sentence, in the form the scorer compares. */
export interface Reading {
  kind: 'step' | 'expectation';
  original: string;
  /** The engine did not answer: it set the sentence aside with an issue for a person. */
  abstained: boolean;
  action?: string;
  type?: string;
  negated?: boolean;
  /** The names the engine gave the target, as it holds them. */
  targets?: string[];
  valueClass?: string;
  text?: string;
  /** A guard rail the engine adds on every test: not a clause of the tester's, so never counted as extra. */
  automatic?: boolean;
}

/**
 * Everything the engine read of one case. `detailed` is true when it comes from the compiled QA-IR (it names targets, values
 * and messages). A blocked case has no IR: only what the language layer recorded per sentence is known (the action or kind, or
 * that it set the sentence aside), so the finer fields are not compared there.
 */
export interface CaseReading {
  steps: Reading[];
  expectations: Reading[];
  detailed: boolean;
}

/** An issue of these kinds means the engine set the sentence aside for a person (a missing value included: it asked for one). */
const NOT_UNDERSTOOD_CODES = new Set<Issue['code']>([
  'NOT_UNDERSTOOD',
  'UNSUPPORTED',
  'AMBIGUOUS',
  'PARADOX',
  'UNKNOWN_BRANCH',
  'NEEDS_REFERENCE',
  'MISSING_DATA',
]);

/** The engine keeps the tester's noun phrase ("valid username"); the gold names the element ("Username"). The same element when the phrase equals the name or ends with it. */
const sameName = (engine: readonly string[], gold: string): boolean =>
  engine.some((n) => n === norm(gold) || n.endsWith(` ${norm(gold)}`) || n.split(' ').join('') === norm(gold).split(' ').join(''));

const nameOf = (t: { name?: string | undefined; label?: string | undefined; component?: string | undefined } | undefined): string[] =>
  t ? [t.name, t.label, t.component].filter((x): x is string => !!x).map(norm) : [];

export function readingOfIr(ir: QaIr): CaseReading {
  const valueClassOf = (v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    const d = v.startsWith('$data.') ? ir.data[v.slice('$data.'.length)] : undefined;
    // "valid username" becomes a lookup of a credential from the environment: a person calls that a CREDENTIAL, whatever the word.
    if (d?.class === 'REFERENCE' && d.value?.startsWith('$env.')) return 'CREDENTIAL';
    return d?.intent ?? d?.class ?? 'EXPLICIT';
  };
  return {
    detailed: true,
    steps: ir.steps.map((s) => {
      const valueClass = valueClassOf(s.value);
      return { kind: 'step', original: s.original, abstained: false, action: s.action, targets: nameOf(s.target), ...(valueClass ? { valueClass } : {}) };
    }),
    expectations: ir.expectations.map((e) => {
      const text = e.condition.text ?? e.condition.expect;
      return {
        kind: 'expectation',
        original: e.clause,
        abstained: false,
        type: e.condition.type,
        negated: e.negated,
        targets: nameOf(e.condition.target),
        ...(text ? { text } : {}),
        ...(e.automatic ? { automatic: true } : {}),
      };
    }),
  };
}

/** The engine's reading of a case from its language layer: the IR when there is one, else what the layer recorded per sentence. */
export function readingOfLanguage(lang: CaseLanguage): CaseReading {
  const asked = (original: string): boolean =>
    lang.issues.some((i) => i.severity !== 'info' && NOT_UNDERSTOOD_CODES.has(i.code) && bare(i.original) === bare(original));
  const reading: CaseReading = lang.ir
    ? readingOfIr(lang.ir)
    : {
        detailed: false,
        steps: lang.units
          .filter((u) => u.kind === 'step')
          .map((u) => ({ kind: 'step', original: u.original, abstained: !u.understood, ...(u.categories[0] ? { action: u.categories[0] } : {}) })),
        expectations: lang.units
          .filter((u) => u.kind === 'expectation')
          .map((u) => ({ kind: 'expectation', original: u.original, abstained: !u.understood, ...(u.categories[0] ? { type: u.categories[0] } : {}) })),
      };
  // A "Verify …" line the engine could not place as a step is the tester's expected result: score it as one.
  const stray = reading.steps.filter((r) => r.original.toLowerCase().startsWith('verify ') && !('action' in r));
  reading.steps = reading.steps.filter((r) => !stray.includes(r));
  reading.expectations.push(...stray.map((r): Reading => ({ ...r, kind: 'expectation' })));
  // A sentence the engine raised a question about is one it set aside, even when it also drew a step from it.
  for (const r of [...reading.steps, ...reading.expectations]) if (asked(r.original)) r.abstained = true;
  return reading;
}

/** The engine writes a step's own expected result as "Verify …" (stepsWithChecks); the tester wrote it without. */
const bare = (s: string): string => (norm(s).startsWith('verify ') ? norm(s).slice('verify '.length) : norm(s));

/** Takes the first reading of the engine with the same words that no gold clause has taken yet. */
function take(pool: Reading[], taken: Set<Reading>, words: string): Reading | undefined {
  const w = bare(words);
  const found = pool.find((c) => !taken.has(c) && bare(c.original) === w);
  if (found) taken.add(found);
  return found;
}

export function scoreCase(c: GoldCase, reading: CaseReading | undefined): { clauses: ClauseScore[]; spuriousSteps: number; spuriousExpectations: number } {
  const clauses: ClauseScore[] = [];
  const base = { caseId: c.id, module: c.module };
  const steps = reading?.steps ?? [];
  const exps = reading?.expectations ?? [];
  const takenS = new Set<Reading>();
  const takenE = new Set<Reading>();
  const detailed = reading?.detailed ?? false;

  const one = (kind: 'step' | 'expectation', g: GoldStep | GoldExpectation, got: Reading | undefined): ClauseScore => {
    const meta = { ...base, kind, original: g.original, ...(g.why ? { why: g.why } : {}) };
    const answered = !!got && !got.abstained;
    if (g.abstain) {
      return {
        ...meta,
        outcome: answered ? 'should-abstain-but-answered' : 'rightly-abstained',
        differences: answered ? [`engine answered ${got?.action ?? got?.type}`] : [],
      };
    }
    if (!got) return { ...meta, outcome: reading ? 'abstained' : 'missed', differences: [] };
    if (got.abstained) return { ...meta, outcome: 'abstained', differences: [] };
    const diff: string[] = [];
    if (kind === 'step') {
      const s = g as GoldStep;
      if (got.action !== s.action) diff.push(`action: expected ${s.action}, got ${got.action}`);
      if (detailed && s.target !== undefined && !sameName(got.targets ?? [], s.target))
        diff.push(`target: expected ${s.target}, got ${(got.targets ?? []).join('/') || 'none'}`);
      if (detailed && s.value && got.valueClass !== s.value.class) diff.push(`value class: expected ${s.value.class}, got ${got.valueClass ?? 'none'}`);
    } else {
      const e = g as GoldExpectation;
      if (got.type !== e.type) diff.push(`type: expected ${e.type}, got ${got.type}`);
      if (detailed && e.negated !== undefined && got.negated !== e.negated) diff.push(`negated: expected ${e.negated}, got ${got.negated}`);
      if (detailed && e.target !== undefined && !sameName(got.targets ?? [], e.target))
        diff.push(`target: expected ${e.target}, got ${(got.targets ?? []).join('/') || 'none'}`);
      if (detailed && e.text !== undefined && norm(got.text) !== norm(e.text)) diff.push(`text: expected "${e.text}", got "${got.text ?? ''}"`);
    }
    return { ...meta, outcome: diff.length ? 'wrong' : 'correct', differences: diff };
  };

  for (const g of c.gold.steps) clauses.push(one('step', g, take(steps, takenS, g.original)));
  for (const g of c.gold.expectations) clauses.push(one('expectation', g, take(exps, takenE, g.original)));
  return {
    clauses,
    spuriousSteps: steps.filter((s) => !takenS.has(s) && !s.abstained).length,
    spuriousExpectations: exps.filter((e) => !takenE.has(e) && !e.automatic && !e.abstained).length,
  };
}

/**
 * Scores every case of the set. `readings` holds what the engine read, by `module/id`; a case with no entry was not run, and is
 * listed, not ignored. A sentence the engine set aside with a question counts as abstained: right when the person could not say
 * either, a loss of recall when they could. A case with no reading at all (it could not be read) is missed.
 */
export function scoreGold(set: GoldSet, readings: ReadonlyMap<string, CaseReading | undefined>, options: { allowDraft?: boolean } = {}): GoldReport {
  if (!set.review && !options.allowDraft) throw new Error('the gold set has not been checked by anyone (review is null): a set nobody checked is not gold');
  const clauses: ClauseScore[] = [];
  const notRun: string[] = [];
  let spuriousSteps = 0;
  let spuriousExpectations = 0;
  for (const c of set.cases) {
    const key = `${c.module}/${c.id}`;
    if (!readings.has(key)) {
      notRun.push(key);
      continue;
    }
    const r = scoreCase(c, readings.get(key));
    clauses.push(...r.clauses);
    spuriousSteps += r.spuriousSteps;
    spuriousExpectations += r.spuriousExpectations;
  }
  const answered = clauses.filter((s) => !['missed', 'abstained', 'rightly-abstained'].includes(s.outcome));
  const mistaken = clauses.filter((s) => s.outcome === 'wrong' || s.outcome === 'should-abstain-but-answered');
  return {
    clauses,
    steps: tally(
      clauses.filter((s) => s.kind === 'step'),
      spuriousSteps,
    ),
    expectations: tally(
      clauses.filter((s) => s.kind === 'expectation'),
      spuriousExpectations,
    ),
    confidentMistakes: mistaken.length / Math.max(answered.length, 1),
    notRun,
    reviewed: !!set.review,
  };
}

export function goldText(r: GoldReport): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const line = (n: string, t: Tally): string =>
    `  ${n}: ${t.correct} of ${t.gold} right, ${t.wrong} wrong, ${t.abstained} set aside that a person could read, ${t.missed} missed, ${t.spurious} extra (precision ${pct(t.precision)}, recall ${pct(t.recall)}, F1 ${pct(t.f1)})`;
  const lines = [
    `Gold set${r.reviewed ? '' : ' (DRAFT: nobody has checked it yet)'}: ${r.clauses.length} clauses, confident-mistake rate ${pct(r.confidentMistakes)} (target 0%)`,
    line('steps', r.steps),
    line('expectations', r.expectations),
  ];
  for (const s of r.clauses.filter((x) => x.outcome === 'abstained'))
    lines.push(`  set aside, though a person could read it: ${s.module}/${s.caseId} "${s.original}"`);
  for (const s of r.clauses.filter((x) => x.outcome === 'rightly-abstained'))
    lines.push(`  asked, as it should: ${s.module}/${s.caseId} "${s.original}" (${s.why})`);
  for (const s of r.clauses.filter((x) => x.outcome === 'wrong' || x.outcome === 'should-abstain-but-answered')) {
    lines.push(
      `  ${s.outcome === 'wrong' ? 'WRONG' : 'SHOULD HAVE ASKED'} ${s.module}/${s.caseId} "${s.original}": ${s.differences.join('; ')}${s.why ? ` (the person said: ${s.why})` : ''}`,
    );
  }
  if (r.notRun.length) lines.push(`  not run: ${r.notRun.join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Agreement between the two people who labelled: where the language is truly ambiguous, they disagree.
// ---------------------------------------------------------------------------------------------------------------------

/** Cohen's kappa for two raters over the same items: 1 is perfect agreement, 0 is no better than chance. */
export function cohenKappa(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length) throw new Error('both raters must label the same items');
  if (a.length === 0) return 1;
  const n = a.length;
  const observed = a.filter((x, i) => x === b[i]).length / n;
  const labels = new Set([...a, ...b]);
  let chance = 0;
  for (const l of labels) chance += (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n);
  return chance === 1 ? 1 : (observed - chance) / (1 - chance);
}

export interface Agreement {
  /** Clauses both people labelled, and the disagreements to settle. */
  items: number;
  kappa: { action: number; expectationType: number };
  disagreements: Array<{ caseId: string; original: string; a: string; b: string }>;
}

/** Compares the first two people's labels of each case, clause by clause (matched by position and words). */
export function labelAgreement(set: GoldSet): Agreement {
  const act: [string[], string[]] = [[], []];
  const typ: [string[], string[]] = [[], []];
  const disagreements: Agreement['disagreements'] = [];
  const label = (x: { abstain?: boolean | undefined }, v: string | undefined): string => (x.abstain ? 'ABSTAIN' : (v ?? 'NONE'));
  for (const c of set.cases) {
    const people = Object.values(c.labels ?? {});
    const [p, q] = people;
    if (!p || !q) continue;
    for (const [i, s] of p.steps.entries()) {
      const t = q.steps[i];
      if (!t || norm(t.original) !== norm(s.original)) continue;
      const [x, y] = [label(s, s.action), label(t, t.action)];
      act[0].push(x);
      act[1].push(y);
      if (x !== y) disagreements.push({ caseId: c.id, original: s.original, a: x, b: y });
    }
    for (const [i, e] of p.expectations.entries()) {
      const t = q.expectations[i];
      if (!t || norm(t.original) !== norm(e.original)) continue;
      const [x, y] = [label(e, e.type), label(t, t.type)];
      typ[0].push(x);
      typ[1].push(y);
      if (x !== y) disagreements.push({ caseId: c.id, original: e.original, a: x, b: y });
    }
  }
  return {
    items: act[0].length + typ[0].length,
    kappa: { action: cohenKappa(act[0], act[1]), expectationType: cohenKappa(typ[0], typ[1]) },
    disagreements,
  };
}
