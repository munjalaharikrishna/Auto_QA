/**
 * Plain-language reasons (the tester's wording, not ours). Every place that sets a step aside, asks a
 * question or marks a case NEEDS REVIEW passes through here, so the screen says exactly what happened
 * and what to do about it instead of showing an internal code.
 */

export interface Explanation {
  /** One short sentence: what is wrong. */
  headline: string;
  /** Why, with the facts we have (what was on the page, what was closest). */
  why: string;
  /** What the tester can do, most useful first. */
  todo: string[];
}

export interface ExplainInput {
  code: string;
  /** The step or check as the tester wrote it. */
  raw?: string;
  /** The element name the step looked for. */
  label?: string;
  /** The internal message, used when no better wording exists. */
  text?: string;
  /** What was found nearest, best first. */
  candidates?: Array<{ role?: string; name: string; score: number }>;
  /** Page name, for unknown-URL and wrong-page cases. */
  page?: string;
}

const pct = (score: number) => `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
const quoted = (s?: string) => (s ? `"${s}"` : 'it');

/** What a step or check looks like in the lists: `S2 "enter username"`. */
export function labelled(id: string, raw: string): string {
  return raw ? `${id} "${raw}"` : id;
}

export function explain(input: ExplainInput): Explanation {
  const { code, raw, label, text, candidates = [] } = input;
  const best = candidates[0];
  const name = label ?? '';

  switch (code) {
    case 'NO_MATCH':
      return {
        headline: `I could not find ${quoted(name)} on the page.`,
        why: best
          ? `The closest thing is the ${best.role ?? 'element'} "${best.name}", but it matches only ${pct(best.score)}, which is too weak to trust. Clicking the wrong thing would give a wrong PASS or FAIL.`
          : 'Nothing on this page looks like it. The page may not have opened yet, or an earlier step may not have worked.',
        todo: [
          best ? `If "${best.name}" is the one you mean, click it on the screenshot.` : 'Click the right element on the screenshot.',
          name
            ? `Or rewrite the step with the name that is shown on the screen, for example: Enter ${name} in "${best?.name ?? 'the field name'}" field.`
            : 'Or rewrite the step with the name that is shown on the screen.',
          'Or skip this step if it is not needed.',
        ],
      };
    case 'AMBIGUOUS':
      return {
        headline: `More than one element matches ${quoted(name)}.`,
        why: `${candidates.length > 1 ? `${Math.min(candidates.length, 5)} elements` : 'Several elements'} fit about equally well (${candidates
          .slice(0, 3)
          .map((c) => `${c.role ?? 'element'} "${c.name}"`)
          .join(', ')}), and guessing could test the wrong one.`,
        todo: ['Click the right one on the screenshot.', 'Or make the step more exact, for example by adding the section or the button text.'],
      };
    case 'AMBIGUOUS_PART':
      return {
        headline: `"${name || 'it'}" could mean different parts of the page.`,
        why: `${candidates.length > 1 ? `${Math.min(candidates.length, 5)} parts of the page` : 'Several parts of the page'} hold it (${candidates
          .slice(0, 3)
          .map((c) => `${c.role ?? 'part'}${c.name ? ` "${c.name}"` : ''}`)
          .join(', ')}) and they are in different places, so the check would pass for one and fail for another.`,
        todo: [
          'Click the part you mean on the screenshot, for example the whole panel, not just the fields inside it.',
          'Or name it more exactly in the check.',
        ],
      };
    case 'NEEDS_VALUE':
      return {
        headline: 'This step needs a value that was not given.',
        why: `${text ?? ''} The project policy is Strict, so values are not made up.`.trim(),
        todo: ['Add the value to the Test Data column, for example Invalid Username=…', 'Or change the project policy to Balanced in Settings.'],
      };
    case 'LEARNED':
      return {
        headline: `The application showed "${text ?? ''}" and I would use it as the expected message.`,
        why: 'The expected result did not give the exact text. The project policy is Strict, so a text taken from the application is not used until you say so.',
        todo: [
          `Write the message in the expected result: Error "${text ?? '…'}" is shown.`,
          'Or change the project policy to Balanced in Settings, which uses it and lists it as learned.',
        ],
      };
    case 'CANNOT_PIN':
    case 'NO_VALID_LOCATOR':
      return {
        headline: `I found ${quoted(name)} but cannot point to it reliably.`,
        why: 'The page gives this element nothing stable to find it by (no unique text, label or id), so a test written for it could break or click something else.',
        todo: [
          'Pick a neighbouring element that is easier to identify on the screenshot.',
          'Or ask the developers for a test id (data-testid) on this element.',
        ],
      };
    case 'NO_EFFECT':
      return {
        headline: `Nothing happened after ${quoted(raw)}.`,
        why: 'I did the step but the page, the URL and the field values stayed exactly the same. The step may have clicked the wrong thing, or the page needs something else first.',
        todo: ['Answer Yes if nothing is supposed to change here.', 'Answer No to stop, then check the step and the order of the steps.'],
      };
    case 'NOT_ON_PAGE':
      return {
        headline: `The browser is not on the page the test expects${input.page ? ` (${input.page})` : ''}.`,
        why: text ?? 'An earlier step probably did not work, for example the login failed or a button was not clicked.',
        todo: ['Answer Yes only if this really is the expected page.', 'Answer No to stop and look at the earlier steps and their screenshots.'],
      };
    case 'PRODUCTION':
      return {
        headline: 'This looks like a live (Production) site.',
        why: 'Exploring really clicks buttons and types into fields, so it can change real data.',
        todo: ['Continue only if the test is safe to run on live data.', 'Otherwise stop and use a test environment.'],
      };
    case 'NO_LOGIN':
      return {
        headline: 'The test starts "logged in", but there is no login test case to run first.',
        why: 'Without it the browser starts on the login page, so the first real step will not find what it needs.',
        todo: ['Add a test case that logs in and use it as the project login.', 'Or continue and log in with the steps of this test.'],
      };
    case 'FLOW_V2':
      return {
        headline: 'This test starts from a reusable step group, which is not supported yet.',
        why: 'Reusable flows arrive in a later version.',
        todo: ['Continue from the first step of the test.', 'Or write the setup steps into this test case.'],
      };
    case 'PAGE_URL':
      return {
        headline: `I do not know the web address of the ${input.page ?? 'named'} page.`,
        why: 'I will not guess an address, because a wrong one would test the wrong page. You only need to tell me once; it is remembered.',
        todo: [`Enter the address, for example /${(input.page ?? 'page').toLowerCase().replace(/\s+/g, '-')} or the full URL.`],
      };
    case 'DIALOG':
      return {
        headline: 'The page showed a pop-up message.',
        why: text ?? 'A browser message box opened and was closed automatically so the test could continue.',
        todo: ['Add a check for it if it matters, for example: A message "…" is shown.'],
      };
    // Steps and checks that could not be read.
    case 'NO_ACTION':
      return {
        headline: `I cannot tell what to do in ${quoted(raw)}.`,
        why: 'The step does not start with an action word, and it does not read like a check either.',
        todo: [
          'Start with what the user does: Click, Enter, Select, Open, Check, Uncheck, Upload, Press.',
          'To check something instead, start with Verify or Validate, for example: Verify the login box is in the middle of the page.',
        ],
      };
    case 'NO_TARGET':
      return {
        headline: `${quoted(raw)} does not say which element to use.`,
        why: text ?? 'An action needs a name from the screen, such as the button text or the field label.',
        todo: ['Add the name shown on the screen, for example: Click "Login" button.'],
      };
    case 'MULTIPLE_ACTIONS':
      return {
        headline: `${quoted(raw)} contains more than one action.`,
        why: text ?? 'Each step should do one thing, so a failure points at one place.',
        todo: ['Split it into separate numbered steps.'],
      };
    case 'UNKNOWN_KEY':
      return {
        headline: `${quoted(raw)} names a key I do not know.`,
        why: text ?? 'Key names are like Enter, Tab, Escape or Control+A.',
        todo: ['Use one of those key names.'],
      };
    case 'VAGUE_CHECK':
      return {
        headline: `${quoted(raw)} is too general to check.`,
        why: text ?? 'Words like "works", "correctly" or "as expected" do not say what to look at on the screen.',
        todo: ['Say what the user sees, for example: Error "Invalid credentials" is shown, or User is redirected to Dashboard.'],
      };
    case 'NO_PATTERN':
      return {
        headline: `I could not understand the check ${quoted(raw)}.`,
        why: text ?? 'It does not match any check I know.',
        todo: [
          'Examples: Dashboard heading is displayed. Error "…" is shown. User is redirected to Dashboard. Login button is disabled.',
          'Layout and look: Login form is in the middle of the page. Logo is at the top left. Cancel is to the left of Save. Save button is blue.',
          'Counts, tables and messages: 6 products are shown. Table columns are Name, Email. A toast "Saved" appears. Clicking Save calls POST /api/users.',
          'The Writing guide (top of the page) lists every check with examples.',
        ],
      };
    case 'MODAL':
      return {
        headline: 'A pop-up message blocked the next action.',
        why: text ?? 'The page opened a browser message box (alert or confirm).',
        todo: ['This is now closed automatically; run it again.'],
      };
    default:
      return {
        headline: text ? firstSentence(text) : `${quoted(raw)} needs your attention.`,
        why: text ?? 'No further detail is available.',
        todo: ['Look at the step and its screenshot, then edit the test case or skip the step.'],
      };
  }
}

/** The explanation as sentences for a log line or a results sheet. */
export function sentence(e: Explanation): string {
  return `${e.headline} ${e.why} ${e.todo[0] ?? ''}`.replace(/\s+/g, ' ').trim();
}

/** Technical tool messages made readable. */
export function plainError(message: string): string {
  const m = message.replace(/^Error:\s*/, '');
  if (/does not handle the modal state|modal state/i.test(m)) return 'A pop-up message (alert) was open and blocked the next action.';
  if (/Target (page|closed)|has been closed|browser has been closed/i.test(m)) return 'The browser window was closed while the test was running.';
  if (/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(m)) return 'The web address could not be found. Check the URL in the project settings.';
  if (/net::ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(m)) return 'The application did not answer. Is it running?';
  if (/timeout .* exceeded|Timeout \d+ms/i.test(m)) return 'The page or element did not appear in time.';
  return m.split('\n')[0];
}

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  return m ? m[1] : text;
}
