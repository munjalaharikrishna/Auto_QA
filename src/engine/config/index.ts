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
  versions: typeof COMPONENT_VERSIONS;
}

const DEFAULTS: EngineConfig = {
  engine: 'semantic',
  assumptionsBlockPass: true,
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

/** The default engine unless the value names a known engine: an unknown value never silently picks the other one (E1.0: the default is the new engine; `legacy` stays as a choice). */
export function engineFrom(value: unknown): EngineKind {
  return isEngine(value) ? value : DEFAULTS.engine;
}

/** The names of the data a test case may keep as a reference, e.g. `TEST_PASSWORD`. The shape lives in the pattern layer (RX-01). */
export { isSecretName } from '../patterns/shapes.js';
