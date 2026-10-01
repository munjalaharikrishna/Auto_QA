# Auto QA: Implementation Plan

How the rest of [SPEC.md](SPEC.md) gets built. V1 is planned in detail by milestone; V2–V4 in order only. Decisions referenced as D… are in SPEC §4.

**Approach:** M4–M6b build the whole flow as command line tools first (parse → explore → generate → run → report, then a whole workbook at once). M7 then puts a web UI on parts that already work.

## Step 0: housekeeping

- Merge the open branches; CI then runs the browser tests on Linux for the first time.
- Mark FR-IN-03 done (the M2 parser splits numbered steps, with tests).
- Build a **local demo app** (`examples/demo-app`): login → dashboard, a form, a table, a dialog, a disabled button, a slow page. End-to-end tests run against it without internet. saucedemo and the-internet stay for manual checks.

## M4: explore one test case (FR-EX-02…09)

`npm run explore -- examples/test-cases.json --id TC-LOGIN-001`

| # | Work | Requirements |
|---|---|---|
| 1 | Step state machine: LOCATE → VALIDATE → ACT → VERIFY_EFFECT → SETTLE → DONE, using the M3 engine for LOCATE/VALIDATE | FR-EX-02 |
| 2 | **Pausable**: NEEDS_REVIEW waits for a resolver with the browser open. The CLI resolver asks in the terminal; M7 plugs in pick-element without changing the controller | FR-EX-02, FR-RV-02 later |
| 3 | Actions → MCP tools (ARCHITECTURE §5.1); values from env, data, literal, generators | FR-EX-03, FR-PA-10 |
| 4 | The code MCP reports after an action is an extra locator candidate | FR-LO-07 |
| 5 | Verify effect; settle (network idle 500 ms + two identical snapshots, with a timeout) | FR-EX-04, FR-EX-05 |
| 6 | Checks: locate their targets at their place in the run order; evaluated in M6. A negative check on a missing element gets a flagged, unvalidated locator | FR-PA-07/08 |
| 7 | Page names: the first step's page is `BASE_URL`; any later page name asks for its URL (D19) | FR-ENV-01 |
| 8 | Preconditions: fresh context; "Logged in" runs the default login first | FR-PF-01 |
| 9 | Production needs confirmation; Chromium only; a screenshot per step | FR-EX-07…09 |
| 10 | Output: exploration JSON (per step: locator, scores, fingerprint, page, screenshot, effect) | input to M5 |

**Done when** TC-LOGIN-001/002/003, TC-CHK-001 and TC-DD-001 explore end to end, and the demo-app tests pass in CI.

## M5: code generation (FR-GE-01…06, 10, 11)

| # | Work | Requirements |
|---|---|---|
| 1 | Handlebars templates + Prettier; golden-file tests prove the output is byte-identical | FR-GE-01, FR-GE-06 |
| 2 | Page Objects with action methods grouped by fixed rules | FR-GE-02, FR-GE-10, FR-GE-11 |
| 3 | `locators/<page>.locators.json`, one per Page Object | FR-LR-01, D16 |
| 4 | Specs with `test.step('S2: …')`; secrets only as `process.env.X!`; `.env.example` | FR-GE-03, FR-GE-04 |
| 5 | Config, `package.json`, fixtures, `data/*.data.ts`, git-ignored `reports/` | FR-GE-05, FR-TD-03, D15 |
| 6 | Automation IDs `AUTO-…` | FR-EN-06 |

**Done when** the generated login project runs on its own with `npx playwright test` and matches the document's §10 example.

## M6: execution, expected vs actual, evidence

| # | Work | Requirements |
|---|---|---|
| 1 | Run `npx playwright test` with the environment's variables; credentials only in `.env` | FR-RUN-01, FR-RUN-03, FR-ENV-01, FR-ENV-05 |
| 2 | Custom reporter streaming step events | FR-RUN-02 |
| 3 | Expected / actual / result per check; actual from captured facts (URL, heading, alerts) | FR-VAL-01…03 |
| 4 | Health check fixture; screenshot and details on failure | FR-VAL-04, FR-EV-01 |
| 5 | Masking everywhere; basic failure labels | FR-EV-03, FR-FC-01 (V1 level) |
| 6 | Execution IDs `EXEC-YYYY-NNNNN` | FR-EN-06 |

**Done when** `npm run auto-qa -- … --id TC-LOGIN-001` goes from parse to a PASS/FAIL report, and a broken login fails with a correct expected vs actual.

## M6b: batch run of a workbook (FR-IN-01, FR-IN-08, FR-IN-09, FR-HI-06, FR-HI-07)

`npm run auto-qa -- tests.xlsx --base-url https://app.example.com`

| # | Work | Requirements |
|---|---|---|
| 1 | Excel/CSV import with ExcelJS; headers matched to the §5 fields by name and synonyms, plus a saved mapping file | FR-IN-01, FR-IN-09, D21 |
| 2 | Batch runner: each case in a fresh context through parse → explore → generate → run | FR-IN-08 |
| 3 | Never wait (D22): the CLI resolver in batch mode sets the case aside as NEEDS REVIEW and records the question | D22 |
| 4 | Login once: "Logged in" cases reuse the sheet's login case | FR-PF-01 |
| 5 | Progress file: stop and resume, skipping finished cases; `--only-review` re-runs the review queue | FR-IN-08 |
| 6 | Write `<name>.results.xlsx`: Status, Actual Result, Failed Step, Executed At, Automation ID, Evidence; original formatting kept | FR-HI-06, D23 |
| 7 | Summary with totals and the review queue | FR-HI-07, FR-VAL-05 |

**Done when** a 100-row sheet (generated from the demo app, with some deliberately vague and some failing cases) runs to the end unattended and the results file shows the right status and actual result on every row.

## M7: web UI (D20: React + Fastify + SQLite)

- **M7a server:** Fastify API, job runner, WebSocket, SQLite with a default user (§3). The CLI steps become jobs.
- **M7b UI:**
  - The M6b batch run on screen: upload, progress, review queue (FR-IN-08); column mapping screen (FR-IN-02)
  - Single test case form with run settings (FR-IN-04)
  - Review: steps, scores, screenshots, code diff, Approve & Execute / Edit / Regenerate (FR-RV-01, 03, 04, 05)
  - **Pick element on screenshot** (FR-RV-02): the paused exploration maps the click to an element with `elementFromPoint`, then the same ladder and validation
  - Result screen (FR-HI-01), writing guide (FR-QC-05), `AssistProvider` no-op (FR-AI-01)

**Done when** a tester imports a sheet, reviews a test, picks an ambiguous element, approves and sees PASS/FAIL, all in the browser.

## M8: database foundation (D24–D28, [DATABASE.md](DATABASE.md))

Moves every piece of state that is only in a JSON file into the database, adds versioned migrations, and leaves room for V2–V4. Nine steps are in [DATABASE.md §10](DATABASE.md#10-build-plan-m8) (driver and migrations, repositories, environments and page routes, test case versions, explorations, executions and results, evidence and storage references, reads from the database, `db` commands).

**Done when** a fresh install and the current `.auto-qa/auto-qa.db` reach the same schema, a workbook run leaves no state only in JSON files (other than artifacts), and CI upgrades a database from the previous release.

## After V1

1. **V2:** locator repository reuse → environments + page map → encrypted secrets → login state reuse → suites, history, HTML report → flows, unique data → table steps → re-discovery → API tests → Jira/TestRail import
2. **V3:** failure classifier + controlled retry → locator recovery → Firefox/WebKit, parallel, mobile → team mode (Docker, PostgreSQL, roles)
3. **V4:** traceability → API + UI hybrid → Jira defects and result sync → CI/CD, schedules → dashboards → Cucumber

## Risks

| Risk | Mitigation |
|---|---|
| Settle rule flaky on slow apps | Per-project timeouts; a slow page in the demo app |
| Playwright MCP alpha changes | Pinned versions; tool-list test (in place) |
| Odd action method names | Golden tests; names shown in review; renamable in Edit |
| M7 is the largest milestone | M4–M6 work fully from the CLI first |
