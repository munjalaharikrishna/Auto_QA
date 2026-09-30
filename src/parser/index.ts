import {
  type Assertion,
  type ModelWarning,
  type RawTestCase,
  RawTestCaseSchema,
  type Step,
  TEST_TYPES,
  type TestModel,
  TestModelSchema,
} from '../model/test-model.js';
import { type ParsedAssertion, parseAssertions } from './assertions.js';
import { defaultParserConfig, type ParserConfig } from './config.js';
import { parsePreconditions } from './preconditions.js';
import { checkQuality } from './quality.js';
import { parseStepLine } from './steps.js';
import { parseTestData } from './test-data.js';
import { hash, splitList, splitNumbered, splitSentences } from './text.js';

export { defaultParserConfig, loadParserConfig, type ParserConfig } from './config.js';

/**
 * Test case parser (FR-PA-01): raw test case → Structured Test Model, before any browser opens.
 * Pure and deterministic: the same input and vocabulary always give the same model (NFR-02).
 */
export function parseTestCase(input: RawTestCase, config: ParserConfig = defaultParserConfig()): TestModel {
  const raw = RawTestCaseSchema.parse(input);
  const warnings: ModelWarning[] = [];

  const testData = parseTestData(raw.testData ?? '', config);
  warnings.push(...testData.warnings.map((w) => ({ at: 'data', ...w })));

  const preconditions = parsePreconditions(raw.preconditions ?? '', config);

  const steps: Step[] = [];
  const checks: Check[] = [];
  const ctx = { config, data: testData.bindings };

  const lines = splitNumbered(raw.steps).map((line) => ({ ...line, parsed: parseStepLine(line.text, ctx) }));
  const secrets = [...testData.secrets, ...lines.flatMap((l) => (l.parsed.kind === 'action' && l.parsed.action.secret ? [l.parsed.action.secret] : []))];
  const mask = (text: string) => maskSecrets(text, secrets);

  for (const { n, text, parsed } of lines) {
    const id = `S${n}`;
    const lineText = mask(text);
    warnings.push(...parsed.warnings.map((w) => ({ at: id, ...w })));

    if (parsed.kind === 'checks') {
      for (const c of parsed.checks) checks.push(toAssertion(c, lineText, 'step', id));
      continue;
    }
    const a = parsed.action;
    warnings.push(...a.warnings.map((w) => ({ at: id, ...w })));
    steps.push(
      compact({
        id,
        action: a.action,
        target: a.target,
        alternatives: a.alternatives,
        exact: a.exact,
        roleHint: a.roleHint,
        value: a.value,
        url: a.url,
        page: a.page,
        key: a.key,
        raw: lineText,
        status: a.action && !a.reason ? 'parsed' : 'unparsed',
        reason: a.reason,
      }),
    );
  }

  for (const line of splitList(raw.expected, { semicolons: true }).flatMap(splitSentences)) {
    for (const c of parseAssertions(line, config, false)) checks.push(toAssertion(c, line, 'expected'));
  }
  // "No crash" runs in every test (FR-VAL-04).
  checks.push({
    assertion: { type: 'health', expected: 'no crash', alternatives: [], negated: false, source: 'builtin', raw: '', status: 'parsed' },
    warnings: [],
  });

  const assertions = checks.map((c, i): Assertion => {
    const id = `A${i + 1}`;
    warnings.push(...c.warnings.map((w) => ({ at: id, ...w })));
    return compact({ id, ...c.assertion });
  });

  for (const item of [...steps, ...assertions]) {
    if (item.status === 'unparsed') {
      warnings.push({ at: item.id, code: 'UNPARSED', text: item.reason?.text ?? 'Could not be read.' });
    }
  }

  const type = raw.type?.trim().toLowerCase();
  const knownType = TEST_TYPES.find((t) => t === type);
  if (type && !knownType) {
    warnings.push({ code: 'UNKNOWN_TYPE', text: `Type "${raw.type}" is not one of ${TEST_TYPES.join(', ')}; it was ignored.` });
  }

  const model: TestModel = compact({
    id: raw.id?.trim() || generatedId(raw),
    version: 1,
    title: raw.title.trim(),
    type: knownType,
    requirementId: raw.requirementId?.trim() || undefined,
    preconditions,
    data: testData.data,
    steps,
    assertions,
    source: compact({
      row: raw.row,
      rawSteps: mask(raw.steps),
      rawExpected: raw.expected,
      rawPreconditions: raw.preconditions,
      rawTestData: raw.testData === undefined ? undefined : mask(raw.testData),
    }),
    warnings,
  });
  model.warnings.push(...checkQuality(model, config));
  return TestModelSchema.parse(model);
}

/**
 * Steps and assertions in the order they run: each check written as a step runs after the
 * action steps numbered before it; Expected Result checks run after the last step.
 */
export function executionOrder(model: TestModel): Array<Step | Assertion> {
  const num = (id?: string) => (id ? Number(id.slice(1)) : Infinity);
  const items = [
    ...model.steps.map((s) => ({ item: s as Step | Assertion, n: num(s.id) })),
    ...model.assertions.map((a) => ({ item: a as Step | Assertion, n: a.source === 'step' ? num(a.step) : Infinity })),
  ];
  // Stable sort keeps the parser's order for items with the same number.
  return items.sort((a, b) => a.n - b.n).map((x) => x.item);
}

interface Check {
  assertion: Omit<Assertion, 'id'>;
  warnings: ParsedAssertion['warnings'];
}

function toAssertion(c: ParsedAssertion, raw: string, source: 'step' | 'expected', step?: string): Check {
  const assertion: Omit<Assertion, 'id'> = {
    type: c.type,
    target: c.target,
    alternatives: c.alternatives,
    exact: c.exact,
    roleHint: c.roleHint,
    expected: c.expected,
    match: c.match,
    negated: c.negated,
    step,
    source,
    raw,
    status: c.type && !c.reason ? ('parsed' as const) : ('unparsed' as const),
    reason: c.reason,
  };
  return { assertion, warnings: c.warnings };
}

/** Replaces every secret value with •••• (FR-EV-03). Longest first, so one secret inside another is fully hidden. */
function maskSecrets(text: string, secrets: string[]): string {
  return [...new Set(secrets)].sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join('••••'), text);
}

/** Generated ids are stable: the row number if known, else a hash of the title. */
function generatedId(raw: RawTestCase): string {
  return raw.row ? `TC-${String(raw.row).padStart(3, '0')}` : `TC-${hash(raw.title.trim())}`;
}

/** Drops undefined fields so the JSON stays short and diffs stay clean. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
