import { SPECS } from '../../../src/validations/registry';

const FAMILY: Record<string, string> = {
  A: 'Page and navigation',
  B: 'Elements and their state',
  C: 'Text and content',
  D: 'Forms and input',
  E: 'Messages, dialogs and loading',
  F: 'Layout and look',
  G: 'Tables and lists',
  H: 'Requests the page sends',
  I: 'Health',
  J: 'Session and cookies',
  K: 'Stored values',
  L: 'Accessibility',
  M: 'Speed',
  N: 'Files',
  O: 'Calculated values',
  P: 'Timing',
};

/** Every check the platform understands, with the words that work. It is built from the checks themselves, so it is always current. */
function Checks() {
  const groups = new Map<string, typeof SPECS>();
  for (const spec of SPECS) {
    const key = spec.id.replace('VAL-', '')[0];
    groups.set(key, [...(groups.get(key) ?? []), spec]);
  }
  return (
    <>
      <h2>Checks you can write</h2>
      <p className="muted">
        Write them in the Expected Result, or as a step that starts with Verify, Validate, Check or Ensure. A check that is not understood is shown to you with
        these examples, so you can rewrite it.
      </p>
      <p>
        <strong>Parts of the page:</strong> "Login section", "login form" or just "login" means the part of the page that holds the login fields. If it could
        mean different parts in different places, you are asked to click the one you mean, once.
      </p>
      {[...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, specs]) => (
          <details key={key}>
            <summary>
              <strong>{FAMILY[key] ?? key}</strong> <span className="muted">({specs.length})</span>
            </summary>
            <div className="table-wrap">
              <table>
                <tbody>
                  {specs.map((spec) => (
                    <tr key={spec.id}>
                      <td style={{ width: '14rem' }}>{spec.title}</td>
                      <td>
                        {spec.examples.slice(0, 3).map((e) => (
                          <div key={e}>
                            <code>{e}</code>
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
    </>
  );
}

/** The test case writing guide for testers (FR-QC-05, SPEC §11). */
export function GuidePage() {
  return (
    <section className="panel" style={{ maxWidth: '90ch' }}>
      <h1>Writing test cases that automate well</h1>
      <p className="muted">The platform follows what you write and never guesses. These rules keep it from having to ask.</p>
      <ol className="stack">
        <li>
          <strong>One action per step.</strong> "Enter email and click Continue" is two steps.
        </li>
        <li>
          <strong>Use the exact text on the screen</strong> for buttons, links and fields: "Click <em>Browse Opportunities</em>".
        </li>
        <li>
          <strong>Say where the test starts.</strong> First step "Open Home page", or a precondition such as "On Registration page".
        </li>
        <li>
          <strong>Put data in the Test Data column</strong> as <code>Field=value</code>, not inside the step.
        </li>
        <li>
          <strong>Write checks you can see:</strong> Error "This email is already registered" is shown, not "works correctly".
        </li>
        <li>
          <strong>Avoid vague words:</strong> "as applicable", "equivalent", "etc.", "reach X step".
        </li>
        <li>
          <strong>Negative tests say what must not happen:</strong> "User stays on the OTP page".
        </li>
        <li>
          <strong>Never type a password into a step or the sheet.</strong> "Enter password" uses the project's test user. For a wrong one, add{' '}
          <code>Wrong Password=…</code> to Test Data and write "Enter wrong password"; set <code>TEST_WRONG_PASSWORD</code> in the project settings.
        </li>
      </ol>
      <h2>What the statuses mean</h2>
      <ul>
        <li>
          <strong>PASS</strong>: every check passed.
        </li>
        <li>
          <strong>FAIL</strong>: a check failed, an element was missing, or the page showed errors.
        </li>
        <li>
          <strong>BLOCKED</strong>: the test could not run (a value missing, the app unreachable, the login in a precondition failed).
        </li>
        <li>
          <strong>NEEDS REVIEW</strong>: a step or check could not be read or matched. Fix the row, or answer the review queue.
        </li>
      </ul>
      <Checks />
    </section>
  );
}
