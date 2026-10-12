import type { DataClass, IrAction, IrCondition, IrTarget } from '../ir/schema.js';

/**
 * What the language layers hand on. Nothing here is a verdict or a guess: a sentence that cannot be read gives an
 * `Issue`, never an invented step.
 */

/** The grammar models of GR-01 to GR-10; GR-11 (positional parameters) is how the models read their parts. */
export type GrammarModel = 'GR-01' | 'GR-02' | 'GR-03' | 'GR-04' | 'GR-05' | 'GR-06' | 'GR-07' | 'GR-08' | 'GR-09' | 'GR-10';

export type IssueCode =
  /** The sentence fits no grammar model. Never guessed. */
  | 'NOT_UNDERSTOOD'
  /** The first word is not one of the actions (VO-01) and no synonym maps it: VD-05. */
  | 'UNSUPPORTED'
  /** The sentence can be read two ways, or says too little to check. */
  | 'AMBIGUOUS'
  /** A step needs a value that no data source gives. */
  | 'MISSING_DATA'
  /** What the sentence asks cannot be done: an action the target does not allow, or two things that exclude each other (VD-04). */
  | 'PARADOX'
  /** A condition whose truth is not known before the run: the branch is the tester's to choose (CD-02). */
  | 'UNKNOWN_BRANCH'
  /** Part of the text is not a step or a check (a note); it is kept and not verified. */
  | 'NOT_CHECKED'
  /** The check needs a value from an earlier step; resolved when references are built (RF-01). */
  | 'NEEDS_REFERENCE';

/**
 * `blocking`: the test case cannot be compiled to a runnable plan until it is rewritten. `review`: it compiles, but a
 * person must decide something first. `info`: worth knowing, nothing to decide.
 */
export type Severity = 'blocking' | 'review' | 'info';

export interface Issue {
  code: IssueCode;
  severity: Severity;
  message: string;
  /** The tester's own words the issue is about. */
  original: string;
  /** Where in the test case: `step 3`, `expected result`. */
  where: string;
  /** A clearer way to write it (BP-5). */
  suggestion?: string;
  /** For NEEDS_REFERENCE: the word that points at something earlier ("it", "same", "added"), so it can be resolved (RF-01). */
  reference?: string;
  /** For MISSING_DATA: the key of the data entry, so the resolver can settle it (DR-01). */
  data?: string;
  /** The step or expectation the issue is about (`S3`, `E7`): the same sentence can stand in many places, so text alone cannot say which. */
  item?: string;
}

/** A value a step needs. */
export type ValueSpec =
  | { kind: 'literal'; value: string }
  /** A named value of the test data. `intent` is the kind the step asked for ("invalid username" with `Username: invaliduser`). */
  | { kind: 'data'; key: string; intent?: DataClass }
  | { kind: 'blank' }
  /** A kind of value the text names ("valid", "invalid") for a field: the data resolver gives it a value (E0.5). */
  | { kind: 'class'; dataClass: Exclude<DataClass, 'EXPLICIT' | 'REFERENCE' | 'BLANK'>; field: string }
  /** "the same value": the value entered in the step before; resolved when references are (RF-01). */
  | { kind: 'previous' }
  /** The name of an environment variable that holds it (`TEST_USERNAME`). */
  | { kind: 'env'; name: string; secret: boolean };

export interface ParsedStep {
  action: IrAction;
  target?: IrTarget;
  value?: ValueSpec;
  /** The tester's own words for the step. */
  original: string;
  model: GrammarModel;
  /** Choices the layer made that the log should show. */
  decisions: string[];
  /** Index in `LineResult.conditionals` of the condition this step only runs under. */
  guard?: number;
}

export interface ParsedExpectation {
  clause: string;
  negated: boolean;
  condition: IrCondition;
  model: GrammarModel;
  decisions: string[];
  /** Index in `LineResult.conditionals` of the condition this expectation only holds under. */
  guard?: number;
}

/** A condition that governs expectations: `if the password is invalid, an error is shown`. */
export interface ParsedConditional {
  keyword: string;
  condition: IrCondition;
  /** The kind of fact the condition is about, for looking it up in what is known: `Password` + `INVALID`. */
  fact?: { subject: string; state: string };
  negated: boolean;
  original: string;
}

export type Given = 'TRUE' | 'FALSE' | 'UNKNOWN';

export interface LineConditional {
  conditional: ParsedConditional;
  /** What is known about the condition from the facts established so far (CD-02). */
  given: Given;
  because: string;
}

export interface LineResult {
  steps: ParsedStep[];
  expectations: ParsedExpectation[];
  conditionals: LineConditional[];
  /** What the line emits, in order: an expectation belongs after the last step before it (GR-04, GR-09, GR-10). */
  sequence: Array<{ kind: 'step' | 'expect'; index: number; clause: number }>;
  notes: string[];
  issues: Array<Omit<Issue, 'where'>>;
  models: GrammarModel[];
}
