import type { Assertion, AssertionType } from '../model/test-model.js';
import { elementSpecs } from './element.js';
import { formSpecs } from './forms.js';
import { layoutSpecs } from './layout.js';
import { messageSpecs } from './messages.js';
import { networkSpecs } from './network.js';
import { otherSpecs } from './other.js';
import { pageSpecs } from './page.js';
import { tableSpecs } from './tables.js';
import { textSpecs } from './text.js';
import type { CodeContext, ParseContext, Parsed, ValidationSpec } from './types.js';

/**
 * The validation registry (VALIDATIONS.md §2.1). The order matters: the first spec whose words match wins,
 * so the more specific families come first.
 */
export const SPECS: ValidationSpec[] = [
  ...networkSpecs,
  ...formSpecs,
  ...messageSpecs,
  ...tableSpecs,
  ...otherSpecs,
  ...pageSpecs,
  ...layoutSpecs,
  ...elementSpecs,
  ...textSpecs,
];

const BY_TYPE = new Map<AssertionType, ValidationSpec>();
for (const s of SPECS) if (!BY_TYPE.has(s.type)) BY_TYPE.set(s.type, s);

export function specFor(type: AssertionType | undefined): ValidationSpec | undefined {
  return type ? BY_TYPE.get(type) : undefined;
}

/** Tries each check in turn on a sentence. Returns what the first match makes of it, and which spec it was. */
export function parseValidation(ctx: ParseContext): (Parsed & { type: AssertionType; spec: ValidationSpec }) | undefined {
  for (const spec of SPECS) {
    const parsed = spec.parse(ctx);
    if (parsed) return { ...parsed, type: parsed.type ?? spec.type, spec };
  }
  return undefined;
}

/** How many elements exploration must find for a check of this type. */
export function targetsOf(type: AssertionType | undefined): 'none' | 'one' | 'two' | undefined {
  return specFor(type)?.targets;
}

/** The generated lines for a check of one of the registry's types. */
export function codeFor(a: Assertion, c: CodeContext): string[] | undefined {
  return specFor(a.type)?.code(a, c);
}

/** What to say when the check passed. */
export function passedText(a: Pick<Assertion, 'type'> & Partial<Assertion>): string | undefined {
  const spec = specFor(a.type);
  return spec ? spec.passed({ id: '', raw: '', source: 'step', status: 'parsed', alternatives: [], negated: false, ...a } as Assertion) : undefined;
}
