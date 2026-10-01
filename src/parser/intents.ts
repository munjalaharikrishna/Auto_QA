import type { ParsedAssertion } from './assertions.js';
import type { ParserConfig } from './config.js';
import { extractTarget } from './target.js';
import { hasProtectedQuote, protectQuotes, unquote } from './text.js';

/**
 * Outcome intents (REAL-WORLD-TEST-CASES.md §5, FR-PA-18): testers describe outcomes, not checks.
 * "Login is rejected" and "an appropriate error message is displayed" become concrete checks here, before the
 * words are taken apart as element names (RW-L05). What the tester did not say (the exact message) is learned
 * from the application in exploration, and only if it agrees with the intent (D31).
 */

const BE = '(?:is|are|was|were|be|gets|get|being)';
const SUCCESSFULLY = '(?:successfully\\s+|properly\\s+|correctly\\s+)?';

const LOGIN = '(?:log[- ]?in|sign[- ]?in|authentication|authorization)';
const LOGGED_IN = '(?:logged[- ]in|signed[- ]in|authenticated)';

/** The names in "username and password", "Login Name, Password and Email". */
function names(list: string, config: ParserConfig, restore: (s: string) => string): ParsedAssertion[] {
  return list
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((n) =>
      restore(n)
        .replace(/^(?:both|all|the)\s+/i, '')
        .trim(),
    )
    .filter(Boolean)
    .map((n) => {
      const t = extractTarget(n, config);
      return {
        alternatives: t.alternatives,
        target: t.target,
        exact: t.exact,
        roleHint: t.roleHint ?? 'textbox',
        negated: false,
        warnings: t.warnings,
      } as ParsedAssertion;
    });
}

/**
 * One sentence → the checks of its intent, or undefined if it is not an intent. `sentence` has its quotes protected;
 * `restore` puts them back. `negated` is whether the sentence said "not" somewhere (the words are still in it).
 */
export function parseIntent(sentence: string, config: ParserConfig, restore: (s: string) => string): ParsedAssertion[] | undefined {
  const s = sentence.replace(/^(?:the\s+)?(?:user|system|application|app)\s+/i, '').trim();
  const make = (intent: string, over: Partial<ParsedAssertion>): ParsedAssertion[] => [
    { alternatives: [], negated: false, warnings: [], intent, ...over } as ParsedAssertion,
  ];

  // LOGIN_REJECTED: "login is rejected", "login fails", "user is not logged in", "should not be able to log in".
  if (
    new RegExp(`^${LOGIN}\\s+(?:${BE}\\s+)?(?:rejected|denied|refused|blocked|unsuccessful|failed|fails?)$`, 'i').test(s) ||
    new RegExp(`^(?:${BE}\\s+)?not\\s+(?:${LOGGED_IN}|able to\\s+${LOGIN}|allowed to\\s+${LOGIN})(?:\\s+in)?$`, 'i').test(s) ||
    new RegExp(
      `^(?:cannot|can't|can not|should not be able to|unable to|is unable to|is not able to|should not)\\s+(?:be\\s+)?(?:${LOGIN}|${LOGGED_IN})(?:\\s+in)?$`,
      'i',
    ).test(s)
  ) {
    return make('LOGIN_REJECTED', { type: 'url-unchanged', raw: undefined } as Partial<ParsedAssertion>);
  }

  // LOGIN_SUCCESS without a page: "login is successful", "user is logged in", "is able to log in".
  if (
    new RegExp(`^${LOGIN}\\s+(?:${BE}\\s+)?(?:successful|successfully|a success|ok|completed)$`, 'i').test(s) ||
    new RegExp(`^(?:${BE}\\s+)?${SUCCESSFULLY}${LOGGED_IN}(?:\\s+(?:in|successfully|to the application))*$`, 'i').test(s) ||
    new RegExp(`^(?:${BE}\\s+)?able to\\s+${LOGIN}(?:\\s+successfully)?$`, 'i').test(s)
  ) {
    return make('LOGIN_SUCCESS', { type: 'url-unchanged', negated: true });
  }

  // ERROR_SHOWN: "an appropriate error message is displayed", "a validation message appears". Quoted text is a text check, not an intent.
  const GOOD = '(?:appropriate|proper|relevant|suitable|meaningful|valid|correct|helpful|clear|corresponding|respective|specific|new|visible)';
  if (
    !hasProtectedQuote(s) &&
    new RegExp(
      `^(?:an?\\s+|the\\s+|some\\s+)?(?:${GOOD}\\s+)*(?:error|validation|warning|failure)(?:\\s+(?:message|msg|text|notification|banner|alert))?s?\\s+(?:${BE}\\s+)?(?:displayed|shown|visible|raised|presented|appears?|seen|received)$`,
      'i',
    ).test(s)
  ) {
    return make('ERROR_SHOWN', { type: 'error-shown' });
  }

  // FIELD_CLEARED: "Both username and password fields are cleared", "Login Name and Password boxes are empty".
  const cleared = new RegExp(
    `^(?:both\\s+|all\\s+)?(?<list>.+?)\\s+(?:text\\s+)?(?:fields?|boxes|text boxes|inputs?)\\s+${BE}\\s+(?:cleared|empty|blank|reset|emptied)$`,
    'i',
  ).exec(s);
  if (cleared?.groups?.list) {
    const parts = names(cleared.groups.list, config, restore);
    if (parts.length) return parts.map((p) => ({ ...p, type: 'value' as const, expected: '', intent: 'FIELD_CLEARED' }));
  }

  // MASKED: "the password is displayed as masked characters", "password is shown as dots", "characters are masked".
  const masked = new RegExp(
    `^(?:the\\s+)?(?<s>.+?)\\s+(?:text\\s+|value\\s+|characters?\\s+)?${BE}\\s+(?:displayed\\s+|shown\\s+|entered\\s+|typed\\s+|visible\\s+)?(?:as\\s+)?(?:masked|encrypted|dots|asterisks?|bullets|stars|hidden characters)(?:\\s+(?:characters?|chars|text))?$`,
    'i',
  ).exec(s);
  if (masked?.groups?.s) {
    const t = extractTarget(restore(masked.groups.s).replace(/\s+(?:characters?|text|value)$/i, ''), config);
    if (t.target) {
      return make('MASKED', {
        type: 'attribute',
        target: t.target,
        alternatives: t.alternatives,
        exact: t.exact,
        roleHint: 'textbox',
        expected: 'password',
        options: { name: 'type' },
        warnings: t.warnings,
      });
    }
  }
  return undefined;
}

void protectQuotes;
void unquote;
