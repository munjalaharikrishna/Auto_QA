export { type CaseLanguage, type CaseOptions, type Decision, type Unit, understandCase } from './case.js';
export { type Clause, isClauseLike, type Relation, splitClauses, startsClause } from './clauses.js';
export { type Coverage, coverageOf, coverageText, type Rate, reasonOf } from './coverage.js';
export { type DataEntry, parseTestData } from './data-binding.js';
export { evaluate, type LineContext, type Mode, understandLine } from './grammar.js';
export {
  actionsOf,
  allowsAction,
  allowsAssertion,
  headNounOf,
  lineage,
  ONTOLOGY,
  ONTOLOGY_VERSION,
  type OntologyClass,
  ontologyClass,
  refineField,
} from './ontology.js';
export { type CheckResult, parseCheck, type Subject } from './predicates.js';
export {
  CATEGORY,
  type PreflightCase,
  type PreflightReport,
  type PreflightStatus,
  preflightOf,
  preflightReport,
  preflightText,
  type Rewording,
  rewordingsOf,
  riskScore,
  wordingOf,
} from './preflight.js';
export { CATEGORIES, canonical, fixTypo, matchPhrase, SYNONYM_SETS, type SynonymCategory, type SynonymSet, synonymVersions } from './synonyms.js';
export type { GrammarModel, Issue, IssueCode, LineResult, ParsedExpectation, ParsedStep, Severity, ValueSpec } from './types.js';
export { ASSERTION_WORDS, assertionWordOf, CHECK_MARKERS, isCommandForm, VERBS, type VerbDef, VOCABULARY_VERSION, verbOf } from './vocabulary.js';
