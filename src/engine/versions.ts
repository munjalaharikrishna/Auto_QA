/**
 * Version stamp of every component that decides how a test case is understood (GV-12). A run records them, so a
 * different result can always be traced to a changed component. Each is bumped when its data or rules change.
 */
export const COMPONENT_VERSIONS = {
  /** The QA-IR document format (src/engine/ir). */
  ir: '1.0.0',
  /** Compilation stages (src/engine/pipeline). */
  pipeline: '1.0.0',
  /** The legacy parser the first stages still use for understanding, until M2/M3 replace it (E0.3, E0.4). */
  grammar: '0.1.0-legacy',
  vocabulary: '0.1.0-legacy',
  ontology: '0.1.0-legacy',
  patterns: '0.1.0-legacy',
} as const;

export type ComponentVersions = { -readonly [K in keyof typeof COMPONENT_VERSIONS]: string };

/** A copy, so a caller cannot change the stamp for the next run. */
export const componentVersions = (): ComponentVersions => ({ ...COMPONENT_VERSIONS });
