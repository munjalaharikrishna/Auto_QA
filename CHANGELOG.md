# Changelog

Code changes by milestone. Specification changes are in [docs/SPEC.md §14](docs/SPEC.md#14-change-log).

## Unreleased

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
