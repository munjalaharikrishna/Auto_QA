import type { DataClass, IrData, IrStep } from '../ir/schema.js';
import type { DataEntry } from '../language/data-binding.js';
import { dataKeyOf, fieldFromKey, isSecretName, upperSnake } from '../patterns/shapes.js';
import { compactKey } from '../text/compound.js';
import { dataClassDef, fieldKindOf, NEEDS_REAL_VALUE } from './classes.js';
import { DEFAULT_MAX_LENGTH, generate, seedOf } from './generator.js';
import { Secret } from './secret.js';
import type { CredentialStore } from './store.js';

/**
 * Layer 17, the test data resolver (DR-01). A value the test case needs is looked for in a fixed, documented order, and
 * the first source that has it wins:
 *
 *   1. Excel: the Test Data column, or the step's own text
 *   2. environment variables
 *   3. central configuration
 *   4. the credential store (encrypted: DS-04)
 *   5. test-data files
 *   6. generated values (deterministic: DG-01), only for what a generator can honestly make
 *   7. earlier steps of the same test case
 *   8. values the application creates (known only at run time: the value is asked for, not made up)
 *
 * An EXPLICIT value, one the test case itself gives, always wins and is never replaced by anything else. Nothing is
 * made up for a credential: a "valid password" can only come from a source that knows it.
 */

export const SOURCE_ORDER = ['EXCEL', 'ENV', 'CONFIG', 'STORE', 'FILE', 'GENERATOR', 'STEP', 'APPLICATION'] as const;

export interface ResolveContext {
  testId: string;
  /** The run, for the seed: a new run gives new generated values, the same run gives the same ones. */
  run?: string;
  /** The Test Data column of the test case. The value of a secret is blank; it is in `excelSecrets`. */
  excel: readonly DataEntry[];
  /** The secrets of the Test Data by data key. */
  excelSecrets?: Record<string, Secret>;
  env?: Record<string, string | undefined>;
  /** Central configuration: `username.valid`, `password.valid`, or the name of a variable. */
  config?: Record<string, string>;
  store?: CredentialStore;
  /** Test-data files, already read: the same names as the configuration. */
  files?: Record<string, string>;
  /** The longest value each field takes (from the application's knowledge); without one, 255. */
  maxLengths?: Record<string, number>;
  steps: readonly IrStep[];
}

export interface ResolvedValue {
  key: string;
  field: string;
  class: DataClass;
  source: (typeof SOURCE_ORDER)[number];
  /** A secret is a `Secret` and cannot be written by accident. */
  value: string | Secret;
  rule?: string;
  seed?: string;
}

export interface ResolveDecision {
  kind: 'decision' | 'warning';
  message: string;
  data: Record<string, unknown>;
}

export interface Unresolved {
  key: string;
  field: string;
  class: DataClass;
  why: string;
}

export interface Resolution {
  /** The values for the run, in memory only. A secret is a `Secret`. */
  values: Record<string, ResolvedValue>;
  /** The data table for the QA-IR: the same keys, with the source and the rule, and no secret value. */
  data: Record<string, IrData>;
  decisions: ResolveDecision[];
  unresolved: Unresolved[];
}

/** The field a data key is used for: the target name of the first step that holds it. */
function fieldOf(key: string, steps: readonly IrStep[]): string {
  const step = steps.find((s) => s.value === `$data.${key}`);
  // An upload is of a file, whatever button opens the chooser.
  if (step?.action === 'UPLOAD') return fieldFromKey(key);
  return step?.target?.name ?? step?.target?.label ?? fieldFromKey(key);
}

const stepOf = (key: string, steps: readonly IrStep[]): string => steps.find((s) => s.value === `$data.${key}`)?.id ?? 'S0';

export async function resolveData(data: Record<string, IrData>, ctx: ResolveContext): Promise<Resolution> {
  const values: Record<string, ResolvedValue> = {};
  const out: Record<string, IrData> = {};
  const decisions: ResolveDecision[] = [];
  const unresolved: Unresolved[] = [];
  const env = ctx.env ?? {};

  const record = (key: string, field: string, d: IrData, v: Omit<ResolvedValue, 'key' | 'field' | 'class'> & { class?: DataClass }, tried: string[]): void => {
    // Nothing to hide in a value that is empty: a blank password is a blank, not a secret.
    const secret = v.value !== '' && (d.secret === true || isSecretName(key) || isSecretName(field) || fieldKindOf(field) === 'password');
    const value = secret && typeof v.value === 'string' ? new Secret(v.value) : v.value;
    const cls = v.class ?? d.class;
    values[key] = { key, field, class: cls, source: v.source, value, ...(v.rule ? { rule: v.rule } : {}), ...(v.seed ? { seed: v.seed } : {}) };
    const intent = d.intent ?? (d.class !== cls && d.class !== 'EXPLICIT' && d.class !== 'REFERENCE' ? d.class : undefined);
    const shown = secret ? '***' : typeof value === 'string' ? value : '***';
    const reference = v.source === 'ENV' || v.source === 'STORE';
    out[key] = {
      class: reference ? (v.source === 'STORE' ? 'CREDENTIAL' : 'ENVIRONMENT') : cls,
      source: v.source,
      ...(reference ? { value: d.value?.startsWith('$') ? d.value : `$${v.source === 'ENV' ? 'env' : 'store'}.${key}` } : { value: shown }),
      ...(secret ? { secret: true } : {}),
      ...(intent ? { intent } : {}),
      ...(v.rule ? { rule: v.rule } : {}),
      ...(v.seed ? { seed: v.seed } : {}),
    };
    decisions.push({
      kind: 'decision',
      message: `${key} (${field}): ${intent ?? cls} from ${v.source}${v.rule ? `, rule ${v.rule}` : ''}${secret ? ' (secret, never written)' : ''}`,
      data: { key, source: v.source, ...(v.rule ? { rule: v.rule, seed: v.seed } : {}), tried },
    });
  };
  const fail = (key: string, field: string, d: IrData, why: string, tried: string[]): void => {
    out[key] = { ...d, source: 'UNRESOLVED' };
    unresolved.push({ key, field, class: d.class, why });
    decisions.push({ kind: 'warning', message: `${key} (${field}): not resolved: ${why}`, data: { key, tried } });
  };

  for (const [key, d] of Object.entries(data)) {
    const field = fieldOf(key, ctx.steps);
    const tried: string[] = [];
    const fieldKey = compactKey(field);

    // 1. Excel: the value the test case itself gives. It always wins; nothing else is consulted.
    if (d.source === 'EXCEL' && (d.class === 'EXPLICIT' || d.class === 'BLANK' || d.class === 'EMPTY' || d.class === 'MISSING' || d.class === 'NULL')) {
      tried.push('EXCEL');
      const entry = ctx.excel.find((e) => dataKeyOf(e.key) === key);
      const value = d.secret || entry?.secret ? (ctx.excelSecrets?.[key]?.reveal() ?? '') : (d.value ?? entry?.value ?? '');
      record(key, field, d, { source: 'EXCEL', value: d.class === 'NULL' ? 'null' : value }, tried);
      continue;
    }
    // A masked secret that came from the sheet: its real value is in the test data.
    if (d.source === 'EXCEL' && d.secret) {
      tried.push('EXCEL');
      const secretValue = ctx.excelSecrets?.[key];
      if (secretValue) {
        record(key, field, d, { source: 'EXCEL', value: secretValue.reveal() }, tried);
        continue;
      }
      // A secret typed in a step is not in the test data: it was masked when the step was read. It is asked for again.
      fail(key, field, d, 'a secret written in a step is not kept; put it in the credential store or an environment variable', tried);
      continue;
    }

    // A reference to an environment variable: `$env.TEST_PASSWORD`.
    // Without an environment given, the variable is read when the test runs: the reference is kept as it is.
    if (d.source === 'ENV' && ctx.env === undefined && !ctx.config && !ctx.store) {
      out[key] = d;
      decisions.push({ kind: 'decision', message: `${key} (${field}): read from ${d.value} when the test runs`, data: { key, source: 'ENV' } });
      continue;
    }
    if (d.source === 'ENV' && d.value?.startsWith('$env.')) {
      const name = d.value.slice(5);
      tried.push(`ENV ${name}`);
      const fromEnv = env[name];
      if (fromEnv !== undefined && fromEnv !== '') {
        record(key, field, d, { source: 'ENV', value: fromEnv }, tried);
        continue;
      }
      tried.push('CONFIG', 'STORE');
      const fromConfig = ctx.config?.[name] ?? ctx.config?.[name.toLowerCase()];
      if (fromConfig !== undefined) {
        record(key, field, d, { source: 'CONFIG', value: fromConfig }, tried);
        continue;
      }
      let sealed: Secret | undefined;
      for (const n of [name, `${fieldKey}.valid`]) sealed ??= await ctx.store?.get(n);
      if (sealed) {
        record(key, field, d, { source: 'STORE', value: sealed.reveal() }, tried);
        continue;
      }
      fail(key, field, d, `the environment variable ${name} is not set`, tried);
      continue;
    }

    if (d.source !== 'UNRESOLVED') {
      // Already settled by something the resolver does not own (a value the engine was given): kept as it is.
      out[key] = d;
      continue;
    }

    // A kind of value the text names ("valid", "invalid", "maximum length"): the sources in their order.
    const cls = d.class;
    const kind = fieldKindOf(field);
    const names = [`${fieldKey}.${cls.toLowerCase()}`, ...(cls === 'VALID' ? [fieldKey] : [])];
    const envName = cls === 'VALID' ? `TEST_${upperSnake(field)}` : `TEST_${upperSnake(field)}_${cls}`;

    // 1. Excel: a value of the test data for this field, whatever the step called it.
    tried.push('EXCEL');
    const entry = ctx.excel.find((e) => compactKey(e.key) === fieldKey);
    if (entry && cls === 'VALID') {
      record(key, field, d, { class: 'EXPLICIT', source: 'EXCEL', value: entry.value }, tried);
      continue;
    }
    // 2. environment
    tried.push(`ENV ${envName}`);
    if (env[envName]) {
      record(key, field, d, { source: 'ENV', value: env[envName] as string }, tried);
      continue;
    }
    // 3. configuration
    tried.push('CONFIG');
    const cfg = names.map((n) => ctx.config?.[n]).find((v) => v !== undefined);
    if (cfg !== undefined) {
      record(key, field, d, { class: 'EXPLICIT', source: 'CONFIG', value: cfg }, tried);
      continue;
    }
    // 4. credential store
    tried.push('STORE');
    let sealed: Secret | undefined;
    for (const n of names) sealed ??= await ctx.store?.get(n);
    if (sealed) {
      record(key, field, d, { source: 'STORE', value: sealed.reveal() }, tried);
      continue;
    }
    // 5. test-data files
    tried.push('FILE');
    const file = names.map((n) => ctx.files?.[n]).find((v) => v !== undefined);
    if (file !== undefined) {
      record(key, field, d, { class: 'EXPLICIT', source: 'FILE', value: file }, tried);
      continue;
    }
    // 7 (before 6 for copies). A duplicate is a copy of what was entered earlier in this test case.
    if (cls === 'DUPLICATE') {
      tried.push('STEP');
      const earlier = Object.values(values).find((v) => compactKey(v.field) === fieldKey);
      if (earlier) {
        record(key, field, d, { source: 'STEP', value: typeof earlier.value === 'string' ? earlier.value : earlier.value.reveal() }, tried);
        continue;
      }
      fail(key, field, d, `a duplicate needs a value entered earlier for "${field}"`, tried);
      continue;
    }
    // 6. generated: only what a generator can honestly make.
    tried.push('GENERATOR');
    const needsReal = (cls === 'VALID' || cls === 'EXISTING') && NEEDS_REAL_VALUE.has(kind);
    if (cls === 'EXISTING' || needsReal) {
      tried.push('APPLICATION');
      fail(
        key,
        field,
        d,
        cls === 'EXISTING'
          ? `an existing ${field} is one the application already has: give it in Test Data, an environment variable or the credential store`
          : `a valid ${field} cannot be made up: give it in Test Data (${field}: …), the environment variable ${envName}, or the credential store`,
        tried,
      );
      continue;
    }
    try {
      const max = ctx.maxLengths?.[field] ?? ctx.maxLengths?.[fieldKey] ?? DEFAULT_MAX_LENGTH;
      const g = generate(cls, kind, seedOf(ctx.testId, stepOf(key, ctx.steps), ctx.run ?? 'run-1', key), { maxLength: max });
      record(key, field, d, { class: dataClassDef(cls) ? 'GENERATED' : cls, source: 'GENERATOR', value: g.value, rule: g.rule, seed: g.seed }, tried);
      if ((cls === 'MAXIMUM' || cls === 'BOUNDARY') && ctx.maxLengths?.[field] === undefined && ctx.maxLengths?.[fieldKey] === undefined) {
        decisions.push({
          kind: 'warning',
          message: `${key}: the longest value of "${field}" is not known; ${DEFAULT_MAX_LENGTH} characters are used`,
          data: { key },
        });
      }
    } catch (e) {
      fail(key, field, d, (e as Error).message, tried);
    }
  }
  return { values, data: out, decisions, unresolved };
}
