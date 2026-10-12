/**
 * Small fixed shapes the rest of the engine needs (ids, names, line splitting). They live here because regular
 * expressions are allowed only in this layer (RX-01). Each is a plain function so no other layer sees a RegExp.
 */

const STATE_NAME = /^[A-Z][A-Z0-9_]*$/;
const STEP_ID = /^S\d+(\.\d+)?$/;
const EXPECTATION_ID = /^E\d+$/;
const ASSUMPTION_ID = /^A\d+$/;
const DATA_REF = /^\$data\.(\w+)$/;
const SECRET_NAME = /PASS(WORD)?|SECRET|TOKEN|API_?KEY|PIN|OTP/i;

export const isStateName = (s: string): boolean => STATE_NAME.test(s);
export const isStepId = (s: string): boolean => STEP_ID.test(s);
export const isExpectationId = (s: string): boolean => EXPECTATION_ID.test(s);
export const isAssumptionId = (s: string): boolean => ASSUMPTION_ID.test(s);
export const isSecretName = (s: string): boolean => SECRET_NAME.test(s);

/** `$data.user` → `user`; anything else → undefined. */
export const dataRefKey = (s: string): string | undefined => DATA_REF.exec(s)?.[1];

/** `UPPER_SNAKE` made of the letters and digits of a text, never starting with a digit. */
export function upperSnake(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The first run of digits as a number, 0 when there is none. */
export const firstNumber = (s: string): number => Number(/\d+/.exec(s)?.[0] ?? 0);

/** Every run of non-word characters replaced by one underscore, lower case. */
export const lowerSnake = (s: string): string => s.replace(/\W+/g, '_').toLowerCase();

/** The non-blank lines of a cell. */
export const nonBlankLines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.trim());

/** A key of the `data` table: the words of a test-data name joined by underscores (`Wrong Password` → `Wrong_Password`). */
export const dataKeyOf = (name: string): string =>
  name
    .trim()
    .replace(/\W+/g, '_')
    .replace(/^_+|_+$/g, '');

const STEP_LINE = /^\s*(?:step\s*)?(\d{1,3})\s*[.):-]\s*(\S.*)$/i;

/** One line of a Steps cell: the tester's number when it has one (`1.`, `2)`, `Step 3:`), and the text after it. */
export function splitStepLine(line: string): { number?: number; text: string } {
  const m = STEP_LINE.exec(line);
  return m ? { number: Number(m[1]), text: (m[2] as string).trim() } : { text: line.trim() };
}

const KEY_SUFFIX = /_(valid|invalid|blank|empty|existing|maximum|minimum|boundary|random|generated|value)$/i;

/** The field a data key was made for: `Last_name_valid` → `Last name`. */
export const fieldFromKey = (key: string): string => key.replace(KEY_SUFFIX, '').split('_').join(' ');
