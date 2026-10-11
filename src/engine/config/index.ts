import { COMPONENT_VERSIONS } from '../versions.js';

/**
 * One source of configuration for the engine (GV-04). Everything the engine reads that is not the test case itself
 * comes from here, so a run is described by the configuration plus the test case, and nothing else.
 */

/** Which engine runs a batch: the current one, or the new semantic engine being built (PD-1). */
export const ENGINES = ['legacy', 'semantic'] as const;
export type EngineKind = (typeof ENGINES)[number];

export const isEngine = (value: unknown): value is EngineKind => (ENGINES as readonly unknown[]).includes(value);

export interface EngineConfig {
  engine: EngineKind;
  /** A run with an assumption in it is never a clean PASS (DEC-05). Fixed; here so the rule has one home. */
  assumptionsBlockPass: true;
  /** Names that mark a value as a secret: it is only ever kept as a reference (DS-02). */
  secretNames: RegExp;
  versions: typeof COMPONENT_VERSIONS;
}

const DEFAULTS: EngineConfig = {
  engine: 'legacy',
  assumptionsBlockPass: true,
  secretNames: /PASS(WORD)?|SECRET|TOKEN|API_?KEY|PIN|OTP/i,
  versions: COMPONENT_VERSIONS,
};

let current: EngineConfig = { ...DEFAULTS };

export const engineConfig = (): Readonly<EngineConfig> => current;

/** Changes the configuration. Only the engine can be chosen: the other rules are fixed by the specification. */
export function setEngine(engine: EngineKind): void {
  current = { ...current, engine };
}

export function resetEngineConfig(): void {
  current = { ...DEFAULTS };
}

/** `legacy` unless the value names a known engine. An unknown value never silently switches to the new engine. */
export function engineFrom(value: unknown): EngineKind {
  return isEngine(value) ? value : DEFAULTS.engine;
}

/** The names of the data a test case may keep as a reference, e.g. `TEST_PASSWORD`. */
export const isSecretName = (name: string): boolean => engineConfig().secretNames.test(name);
