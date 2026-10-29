import { type RawTestCase, stepsWithChecks } from '../../model/test-model.js';
import { resolveReferences } from '../context/references.js';
import { validateStates } from '../context/states.js';
import { type FieldFormat, formatKeyOf } from '../data/formats.js';
import { Secret } from '../data/secret.js';
import type { IrData, IrStep, QaIr } from '../ir/schema.js';
import { validateIr } from '../ir/validate.js';
import { dataKeyOf, isSecretName, nonBlankLines, splitStepLine } from '../patterns/shapes.js';
import { compactKey } from '../text/compound.js';
import { componentVersions } from '../versions.js';
import { type DataEntry, parseTestData } from './data-binding.js';
import { type LineContext, understandLine } from './grammar.js';
import type { GrammarModel, Issue, LineResult, ParsedStep, ValueSpec } from './types.js';

/**
 * Reads a whole test case: its steps, its expected result, its test data and its preconditions, into QA-IR and the
 * list of everything that could not be read cleanly. Nothing here opens a browser or looks at a page. The same test case
 * always gives the same result (GV-05): there is no time, no randomness and no order that depends on anything else.
 */

/** One sentence of the test case and how it went: the unit of the coverage numbers. */
export interface Unit {
  kind: 'step' | 'expectation';
  /** The tester's own words. */
  original: string;
  where: string;
  /** How many steps or expectations it gave. */
  produced: number;
  /** What it was about: the actions of its steps and the kinds of its checks. Empty when it was not understood. */
  categories: string[];
  /** Understood: it gave something and no blocking issue is about it. */
  understood: boolean;
  models: GrammarModel[];
}

export interface Decision {
  kind: 'info' | 'decision' | 'assumption' | 'warning';
  message: string;
  data?: Record<string, unknown>;
}

export interface CaseLanguage {
  testId: string;
  /** The QA-IR, when there is at least one step and one expectation and the document is valid. */
  ir?: QaIr;
  /** The problems the IR itself has, if it was built and is not valid (a fault of the engine, not of the test case). */
  irProblems: string[];
  issues: Issue[];
  units: Unit[];
  decisions: Decision[];
  /** Which grammar models were used, and how often. */
  models: Partial<Record<GrammarModel, number>>;
  /** The Test Data of the test case. The value of a secret is blank here: it is in `excelSecrets`. */
  excel: DataEntry[];
  /** The secrets of the Test Data by data key. A `Secret` is written as `***` by anything that turns it into text. */
  excelSecrets: Record<string, Secret>;
  /** What a field accepts, by the compact key of its name, from the notes of the test case ("should accept only alphabets"). */
  formats: Record<string, FieldFormat>;
}

export interface CaseOptions {
  source?: { file?: string; sheet?: string };
}

/**
 * The lines of a cell as sentences: a line break ends one only after a full stop (or the like), or when the next line
 * starts with a capital letter. "…the empty text boxes and uploaded" / "photo" is one sentence.
 */
function sentencesOf(cell: string): string[] {
  const out: string[] = [];
  for (const line of nonBlankLines(cell)) {
    const last = out[out.length - 1];
    const first = line.trim()[0] ?? '';
    const continues = last !== undefined && !'.!?;:'.includes(last.trim().slice(-1)) && first === first.toLowerCase() && first !== first.toUpperCase();
    if (continues) out[out.length - 1] = `${last} ${line.trim()}`;
    else out.push(line.trim());
  }
  return out;
}

const UNIQUE_KEY = (existing: Record<string, unknown>, base: string): string => {
  if (!(base in existing)) return base;
  let n = 2;
  while (`${base}_${n}` in existing) n++;
  return `${base}_${n}`;
};

export function understandCase(given: RawTestCase, options: CaseOptions = {}): CaseLanguage {
  // A step's own expected result comes back as a check right after its step (it is kept beside the steps, not in them).
  const raw = { ...given, steps: stepsWithChecks(given) };
  const testId = raw.id ?? 'UNKNOWN';
  const decisions: Decision[] = [];
  const issues: Issue[] = [];
  const units: Unit[] = [];
  const models: CaseLanguage['models'] = {};
  const dataEntries: DataEntry[] = parseTestData(raw.testData);
  const data: Record<string, IrData> = {};
  const facts = new Map<string, string>();
  for (const d of dataEntries) if (d.blank) facts.set(compactKey(d.key), 'BLANK');

  // ---- data: every value a step names becomes an entry of the `data` table, and the step holds `$data.name` ----
  const keyOfValue = new Map<string, string>();
  const valueText = (
    spec: ValueSpec | undefined,
    target: { ontology?: string; name?: string } | undefined,
    where: string,
    original: string,
  ): string | undefined => {
    if (!spec) return undefined;
    // "the same value": it depends on where the step stands, so it is not remembered; the references settle it.
    if (spec.kind === 'previous') {
      issues.push({
        code: 'NEEDS_REFERENCE',
        severity: 'review',
        where,
        original,
        reference: 'same value',
        message: `"${original}" points at a value entered earlier ("same"); it is resolved from what the test case did before`,
        suggestion: 'Write the value itself, or the name of the data it comes from.',
      });
      return '$ref.previous';
    }
    const cacheKey = JSON.stringify([spec, target?.name]);
    const cached = keyOfValue.get(cacheKey);
    if (cached) return cached;
    let key: string;
    switch (spec.kind) {
      case 'literal': {
        const secret = target?.ontology === 'Password' || isSecretName(target?.name ?? '');
        if (!secret) return spec.value;
        secretLiterals.add(spec.value);
        key = UNIQUE_KEY(data, `${dataKeyOf(target?.name ?? 'secret')}_value`);
        data[key] = { class: 'EXPLICIT', source: 'EXCEL', secret: true, value: '***' };
        decisions.push({ kind: 'decision', message: `${key}: a value written in the step for a secret field is kept masked, never as text`, data: { where } });
        break;
      }
      case 'data': {
        const entry = dataEntries.find((d) => d.key === spec.key) as DataEntry;
        key = dataKeyOf(entry.key);
        data[key] = entry.blank
          ? { class: 'BLANK', source: 'EXCEL', value: '', ...(spec.intent ? { intent: spec.intent } : {}) }
          : entry.secret
            ? { class: 'EXPLICIT', source: 'EXCEL', secret: true, value: '***', ...(spec.intent ? { intent: spec.intent } : {}) }
            : { class: 'EXPLICIT', source: 'EXCEL', value: entry.value, ...(spec.intent ? { intent: spec.intent } : {}) };
        break;
      }
      case 'blank':
        key = UNIQUE_KEY(data, `${dataKeyOf(target?.name ?? 'field')}_blank`);
        data[key] = { class: 'BLANK', source: 'EXCEL', value: '' };
        break;
      case 'env':
        key = spec.name.toLowerCase();
        data[key] = { class: 'REFERENCE', source: 'ENV', value: `$env.${spec.name}`, ...(spec.secret || isSecretName(spec.name) ? { secret: true } : {}) };
        break;
      case 'class': {
        const field = spec.field || target?.name || 'value';
        key = UNIQUE_KEY(data, `${dataKeyOf(field)}_${spec.dataClass.toLowerCase()}`);
        data[key] = { class: spec.dataClass, source: 'UNRESOLVED' };
        issues.push({
          code: 'MISSING_DATA',
          severity: 'review',
          where,
          original,
          data: key,
          message: `no value for "${field}": the step asks for a ${spec.dataClass.toLowerCase().replace('_', '-')} one and the test data gives none`,
          suggestion: `Add it to Test Data, for example "${field}: <value>", or write the value in quotes in the step.`,
        });
        break;
      }
    }
    keyOfValue.set(cacheKey, `$data.${key}`);
    return `$data.${key}`;
  };

  /** Values the tester typed for a secret field: they never appear in any text of the result, not even in the tester's own words. */
  const secretLiterals = new Set<string>();
  const steps: IrStep[] = [];
  const expectations: QaIr['expectations'] = [];
  const conditionals: QaIr['conditionals'] = [];
  const stepIds = { last: undefined as string | undefined };
  const formats: Record<string, FieldFormat> = {};

  // ---- the lines: steps first, then the expected result ----
  const stepLines = nonBlankLines(raw.steps).map((l) => splitStepLine(l));
  const numbered = stepLines.every((l) => l.number !== undefined) && new Set(stepLines.map((l) => l.number)).size === stepLines.length;

  const take = (result: LineResult, where: string, lineNo: string, kind: Unit['kind'], original: string): void => {
    const first = issues.length;
    const stepsBefore = steps.length;
    const expectationsBefore = expectations.length;
    for (const f of result.formats) formats[formatKeyOf(f.field)] = f.format;
    for (const note of result.notes) decisions.push({ kind: 'info', message: `note kept, not verified: ${note}`, data: { where } });
    for (const i of result.issues) issues.push({ ...i, where });

    const stepOf = new Map<number, string>();
    const expectOf = new Map<number, string>();
    const condOf = new Map<number, string>();
    // Conditionals first, so the steps and expectations they govern can name them.
    result.conditionals.forEach((c, k) => {
      const id = `C${conditionals.length + 1}`;
      condOf.set(k, id);
      conditionals.push({
        id,
        keyword: c.conditional.keyword,
        condition: c.conditional.condition,
        given: c.given,
        because: c.because,
        whenTrue: [],
        whenFalse: [],
        steps: [],
        original: c.conditional.original,
      });
      decisions.push({
        kind: c.given === 'UNKNOWN' ? 'warning' : 'decision',
        message: `${id} "${c.conditional.original}": ${c.given.toLowerCase()} (${c.because})`,
        data: { where },
      });
    });

    let within = 0;
    for (const item of result.sequence) {
      if (item.kind === 'step') {
        const s = result.steps[item.index] as ParsedStep;
        within++;
        const id = within === 1 ? `S${lineNo}` : `S${lineNo}.${within}`;
        const value = valueText(s.value, s.target, where, s.original);
        const guardId = s.guard !== undefined ? condOf.get(s.guard) : undefined;
        steps.push({
          id,
          action: s.action,
          ...(s.target ? { target: s.target } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(guardId ? { guard: guardId } : {}),
          original: s.original || original,
        });
        stepOf.set(item.index, id);
        stepIds.last = id;
        if (guardId) (conditionals.find((c) => c.id === guardId) as QaIr['conditionals'][number]).steps.push(id);
        for (const d of s.decisions) decisions.push({ kind: 'decision', message: d, data: { step: id } });
      } else {
        const e = result.expectations[item.index];
        if (!e) continue;
        const id = `E${expectations.length + 1}`;
        const guardId = e.guard !== undefined ? condOf.get(e.guard) : undefined;
        expectations.push({
          id,
          clause: e.clause || original,
          negated: e.negated,
          condition: e.condition,
          ...(stepIds.last ? { afterStep: stepIds.last } : {}),
          ...(guardId ? { guard: guardId } : {}),
        });
        expectOf.set(item.index, id);
        if (guardId) (conditionals.find((c) => c.id === guardId) as QaIr['conditionals'][number]).whenTrue.push(id);
        for (const d of e.decisions) decisions.push({ kind: 'decision', message: d, data: { expectation: id } });
      }
    }
    // A question about a reference is about one step or check of this line: it is named, so it can be settled alone.
    const made = { steps: steps.slice(stepsBefore), expectations: expectations.slice(expectationsBefore) };
    for (const i of issues.slice(first)) {
      if (i.code !== 'NEEDS_REFERENCE' || i.item) continue;
      i.item = made.expectations.find((e) => e.clause === i.original)?.id ?? made.steps.find((s) => s.original === i.original)?.id;
    }
    for (const m of result.models) models[m] = (models[m] ?? 0) + 1;
    const produced = result.steps.length + result.expectations.length;
    const blocking = issues.slice(first).some((i) => i.severity === 'blocking');
    const understood = produced > 0 && !blocking;
    // A line of the steps column that only checks something ("Verify …") is a check, whatever column it stands in.
    const actual: Unit['kind'] = result.steps.length ? 'step' : result.expectations.length ? 'expectation' : kind;
    const categories = understood ? [...new Set([...result.steps.map((s) => s.action), ...result.expectations.map((e) => e.condition.type)])] : [];
    units.push({ kind: actual, original, where, produced, categories, understood, models: [...new Set(result.models)] });
  };

  const context = (mode: 'step' | 'expected'): LineContext => ({ data: dataEntries, facts, mode });

  stepLines.forEach((line, k) => {
    const lineNo = String(numbered ? line.number : k + 1);
    take(understandLine(line.text, context('step')), `step ${lineNo}`, lineNo, 'step', line.text);
  });
  // The expected result is checked after the last step. A line break inside a sentence does not end it.
  sentencesOf(raw.expected).forEach((line, k) => {
    const lineNo = String(stepLines.length + 1 + k);
    const text = splitStepLine(line).text;
    take(understandLine(text, context('expected')), 'expected result', lineNo, 'expectation', text);
  });

  // ---- preconditions ----
  const preconditions: QaIr['preconditions'] = nonBlankLines(raw.preconditions ?? '').map((line): QaIr['preconditions'][number] => {
    const lower = line.toLowerCase();
    if (lower.includes('unauthenticated') || lower.includes('not logged in') || lower.includes('fresh')) return { type: 'FRESH_CONTEXT', original: line };
    if (lower.includes('logged in') || lower.includes('logged-in')) return { type: 'LOGGED_IN', original: line };
    return { type: 'NOTE', original: line };
  });

  if (!expectations.length && !issues.some((i) => i.severity === 'blocking')) {
    issues.push({
      code: 'NOT_UNDERSTOOD',
      severity: 'blocking',
      where: 'expected result',
      original: raw.expected,
      message: 'no check could be built from the expected result',
      suggestion: 'Say what should be true when the steps are done, for example: Verify the Dashboard heading is displayed.',
    });
  }
  if (!steps.length && !issues.some((i) => i.severity === 'blocking')) {
    issues.push({
      code: 'NOT_UNDERSTOOD',
      severity: 'blocking',
      where: 'steps',
      original: raw.steps,
      message: 'no step could be built',
      suggestion: 'Write the steps as actions, one per line: Open the Login page. Enter … Click …',
    });
  }

  // ---- target conflicts: one name, two kinds of thing ----
  const kindsOf = new Map<string, Set<string>>();
  const note = (name: string | undefined, cls: string): void => {
    if (!name || cls === 'Element' || cls === 'Page') return;
    const key = compactKey(name);
    if (!kindsOf.has(key)) kindsOf.set(key, new Set());
    kindsOf.get(key)?.add(cls === 'Username' || cls === 'Password' || cls === 'File' || cls === 'Dropdown' ? 'Field' : cls);
  };
  for (const s of steps) note(s.target?.name, s.target?.ontology ?? '');
  for (const e of expectations) note(e.condition.target?.name, e.condition.target?.ontology ?? '');
  for (const [key, classes] of kindsOf) {
    if (classes.size < 2) continue;
    const name = steps.find((s) => s.target?.name && compactKey(s.target.name) === key)?.target?.name ?? key;
    issues.push({
      code: 'AMBIGUOUS',
      severity: 'review',
      where: 'test case',
      original: name,
      message: `the name "${name}" is used for more than one kind of element (${[...classes].join(', ')}): the element to use is not clear`,
      suggestion: `Give them different names, or say which one is meant: the '${name}' button, the ${name} field.`,
    });
  }

  // ---- context (E0.5): what "it", "the same field" and "the added data" stand for, and the states the test case goes through ----
  const loggedIn = preconditions.some((p) => p.type === 'LOGGED_IN');
  const refs = resolveReferences({ testId, steps, expectations, issues, loggedIn });
  steps.splice(0, steps.length, ...refs.steps);
  expectations.splice(0, expectations.length, ...refs.expectations);
  issues.splice(0, issues.length, ...refs.issues);
  for (const c of conditionals) {
    c.whenTrue = c.whenTrue.flatMap((id) => refs.expectationMap[id] ?? [id]);
    c.whenFalse = c.whenFalse.flatMap((id) => refs.expectationMap[id] ?? [id]);
  }
  for (const message of refs.decisions) decisions.push({ kind: 'decision', message });
  const states = validateStates(steps, expectations, loggedIn ? 'DASHBOARD' : undefined);
  steps.splice(0, steps.length, ...states.steps);
  issues.push(...states.issues);
  if (states.path.length) decisions.push({ kind: 'info', message: `states: ${states.path.map((p) => p.state).join(' → ')}` });

  // ---- QA-IR ----
  let ir: QaIr | undefined;
  let irProblems: string[] = [];
  if (steps.length && expectations.length) {
    const { grammar, vocabulary, ontology, patterns } = componentVersions();
    const draft: QaIr = {
      testCase: {
        id: testId,
        name: raw.title,
        version: 1,
        source: { ...(options.source ?? {}), rows: raw.row ? [raw.row] : [] },
        priority: raw.priority ?? null,
        tags: raw.tags ?? [],
      },
      preconditions,
      data,
      steps,
      expectations,
      conditionals,
      references: refs.references,
      assumptions: [],
      versions: { grammar, vocabulary, ontology, patterns },
    };
    const checked = validateIr(draft);
    if (checked.ok) ir = checked.ir;
    else irProblems = checked.issues.map((i) => `${i.path}: ${i.message}`);
  }

  const excel = dataEntries.map((e) => (e.secret ? { ...e, value: '' } : e));
  const excelSecrets = Object.fromEntries(dataEntries.filter((e) => e.secret && !e.blank).map((e) => [dataKeyOf(e.key), new Secret(e.value)]));
  if (!secretLiterals.size) return { testId, ir, irProblems, issues, units, decisions, models, excel, excelSecrets, formats };
  // The tester's own words keep their quotes around a value; the value is taken out of them.
  const scrub = (text: string): string => {
    let out = text;
    for (const v of secretLiterals) {
      for (const [open, close] of [
        ["'", "'"],
        ['"', '"'],
        ['“', '”'],
        ['‘', '’'],
      ] as const)
        out = out.split(`${open}${v}${close}`).join(`${open}***${close}`);
    }
    return out;
  };
  const clean = <T>(value: T): T => JSON.parse(scrub(JSON.stringify(value))) as T;
  return { ...clean({ testId, ir, irProblems, issues, units, decisions, models, excel }), excelSecrets, formats };
}
