# Changelog

Code changes by milestone. Specification changes are in [docs/SPEC.md §14](docs/SPEC.md#14-change-log).

## Unreleased

### Fixed
- "Open the application" / "Enter the URL" opened the site root instead of BASE_URL with its path.
- A redirect check could record a page the test never reached (e.g. after a failed login) as the expected page, giving a false PASS; it now stops and asks.

### Added
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
