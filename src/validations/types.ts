import type { Assertion, AssertionOptions, AssertionType } from '../model/test-model.js';
import type { ParserConfig } from '../parser/config.js';
import type { Target } from '../parser/target.js';

/**
 * One kind of check (VALIDATIONS.md §2.1): the words a tester writes it in, the Playwright code it
 * becomes and the sentence it reports. Adding a check means adding one of these to a family file and
 * its examples to the test; nothing else in the platform changes.
 */

export interface ParseContext {
  /** The check after "Verify", "should" and the negation were taken off. Quoted text is protected: use `value`. */
  text: string;
  /** The tester wrote "not"/"does not"…: the opposite of what the sentence says. */
  negated: boolean;
  config: ParserConfig;
  /** The text with its quotes back, unquoted when the whole piece is one quote ("Saved" → Saved). */
  value(protectedText: string): string;
  /** Whether the piece holds quoted text. */
  quoted(protectedText: string): boolean;
  /** Names an element: "the Login button" → target Login, role button. */
  name(raw: string): Target;
  /** Names a part of the page: "login form" / "login section" / "the login box" → target login, role form. */
  container(raw: string): Target;
}

export interface TargetFields {
  target?: string;
  alternatives: string[];
  exact?: boolean;
  roleHint?: string;
}

/** What a spec's `parse` returns. `negated` replaces the tester's own "not" when the sentence flips it. */
export interface Parsed {
  /** Only when the sentence is a different check than the spec's own type (e.g. "disappears" is a negated visible). */
  type?: AssertionType;
  target?: Target;
  other?: Target;
  expected?: string;
  options?: AssertionOptions;
  negated?: boolean;
}

export interface CodeContext {
  /** The checked element, as a Page Object member (`loginPage.loginForm`). */
  target(): string;
  /** The second element, as an inline locator (`page.getByRole('button', …)`). */
  other(): string;
  quote(text: string): string;
  escapeRegex(text: string): string;
  /** Imports the spec needs from the test fixture (helper functions of the matcher file). */
  helpers: Set<string>;
}

export interface ValidationSpec {
  /** The catalogue number, e.g. VAL-F01. */
  id: string;
  type: AssertionType;
  title: string;
  /** How many elements exploration must find: none (page-level), one, or two (one compared with another). */
  targets: 'none' | 'one' | 'two';
  /** The element is a part of the page (a form, a table, a section), so exploration also looks at structure. */
  container?: boolean;
  parse(ctx: ParseContext): Parsed | undefined;
  /** Lines of Playwright code, awaited, in order. */
  code(a: Assertion, c: CodeContext): string[];
  /** What is reported when the check passed, e.g. `"Login form" was in the middle of the screen`. */
  passed(a: Assertion): string;
  /** Sentences the parser must understand: the examples in VALIDATIONS.md. Tested one by one. */
  examples: string[];
}

export type Compare = 'eq' | 'gte' | 'lte' | 'gt' | 'lt';
