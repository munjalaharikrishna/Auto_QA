import { parseAssertions } from '../parser/assertions.js';
import { defaultParserConfig } from '../parser/config.js';
import { ruleProblem } from '../parser/rule-check.js';
import { ruleKey } from '../parser/rules.js';
import type { ApprovalPayload, LabelPayload, ReadingPayload, ValidationRecord } from './entries.js';

/**
 * The checks an entry passes before it can change a run. They are made when it is saved or migrated, and again each time a run
 * reads it (`adapter.ts`), so a row changed by hand in the database does not get past them. A check never guesses: what cannot be
 * shown is `pending`, not `active`.
 */

export const VALIDATOR = 'learning-validate/1';

export type Outcome = { status: 'active' | 'pending' | 'quarantined'; validation: ValidationRecord };

/** Words, lower case, without punctuation: two spellings of one name compare equal. */
export function norm(text: string): string {
  let out = '';
  let space = true;
  for (const c of text.toLowerCase()) {
    const word = c.toLowerCase() !== c.toUpperCase() || (c >= '0' && c <= '9');
    if (word) {
      out += c;
      space = false;
    } else if (!space) {
      out += ' ';
      space = true;
    }
  }
  return out.trim();
}

/** Words that name an action. A tester's word for one of them cannot mean the name of a different one ("save" is not the "Edit" button). */
const ACTION_WORDS: ReadonlySet<string> = new Set([
  'save',
  'edit',
  'delete',
  'remove',
  'add',
  'create',
  'update',
  'submit',
  'cancel',
  'close',
  'search',
  'login',
  'log in',
  'logout',
  'log out',
  'reset',
  'clear',
  'next',
  'back',
  'upload',
  'download',
  'confirm',
  'apply',
  'ok',
]);

const MAX_MEANS_WORDS = 6;

const record = (checks: string[], problem?: string): ValidationRecord => ({
  ok: problem === undefined,
  checks,
  ...(problem ? { problem } : {}),
  validator: VALIDATOR,
});

/** The structural checks of a label. These alone never make it active: see `validateLabel`. */
export function labelProblem(p: LabelPayload): string | undefined {
  const label = norm(p.label);
  const means = norm(p.means);
  if (!label) return 'The words the tester writes are empty.';
  if (!means) return 'The name on the screen is empty.';
  if (label === means) return 'The label says the same thing as the name it is for.';
  if (p.means.length > 80 || means.split(' ').length > MAX_MEANS_WORDS) return `"${p.means}" is too long to be the name of one element.`;
  if (ACTION_WORDS.has(label) && ACTION_WORDS.has(means)) return `"${p.label}" is an action; it cannot be the name of a different action, "${p.means}".`;
  return undefined;
}

/**
 * A label is active only when the application was seen to show that name (`knownNames`, from what earlier runs saw). A label for a
 * name nobody has seen is a guess, so it waits as `pending` for a person.
 */
export function validateLabel(p: LabelPayload, knownNames?: ReadonlySet<string>): Outcome {
  const problem = labelProblem(p);
  if (problem) return { status: 'quarantined', validation: record(['structure'], problem) };
  if (knownNames?.has(norm(p.means))) return { status: 'active', validation: record(['structure', `the application shows "${p.means}"`]) };
  return {
    status: 'pending',
    validation: {
      ok: true,
      checks: [
        'structure',
        knownNames ? `"${p.means}" was not seen on the application's pages` : 'the application has not been explored: its names are not known',
      ],
      problem: 'Not shown to be a name the application has: a person has to confirm it.',
      validator: VALIDATOR,
    },
  };
}

/**
 * A reading rewrites a sentence for every test case that uses it, so it must read as a real step or a check that judges something
 * (`ruleProblem`, the check of S3). It is re-checked every time a run reads it.
 */
export function readingProblem(p: ReadingPayload): string | undefined {
  if (p.readingKind !== 'step' && p.readingKind !== 'check') return `"${p.readingKind}" is not a kind of reading.`;
  if (!norm(p.from)) return 'The sentence that is read differently is empty.';
  const problem = ruleProblem({ kind: p.readingKind, pattern: p.from, meaning: p.to });
  if (problem || p.readingKind !== 'check') return problem;
  return polarityProblem(p);
}

/**
 * A "not shown" check passes whenever the thing is not on the page, so a rewrite that turns a sentence that expects something into
 * one that expects its absence can pass on a page that shows nothing of what was meant (the wrong PASS of 5 Oct: "Appropriate user
 * name … should shown" was read as "'Appropriate user name Password given' is not visible"). A rewrite may not add a negation the
 * tester's own sentence does not have, and may not judge only by absence.
 */
function polarityProblem(p: ReadingPayload): string | undefined {
  const plain = { ...defaultParserConfig(), rules: undefined };
  const from = parseAssertions(p.from, plain, false);
  const to = parseAssertions(p.to, plain, false);
  if (!to.some((c) => c.negated) || from.some((c) => c.negated)) return undefined;
  return to.every((c) => c.negated)
    ? `"${p.to}" is read only as something that is NOT shown, which is true on any page that does not show it, and "${p.from}" does not say that something is absent.`
    : `"${p.from}" does not say that something is absent, but "${p.to}" is read as a "not shown" check.`;
}

export function validateReading(p: ReadingPayload): Outcome {
  const problem = readingProblem(p);
  return problem
    ? { status: 'quarantined', validation: record(['reads as a real step or a check that judges something'], problem) }
    : { status: 'active', validation: record(['reads as a real step or a check that judges something', 'no example recorded']) };
}

const READ_AS = ' is read as ';
const RULE_SUFFIX = ' (a project rule)';

/** The text of an assumption split into the sentence it was made for and, for "X is read as Y (a project rule)", the reading it accepts. */
export function approvalParts(assumption: string): Pick<ApprovalPayload, 'sentence' | 'dependsOnReading'> {
  const at = assumption.indexOf(READ_AS);
  if (at < 0) return {};
  const sentence = assumption.slice(0, at).trim().replace(/\.$/, '');
  let to = assumption.slice(at + READ_AS.length).trim();
  if (!to.endsWith(RULE_SUFFIX)) return { sentence };
  to = to.slice(0, -RULE_SUFFIX.length).trim();
  return { sentence, dependsOnReading: { from: sentence, to } };
}

/**
 * An approval accepts an assumption; it is active when it says something and, if it accepts a project rule's reading, that
 * reading is active now. An approval of a reading that is quarantined, disabled or gone is void.
 */
export function validateApproval(p: ApprovalPayload, activeReadings: ReadonlyArray<{ from: string; to: string }>): Outcome {
  if (!ruleKey(p.assumption)) return { status: 'quarantined', validation: record(['says something'], 'The assumption is empty.') };
  if (!p.dependsOnReading) return { status: 'active', validation: record(['says something', 'accepts an assumption of the platform, not a rule']) };
  const want = { from: ruleKey(p.dependsOnReading.from), to: ruleKey(p.dependsOnReading.to) };
  const found = activeReadings.some((r) => ruleKey(r.from) === want.from && ruleKey(r.to) === want.to);
  return found
    ? { status: 'active', validation: record(['says something', 'the reading it accepts is active']) }
    : {
        status: 'quarantined',
        validation: record(
          ['says something', 'the reading it accepts is active'],
          `It accepts that "${p.dependsOnReading.from}" is read as "${p.dependsOnReading.to}", and that reading is not active (it failed its checks, was switched off, or no longer exists).`,
        ),
      };
}
