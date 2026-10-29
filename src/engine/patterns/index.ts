import { BUILTIN_PATTERNS } from './defs.js';
import { type PatternDef, PatternSet } from './engine.js';

export { AUTH_PATTERNS, BUILTIN_PATTERNS, EXTRACT_PATTERNS, TEXT_PATTERNS, VALUE_PATTERNS } from './defs.js';
export {
  DEFAULT_LIMIT_MS,
  type PatternConflict,
  type PatternDef,
  PatternError,
  type PatternExamples,
  type PatternMatch,
  PatternSet,
  type PatternTimeout,
  resolveConflicts,
  type ScanResult,
} from './engine.js';
export * from './interpret.js';
export { expandAbbreviation, expandContraction } from './lexicon.js';
export * from './shapes.js';

let shared: PatternSet | undefined;

/** The built-in patterns, loaded once. A broken built-in stops the first use, naming the pattern (RX-22). */
export const patterns = (): PatternSet => {
  shared ??= new PatternSet(BUILTIN_PATTERNS);
  return shared;
};

/** The one-time code in the text of a mail (AU-04): the first one the pattern finds, or undefined. */
export const otpCodeOf = (text: string): string | undefined => patterns().first('otpCode', text)?.text;

/** Whether a message shown by the application says that a one-time code was refused (AU-06). */
export const refusesOtp = (text: string): boolean => patterns().first('otpRejected', text) !== undefined;

/** The built-in patterns plus a project's own (for example ID schemas, RX-10, when they are added). */
export const patternsWith = (extra: readonly PatternDef[], options?: { limitMs?: number }): PatternSet =>
  new PatternSet([...BUILTIN_PATTERNS, ...extra], options);
export { type ProductionPattern, REDACTED, redactProduction } from './redact.js';
