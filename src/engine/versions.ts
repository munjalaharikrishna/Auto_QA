/**
 * Version stamp of every component that decides how a test case is understood (GV-12). A run records them, so a
 * different result can always be traced to a changed component. Each is bumped when its data or rules change.
 */
export const COMPONENT_VERSIONS = {
  /** The QA-IR document format (src/engine/ir). */
  ir: '1.0.0',
  /** Compilation stages (src/engine/pipeline). */
  pipeline: '1.0.0',
  /** The language layers (src/engine/language, E0.4): QA grammar, controlled vocabulary with the synonym directories, QA ontology. */
  grammar: '1.0.0',
  vocabulary: '1.0.0',
  ontology: '1.0.0',
  /** The pattern set and the normalizer and tokenizer built on it (src/engine/patterns, src/engine/text; E0.3). Per-pattern versions are in `patterns().versions`. */
  patterns: '1.0.0',
} as const;

export type ComponentVersions = { -readonly [K in keyof typeof COMPONENT_VERSIONS]: string };

/** A copy, so a caller cannot change the stamp for the next run. */
export const componentVersions = (): ComponentVersions => ({ ...COMPONENT_VERSIONS });
