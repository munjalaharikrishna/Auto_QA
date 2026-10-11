import type { Action, Assertion, AssertionType, Precondition, Step, TestModel, ValueRef } from '../../model/test-model.js';
import { isSecretName } from '../config/index.js';
import { componentVersions } from '../versions.js';
import type { IrAction, IrData, IrExpectation, IrStep, IrTarget, QaIr } from './schema.js';

/**
 * Builds QA-IR from the test model the current parser produces. This is the simplest form of "Understand → Build QA-IR"
 * (the walking skeleton, BP-1): the new language layers (E0.3, E0.4) will replace the parser behind it without changing
 * the document that comes out.
 */

const ACTION: Record<Action, IrAction> = {
  navigate: 'NAVIGATE',
  back: 'BACK',
  forward: 'FORWARD',
  refresh: 'REFRESH',
  fill: 'ENTER_VALUE',
  clear: 'CLEAR',
  click: 'CLICK',
  select: 'SELECT',
  check: 'CHECK',
  uncheck: 'UNCHECK',
  hover: 'HOVER',
  upload: 'UPLOAD',
  press: 'PRESS',
};

const ONTOLOGY: Record<string, string> = {
  button: 'Button',
  link: 'Link',
  textbox: 'TextBox',
  checkbox: 'CheckBox',
  radio: 'RadioButton',
  combobox: 'Dropdown',
  listbox: 'Dropdown',
  heading: 'Heading',
  table: 'Table',
  row: 'TableRow',
  dialog: 'Dialog',
  alert: 'Message',
  form: 'Form',
  page: 'Page',
};
const ontologyOf = (roleHint?: string): string => (roleHint && ONTOLOGY[roleHint]) || 'Element';

const CONDITION: Partial<Record<AssertionType, IrExpectation['condition']['type']>> = {
  url: 'URL',
  'url-unchanged': 'URL',
  visible: 'VISIBILITY',
  attached: 'VISIBILITY',
  text: 'TEXT',
  'exact-text': 'TEXT',
  'contains-text': 'TEXT',
  enabled: 'ENABLED',
  disabled: 'ENABLED',
  value: 'VALUE',
  count: 'COUNT',
  health: 'HEALTH',
};

const stateName = (text: string): string => {
  const name = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[A-Z]/.test(name) ? name : `S_${name || 'STATE'}`;
};

const numberOf = (id: string): number => Number(/\d+/.exec(id)?.[0] ?? 0);

export interface IrSource {
  file?: string;
  sheet?: string;
}

export function toQaIr(model: TestModel, source: IrSource = {}): QaIr {
  const data: Record<string, IrData> = {};
  for (const [key, value] of Object.entries(model.data)) {
    data[key] = value === '' ? { class: 'BLANK', source: 'EXCEL', value: '' } : { class: 'EXPLICIT', source: 'EXCEL', value };
  }

  /** The value of a step as the document writes it: a literal, or `$data.name` for anything kept in `data`. */
  const valueText = (ref: ValueRef | undefined): string | undefined => {
    if (!ref) return undefined;
    if (ref.kind === 'literal') return ref.value;
    if (ref.kind === 'data') {
      if (!(ref.key in data)) data[ref.key] = { class: 'EXPLICIT', source: 'EXCEL' };
      return `$data.${ref.key}`;
    }
    const key = ref.kind === 'env' ? ref.name.toLowerCase() : `gen_${ref.name.replace(/\W+/g, '_').toLowerCase()}`;
    data[key] =
      ref.kind === 'env'
        ? { class: 'REFERENCE', source: 'ENV', value: `$env.${ref.name}`, ...(isSecretName(ref.name) ? { secret: true } : {}) }
        : { class: 'GENERATED', source: 'GENERATOR', value: `$generator.${ref.name}` };
    return `$data.${key}`;
  };

  const targetOf = (s: Step): IrTarget | undefined => {
    if (s.action === 'navigate') return { ontology: 'Page', name: s.page ?? (s.baseUrl ? 'Application' : undefined) };
    if (!s.target) return undefined;
    return { ontology: s.container ? 'Container' : ontologyOf(s.roleHint), name: s.target };
  };

  const steps: IrStep[] = model.steps
    .filter((s) => s.action)
    .map((s) => {
      const value = s.action === 'press' ? s.key : s.action === 'navigate' ? s.url : valueText(s.value);
      return {
        id: s.id,
        action: ACTION[s.action as Action],
        ...(targetOf(s) ? { target: targetOf(s) } : {}),
        ...(value !== undefined ? { value } : {}),
        original: s.raw,
      };
    });

  /** An expectation follows the last step numbered at or before the one it was written as; none when it was written first. */
  const afterStep = (a: Assertion): string | undefined => {
    if (!a.step) return undefined;
    const at = numberOf(a.step);
    return steps.filter((s) => numberOf(s.id) <= at).at(-1)?.id;
  };

  const expectations: IrExpectation[] = model.assertions
    .filter((a) => a.type)
    .map((a, i) => ({
      id: `E${i + 1}`,
      clause: a.source === 'builtin' ? `automatic check: ${a.type}` : a.raw,
      ...(a.source === 'builtin' ? { automatic: true } : {}),
      negated: a.negated,
      condition: {
        type: CONDITION[a.type as AssertionType] ?? 'OTHER',
        ...(a.target ? { target: { ontology: ontologyOf(a.roleHint), name: a.target } } : {}),
        ...(a.expected !== undefined ? { expect: a.expected } : {}),
        check: a.type,
      },
      ...(afterStep(a) ? { afterStep: afterStep(a) } : {}),
    }));

  const preconditions = model.preconditions.map((p: Precondition): QaIr['preconditions'][number] => {
    if (p.kind === 'fresh-context') return { type: 'FRESH_CONTEXT', original: p.raw };
    if (p.kind === 'logged-in') return { type: 'LOGGED_IN', ...(p.user ? { user: p.user } : {}), original: p.raw };
    if (p.kind === 'flow') return { type: 'STATE', state: stateName(p.name), original: p.raw };
    return { type: 'NOTE', original: p.raw };
  });

  const assumptions = model.warnings
    .filter((w) => w.code === 'ASSUMED_VALUE')
    .map((w, i) => ({ id: `A${i + 1}`, text: w.text, ...(w.at ? { at: w.at } : {}) }));

  const { grammar, vocabulary, ontology, patterns } = componentVersions();
  return {
    testCase: {
      id: model.id,
      name: model.title,
      version: model.version,
      source: { ...source, rows: model.source.row ? [model.source.row] : [] },
      priority: model.priority ?? null,
      tags: model.tags ?? [],
    },
    preconditions,
    data,
    steps,
    expectations,
    conditionals: [],
    references: [],
    assumptions,
    versions: { grammar, vocabulary, ontology, patterns },
  };
}
