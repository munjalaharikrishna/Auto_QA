# Changelog

Code changes by milestone. Specification changes are in [docs/SPEC.md §14](docs/SPEC.md#14-change-log).

## Unreleased

### Engine (E0.16 setup blocks, data ledger, test data; in progress)
- **Setup blocks (item 1).** The leading lines most cases of a sheet share (open the browser, open the application, check the login page, check the tabs) are found once per sheet (`src/engine/context/setup.ts`). A block only ever holds lines that are setup by kind, so a data-entry line many cases share is never taken for setup, and a line that takes its value from the Test Data is not setup either (TC_LOGIN_003 keeps its wrong password). Nothing is removed from a case: each still runs and checks all it says.
  - A question about a setup line is the sheet's: the review report counts it once (`Issue.block`). A setup line that cannot be read and only restates the line before it ("Verify User should add button…" after "there should be add button") is set aside with the reason, and the check before it still runs. On Add Employee the question raised in 16 cases is raised in none; TC03, which tests that line, still asks.
  - **The login the cases assume (E7).** When the setup checks the tabs right after the login page and no line logs in, the case logs in there with the project's login (`TEST_USERNAME`, `TEST_PASSWORD`), with the fields and button of the project's login case when there is one; the login page is still checked before it, the tabs after it.
  - Batch runs read the block from the whole sheet, also when only the review queue runs; `engine:review` and `engine:lint` read it too. `engine:gold` reads each case on its own, so the signed gold readings do not change (771 of 796, as before).
- **Decisions (5 Nov 2026, PD-15):** clean-up lists what a run created and deletes nothing by itself in V1; runs stay at one worker until more test accounts exist.

### Engine (E0.15 grammar and lint)
- **Slot grammar and one verb table** replace the phrase lists (`src/engine/language/slots.ts`, `verbs.ts`); Given/When/Then, "user should", articles and known typos inside names are ignored; the parser defects of audit U6 are fixed.
- **Lint before a run** (`npm run engine:lint`): every line of a case gets one status (understood, matched, ambiguous, not found, screen not learned yet, vague, not understood) with a suggestion, also in the results workbook.
- **Measured against the owner's signed gold readings** (`npm run engine:gold`), not "no blocking error": Login 60 of 60, Add Employee 711 of 736, together 771 of 796 clauses (97%, target 90%). Re-run on 5 Nov 2026.
- Not done: 25 Add Employee clauses still read wrongly, most in TC18/TC19 (Employment section, Sub-Division, Supervisor), where the engine should ask a person.

### Engine (E0.14c record in the walkthrough, PD-14)
- **A valid email address is the project's login.** "Enter the valid Email address" was read by the new engine as "make up a valid email", so a walkthrough typed `qa.…@example.test` and the login failed. A valid email, email address, email id, user id or login id is now `TEST_USERNAME`, as the old parser already read it; a bare "Email" still needs a value.
- **The walkthrough's browser is a window you use.** While the walkthrough waits, what is done in it is recorded as steps of the case, on every page reached: clicks, typing, dropdowns, checkboxes, radios, Enter, Escape, and addresses opened by hand. Each step is kept only when both the new engine and the old parser read it back as that action on that element; the login is written as the valid username and password, never the password itself (`src/server/recorder.ts`).
- **"I did this step myself"** on a step that cannot find its element: the recorded actions take its place, and its words are remembered as the element used on that screen.
- Recorded steps can be removed before saving; they are saved with the checks, as a new version, only on a yes. `AUTO_QA_WALKTHROUGH_HEADLESS=1` hides the window.
- **The owner's first use on BookMarket (3 Nov), fixed:**
  - **One window, with the steps in it.** The browser opened a second, empty window; it is closed now. The window has a panel on the left: the steps (done, here), what was recorded, and the buttons for what the walkthrough waits on (Next step, Finish, I did this step myself, Yes or No, save). The page is moved right while the panel shows and the panel is hidden while the engine runs a step, so it covers nothing and is in no screenshot; it is in a closed shadow root, so neither the engine nor the recorder takes its buttons for the application's (`src/server/walk-panel.ts`).
  - **A recorded action is a step only once the person adds it.** Each one waits for Add or Remove, in the window and on the Auto QA page (Add all for several); one not added is not saved, and "I did this step myself" is the OK for what was done for that step. Any change can be removed at any time while the walkthrough is open (`POST /api/jobs/:id/walkthrough/pending`). Before, a field typed again by hand after the engine had typed it was saved as a second step.
  - **Closing the window ends the walkthrough, and loses nothing.** It used to fail the job and drop what was recorded. Now the save question comes on the Auto QA page.
  - **Finish** ends a walkthrough before its last step. When saving, recorded steps can replace the steps that were not run, so a flow done by hand is not followed by the old steps again.
- **A run no longer fails on a long step on Windows.** Each step's screenshot was attached as a file, which Playwright copies under a name made from the whole step text; with several steps run as one block the path passed 260 characters (`ENOENT … copyfile`). The screenshot now stays where it was taken and the reporter is told its path in a note.
- **Walkthrough on every test case:** the project's test case list has a Walkthrough button on each row, not only on review cards; it logs in first with the workbook's login case when the case's last run had one.
- Not done: double click and hover; emptying a field; values with a double quote.

### Engine (E0.14 learn the application: run capture and the guided walkthrough, PD-13)
- **No scan and no crawl.** The engine learns each screen from the runs it already makes: every observation now keeps label, placeholder, input type, ids, frame path and the element's box on the screenshot (frame offsets added), the headings, table headers and an open dialog, and a **screen key** (the content frame's address with the parameters that choose the screen, plus the dialog). The screens a new-engine run reached are saved per case (`screens.json`) and come back as `Application.screens` in the next compile; a changed label is reported as one rename, because elements keep an identity that does not depend on their label (`src/engine/knowledge/screens.ts`, `src/engine/execute/capture.ts`).
- **Step-through hook** in the new engine's runner: asked before and after every step, can stop the run (`STOPPED`, judged NOT_VERIFIED), and a step that finds no element or several asks for a pick on the screenshot instead of stopping. Without a hook a run is exactly as before.
- **Guided walkthrough** (`Walkthrough` on each case of a review card, a `walkthrough` job): steps on the left, the screen after each step on the right; Next, Add check, Edit step, Stop. Seven check types (visible, not visible, text contains, value, enabled, disabled, URL contains), each written as a sentence and kept only when the engine reads it back as exactly that check, tried on the screen first. Before a step that saves, submits or deletes the person is asked; on a production environment such a step is refused unless the project allows it. Changes are saved as a new version (reason "edited in a walkthrough…", so it wins when the workbook runs again) only on a yes. A pick can be remembered for that screen only, by the element picked. A walkthrough left without an answer for 15 minutes is closed. A card says when its test case changed since the run.
- Not done: a live video of the browser; applying a check to similar cases; the legacy route.

### Engine (E0.13 frame-aware execution, new engine only)
- A screen two frames deep is read and acted on: frame paths of any length, a read that is made again once when the page changed under it (`readSettled`, `isNavigationRace`), and a frame that still cannot be read is listed (`unreadFrames`) instead of being taken as empty.
- While a frame is unread, a check that is disproven or "not shown" only because something was not found is unproven with doubt NOT_OBSERVABLE, never FAIL or PASS; what was found stays found.
- The screen is the content frame (the largest visible frame, then the frame inside it that still takes a quarter of its room): "redirected to the Dashboard page" and "stays on the page" look at the address of the frame as well as of the shell, and record ids and page numbers in an address are not a different screen (`pageIdentityOf`).
- Not done: the legacy parser/explorer route, and the rewritten OrangeHRM workbook for TC12 to TC19 (not in the repository).

### Engine (E0.12 safety, and the packages that closed the gaps of E0.0 to E0.11)
- **A valid login from the sheet no longer fails.** The parser's masked copy of the Test Data (`Password: ••••`, kept for storage and display) was what the new engine was given, so it typed four bullet characters as the password. The engine now reads the text the tester wrote, kept in memory beside the model (`parser/original.ts`), and a value made only of mask characters is never typed, in the resolver or the executor. Found on the real OrangeHRM; the tests now go through the product's own path (`src/pipeline/engine-input.test.ts`).
- **"Leave the field blank" works.** The executor empties the field and checks it is empty; an empty value that is not a blank is still refused.
- **A native alert is a message.** OrangeHRM answers a blank field with `alert "User Name not given!"`, which the page does not show; the judge now treats what a pop-up said as a fresh message, so a different wording is set aside for a person instead of failing the case.
- **A page name the engine cannot place is not a FAIL.** "OrangeHRM home/dashboard" means either page, each side is looked up among the known addresses, and an address is called wrong only when the engine knows where the named page is, or knows the page it is on is another one.
- **Safety:** the iframe "not displayed" trap (never a PASS for what a frame shows); a deleted project with learned entries no longer fails on a foreign key.
- **E0.9 login with a code:** TOTP (RFC 6238 vectors), an email adapter with a local test mailbox, a code only from mail received after the login step, replay protection, ENVIRONMENT_ERROR when no mail comes and TEST_DATA_ERROR when a code is refused, never FAIL (`src/engine/auth/`). No real mail provider yet (PD-5).
- **E0.10:** the audit trail of every call tied to its step and locator contract (`src/engine/audit/`); caching of what is worked out from text, with the same results on and off and no page evidence ever cached (`src/engine/cache/`, `npm run engine:cache-bench`); learned entries replace the project rules as the only thing a run reads (migration 0008, `npm run rules`), with a reading that turns a sentence into a "not shown" check refused, and four live rules that judged nothing quarantined.
- **E0.8 review card:** a person's PASS or FAIL on a case the engine could not decide, stored with who and when beside the engine's verdict, which it never changes (migration 0009, `/api/jobs/:id/review-queue`).
- **E0.7 cards and lists (UI-07):** a step or a check about "the Backpack card" keeps the card, and is done and judged on that card only; twins and a missing card are never guessed. Quoted text is matched as whole words ("$9.99" is not in "$29.99").
- **Case styles** (`userName`, `user_name`, `user-name`) and tests for the sheet column names (IN-06, IN-07, IN-11, IN-13).
- Verification of E0.0 to E0.11 against the plan's exit tests: [docs/VERIFICATION-E0.0-E0.11.md](docs/VERIFICATION-E0.0-E0.11.md).

### Engine (E0.11)
- A note such as "Text box should accept only alphabets" is now a format rule of the field: generated valid, invalid and longest values follow it. Applicant and Expert left the core ontology (PD-3).
- `engine:gate` now blocks below the 80% review reduction minimum (`--allow-below-minimum` waives it for one run) and when a wrong-PASS trap (`test/traps/`) breaks. Draft answer key for the 29 OrangeHRM cases in `test/benchmark/` (unsigned: the gate refuses it without `--draft`); draft gold readings of the login workbook in `test/gold/`.

### Fixed
- **Elements inside iframes** (OrangeHRM shows its whole content in one). The element the tester picked was never accepted, because page locators do not look inside a frame: every locator "matched nothing" and the same question came back. Locators now carry the frame they are in (`frameLocator('iframe[name="rightMenu"]').getByRole(…)`, nested frames too), the generated Page Objects use them, and Playwright MCP's `locator(…).contentFrame()` code is read. The picture of the page also drew frame elements in the wrong place (a button 100px down the page showed at the top): their boxes are now moved by the frame's offset. `src/locators/frames.test.ts`.
- "Open the application" / "Enter the URL" opened the site root instead of BASE_URL with its path.
- A redirect check could record a page the test never reached (e.g. after a failed login) as the expected page, giving a false PASS; it now stops and asks.

### Added
- Real-world cases R4 and part of R5:
  - **Project rules, grouped review, approve all** (R4): answers in review are kept per project and never asked again.
  - **Import repair**: a test case spread over several rows (one step per row, merged id/title cells), a step's own expected result becomes a "Verify …" step, heading rows are skipped with a note, and other sheets that hold test cases are reported.
  - "User is on the Login page" opens that page; "Repeat steps 1-3" writes those steps out again.
  - Not built yet: overlay handler, lock-out guard, dependency order, "Same as TC_x", position words, suggested-wording column.
- Fixes from real use (M9):
  - **Reasons in plain words.** Every question and every NEEDS REVIEW says what happened, why, and what to do ("I could not find "username" on the page. The closest is the textbox "Login Name", but only 42% … Click it on the screenshot, or write Enter username in "Login Name" field"). `src/explorer/explain.ts`.
  - **Browser pop-ups no longer stop a run.** Alerts and confirms are accepted as they appear, written down on the step, and accepted in the generated test too. (This was the "modal state" error on OrangeHRM's empty-login alert.)
  - **Test cases are kept.** A Test cases tab lists everything written or imported, with its last result; each has a page with its steps, versions and every run, and **Run again**. Saved tests run again without asking for review.
  - **Evidence.** A screenshot after every step, a video and a trace for each run, shown on the result page with step times and errors, and the page the test ended on.
  - **Runs.** The list shows result badges, says where a cancelled run was stopped ("while waiting for your review") and refreshes by itself.
  - **The validation catalogue** (`docs/VALIDATIONS.md`): about 70 kinds of checks in plain words, from layout ("validate login was middle of screen", "Logo is at the top left", "Cancel is to the left of Save", "Save button is blue") to counts, tables, toasts, dialogs, requests, cookies, storage, downloads, labels and timing. Each failure reports what was measured. The Writing guide lists them all.
- M8 (database foundation, SQLite):
  - **Runs are rows.** Every run is an execution (`EXEC-YYYY-NNNNN` from a counter, so two runs at once never share a number) with each test's result, steps, checks and evidence (kind, size, SHA-256, masked), written in one transaction with the generated code's file hashes. `GET /api/projects/:id/executions[/:execId]` returns a past run as it was.
  - **Explorations are rows**: each step with its locator, strategy, score and page, so "which steps need review most often" is a query. `exploration.json` stays the artifact.
  - **Learned page URLs live in the database** (page routes of the Default environment); `pages.json` is imported once and renamed. Batch progress for the server comes from the results, not `batches/*.json`.
  - **Storage references**: uploads, workspaces, evidence and screenshots are named `local:…` / `workspace:…` in rows, never by absolute path; older rows are converted on open.
  - `npm run db -- verify` also checks missing files, orphan evidence files and counters; new `restore <file>` (keeps a copy of what it replaces, refuses a newer or damaged file), `export <folder> [--with-files]` and `import <folder>` (hash-checked NDJSON bundle, loaded into an empty database in one transaction).
  - Migration `0006` moves `verdicts` into `test_results` (the old name stays as a view for one release) and copies old runs, starting the counter above every number used. `fixtures/db/v0.1.0.db` is migrated to head in a test.
  - Not done: the PostgreSQL driver and the SQLite/PostgreSQL schema comparison in CI. See `docs/DATABASE.md` §10.1 for each difference from the plan.
- M8 (first part): database foundation. Versioned, checksummed migrations applied at start with a backup first and a refusal to open a database from a newer version; the existing database is adopted as the baseline. One Default environment per project, page routes, settings, counters and an audit log tables; job log lines have ids. The store lives in `src/db/` behind a driver interface (SQLite now, PostgreSQL later) and is async. `npm run db -- status | backup | verify`. See `docs/DATABASE.md`.
- Testers' own wording from a real OrangeHRM case: "Enter user name in Login Name text box", "Open Browser" (no step needed), steps in quotes, "Checking X", "User able to navigate to X", positions ignored; fields in table forms named from the cell before them.
- M7: the web UI (`npm run serve`): projects with run settings, workbook upload with column mapping, batch runs with live progress, results and download, the review queue, single test cases with questions answered by clicking the element on the screenshot, review with the code diff and Approve & Execute / Edit / Regenerate, run history, writing guide. Server on Fastify with node:sqlite, a job runner and a WebSocket. AssistProvider extension point (no-op).
- M6b: batch run of a workbook (`npm run auto-qa -- tests.xlsx`): automatic column matching, unattended run with a review queue, results written to `<name>.results.xlsx` (Status, Actual Result, Failed Step, Executed At, Automation ID, Evidence) plus an Auto QA summary sheet, resume and `--only-review`. `uuid` is overridden to 11.1.1 for a moderate advisory in the version ExcelJS pins.
- M6: run and judge (`npm run execute`, `npm run auto-qa`): PASS / FAIL / BLOCKED / NEEDS REVIEW with expected vs actual for every check, a health check in every test, basic failure labels, execution IDs, screenshots and traces kept per run, secrets masked in run output. The demo app has a deliberately broken Reports page.
- M5: code generation (`npm run generate`): a standalone Playwright project with Page Objects, grouped action methods, specs with the tester's step numbers, locator files, data, config and `.env.example`. Deterministic, with golden-file tests; the generated demo, saucedemo and the-internet projects pass on their own.
- M4: explore a whole test case (`npm run explore`). Steps run in order through LOCATE → VALIDATE → ACT → VERIFY_EFFECT → SETTLE; NEEDS_REVIEW waits for the tester; preconditions, Production guard, per-step screenshots, learned page URLs per environment. Local demo app (`npm run demo`) with end-to-end tests.
- M3: locator matching and validation (`npm run match`). Candidates are filtered by role and scored (exact, synonym, contains, fuzzy, nearby text, heading, role hint, dialog); weak or close matches go to review. The Locator Probe validates each rung of the ladder on a Chrome shared with Playwright MCP, and builds a fingerprint and page name for each element.
- All 72 Playwright MCP tools: every capability group is on by default, and `McpBrowser.callTool` calls any tool. Unsafe tools need `allowUnsafe`.
- `npm run tools` lists the tools by capability; a test fails if an MCP upgrade changes the list.
- Tests for M1 snapshot parsing, nearby text and MCP reply handling, using real snapshots from the practice sites.
- Test that `playwright` matches the version `@playwright/mcp` uses (D7).
- Biome linting and formatting (`npm run lint`, `npm run format`).
- CI on GitHub Actions: lint, typecheck and tests on every push and pull request.

### Changed
- `playwright` and `@playwright/mcp` are pinned to exact versions.
- Node 22 or later is required (`.nvmrc`, `engines`).
- All text files are stored with LF line endings (`.gitattributes`).

## 0.1.0 · 2026-09-30

### Added
- M1: connect to Playwright MCP and list page elements (`npm run snapshot`).
- M2: parse a written test case into steps, test data and checks (`npm run parse`).
