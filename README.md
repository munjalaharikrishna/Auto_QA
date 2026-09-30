# Auto QA

Turns manual test cases into Playwright + Page Object automation. Playwright MCP is used to explore the app; the platform itself decides every step with fixed rules (no AI API).

## Documents

| File | What it is |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Full specification: every feature (FR-…) by version, key decisions (D1–D23), API testing, non-functional rules, tester writing guide, backlog |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture diagrams (Mermaid): components, MCP orchestration, flows, data model, deployment, architecture by version |
| [docs/PLAN.md](docs/PLAN.md) | Implementation plan: remaining V1 milestones step by step, then V2–V4 |
| [docs/architecture.html](docs/architecture.html) | Visual architecture page. Open in a browser (needs internet for the diagrams). |

## Setup

```bash
npm install
```

Uses the Google Chrome installed on this machine.

`playwright` is pinned to the exact version `@playwright/mcp` depends on, so the Locator Probe runs the same engine as MCP (D7). Upgrade the two together; a test fails if they differ.

## Milestone 1: see what MCP sees on a page

```bash
npm run snapshot -- https://www.saucedemo.com
```

Options:

| Option | Meaning |
|---|---|
| `--headed` | Show the browser window |
| `--test-id-attribute data-test` | The attribute the app uses for test ids (default `data-testid`) |
| `--json file.json` | Also save the element list as JSON |

## Playwright MCP tools

```bash
npm run tools
```

Lists all 72 Playwright MCP tools, grouped by capability. `McpBrowser` turns on every group by default (`vision, pdf, devtools, network, storage, testing, config`); pass `capabilities` to choose fewer. Any tool can be called with `browser.callTool(name, args)`. The two tools that run arbitrary page code (`browser_run_code_unsafe`, `browser_evaluate`) are refused unless the browser is started with `allowUnsafe: true`.

After upgrading `@playwright/mcp`, run `npm run tools -- --update` and review the change to `src/explorer/fixtures/mcp-tools.txt`; a test fails until you do.

## Milestone 2: see how a written test case is understood

```bash
npm run parse -- examples/test-cases.json
npm run parse -- examples/test-cases.json --json models.json
```

The input is a JSON array of test cases with the fields in [SPEC §5](docs/SPEC.md#5-test-case-input-format) (`title`, `steps`, `expected`, plus optional `id`, `type`, `preconditions`, `testData`, `requirementId`, `row`). Excel/CSV import arrives in M7. The output shows each step and check in run order, marked ✔ (understood) or ✖ (needs the tester, with the reason), followed by warnings.

The parser's vocabulary is in [src/parser/lexicon.json](src/parser/lexicon.json) and [src/parser/synonyms.json](src/parser/synonyms.json). You can add words there without changing code.

## Milestone 3: find the element a step means and validate its locator

```bash
npm run match -- https://www.saucedemo.com "Enter username" "Enter password" "Click the Login button" --test-id-attribute data-test
npm run match -- https://the-internet.herokuapp.com/checkboxes "Check checkbox 1" --all
```

Each step is parsed (M2), then matched against the live page. Nothing is clicked or typed; running the steps in order is M4. For each step it shows:

- the candidates with their scores and why (exact, synonym, contains, fuzzy, nearby text, role hint)
- **NEEDS_REVIEW** when nothing matches well enough or two elements match almost equally
- the locator ladder, each rung validated by the Locator Probe (exactly one element, the same element, the action is possible), and the one that won

| Option | Meaning |
|---|---|
| `--all` | Validate every rung, not just up to the first valid one |
| `--page Login` | The page name to group the elements under (default: from the URL path, then the title) |
| `--test-id-attribute data-test` | The attribute the app uses for test ids |
| `--headed` | Show the browser window |
| `--json file.json` | Save the full result |

The Locator Probe starts Chrome with a debugging port and Playwright MCP connects to the same Chrome, so both see the same page (D7). Scoring constants are in `src/locators/match.ts`.

## Milestone 4: explore a whole test case

```bash
npm run demo        # in a second terminal: the local demo app on http://127.0.0.1:4173
npm run explore -- examples/demo-app/test-cases.json --id TC-DEMO-003 --base-url http://127.0.0.1:4173
npm run explore -- examples/test-cases.json --id TC-LOGIN-001 --base-url https://www.saucedemo.com --test-id-attribute data-test
```

The steps really run, in order, in Chrome: each goes LOCATE → VALIDATE → ACT → VERIFY_EFFECT → SETTLE. Checks are not judged yet (M6), but their elements are located so the generated test can use them. When the rules cannot decide (two equal buttons, an unknown page URL, a click that changed nothing), it asks in the terminal and waits with the browser open.

Values come from the environment or a `.env` file: `BASE_URL`, `TEST_USERNAME`, `TEST_PASSWORD`, and any `TEST_…` secret from Test Data. The demo app's login is `demo` / `demo123`.

| Option | Meaning |
|---|---|
| `--id TC-1` | Which test case in the file (default: the first) |
| `--base-url URL` | Overrides `BASE_URL` |
| `--login TC-LOGIN-001` | Test case to run first for a "Logged in" precondition |
| `--env-file file` | Where to read variables from (default `.env`) |
| `--production` | Asks for confirmation before exploring (it really clicks) |
| `--headed`, `--test-id-attribute`, `--out dir` | As for `match` |

Output: `.auto-qa/explore/<id>/exploration.json` (per step: locator, alternatives, scores, fingerprint, page, effect) and a screenshot per step. Page URLs learned on the way are kept per environment in `.auto-qa/pages.json` (D19). Secret values are never written.

## Milestone 5: generate the Playwright project

```bash
npm run generate -- examples/demo-app/test-cases.json            # every explored case in the file
npm run generate -- examples/test-cases.json --id TC-LOGIN-001 --id TC-LOGIN-002 --out workspaces/saucedemo
```

Reads each case's exploration (M4) and writes a standalone project to `workspaces/<app>/`:

| Path | Contents |
|---|---|
| `pages/LoginPage.ts` | Page Object: validated locators and action methods. Fields filled on a page plus the click that submits them become one method, e.g. `login(username, password)` (FR-GE-10) |
| `tests/tc-demo-001.spec.ts` | One test per test case; each step a `test.step` with the tester's step numbers; secrets only as `process.env.X!` |
| `locators/login.locators.json` | The locator repository: locator, strategy, fingerprint, validation time, alternatives |
| `data/tc-demo-003.data.ts` | Non-secret Test Data |
| `fixtures/test.fixture.ts`, `playwright.config.ts`, `package.json`, `tsconfig.json`, `.env.example` | Everything `npx playwright test` needs |

The same input always gives byte-identical files; `src/generator/fixtures/demo-golden/` holds the expected output for the demo app (`UPDATE_GOLDEN=1 npm test` after an intended change). Run the project with `cd workspaces/<app> && npm install && npx playwright test`, after filling `.env` from `.env.example`.

## Milestone 6: run the tests and judge them

```bash
npm run execute -- workspaces/saucedemo                       # run a generated project
npm run auto-qa -- examples/demo-app/test-cases.json --base-url http://127.0.0.1:4173   # the whole flow
```

`execute` runs a generated project with Playwright Test and judges each test. `auto-qa` does everything for written test cases: parse → explore (or reuse a saved exploration while the case is unchanged) → generate → run → judge.

| Status | Meaning |
|---|---|
| **PASS** | Every check passed |
| **FAIL** | A check failed (Assertion), an element was missing (Locator), the page had errors (Application), or time ran out (Timeout) |
| **BLOCKED** | Could not be run: a credential missing (Test Data), the app unreachable (Network), the precondition login failed, or an error in the generated test itself |
| **NEEDS REVIEW** | A step or check could not be read or resolved; nothing is guessed |

Every check shows **Expected** (the tester's words) and **Actual** (built from the assertion error and what the page showed), e.g. *Page was /. The page showed message "Epic sadface: Username and password do not match any user in this service".* Every test also has a built-in health check: an uncaught page error, a 5xx response or an error page fails it.

Each run gets an ID (`EXEC-2026-00012`). Its verdicts, screenshots and traces are kept in `.auto-qa/runs/<EXEC-ID>/`. Secret values (passwords, tokens) are masked in everything the run produced.

| Option (`auto-qa`) | Meaning |
|---|---|
| `--id TC-1` | Only these cases (repeatable) |
| `--unattended` | Never wait for an answer; a case that needs one is set aside as NEEDS REVIEW |
| `--reexplore` | Explore again even if a saved exploration can be reused |
| `--login TC-LOGIN-001` | Test case to run first for "Logged in" preconditions |
| `--workspace dir` | Where to generate the project (default `workspaces/<site>`) |

## Milestone 6b: a whole workbook, with results written back

```bash
npm run auto-qa -- tests.xlsx --base-url https://app.example.com
npm run auto-qa -- tests.xlsx --base-url https://app.example.com --only-review    # answer the review queue
```

Every test case in the sheet is parsed, explored, generated and run, one by one, without stopping to ask: a case that needs the tester is set aside as **NEEDS REVIEW** and the batch moves on. At the end:

- **`tests.results.xlsx`**: a copy of your workbook (the original is never changed) with **Status**, **Actual Result**, **Failed Step**, **Executed At**, **Automation ID** and **Evidence** (link to the screenshot) on every row, the status coloured, your formatting kept.
- An **Auto QA** sheet in it with the totals and the **review queue**: each set-aside case and what it needs.
- The generated Playwright project with a test for every case that could be automated.

Headers are matched automatically (`Test Case Name`, `Steps to Reproduce`, `Expected Result(s)`…), even under a title row; `--map steps="What to do"` names anything else. A stopped batch resumes where it was: finished explorations are reused, and identical cases are explored once. Rows without steps, duplicated IDs and `.csv` files with semicolons are handled.

Try it on the demo app: `npm run demo`, then `npm run demo:workbook` (writes a 100-row `examples/demo-app/demo-tests.xlsx`) and `npm run auto-qa -- examples/demo-app/demo-tests.xlsx --base-url http://127.0.0.1:4173`. Expected: 72 pass · 18 fail · 10 need review.

## Milestone 7: the web UI

```bash
npm run web:build     # once, or after changing web/
npm run serve         # http://127.0.0.1:4400
```

Everything the command line does, in the browser:

- **Projects**: the application URL, test user, password (write-only: kept in the project's git-ignored `.env`, never shown again), browser (Chromium in V1), test id attribute, and other values tests need.
- **Run a workbook**: upload an .xlsx or .csv, check the columns it found (change any), see the first rows and any problem rows, run all. Progress is live; the results page shows totals, every case's status and actual result, the evidence, the results workbook to download, and a button to answer the review queue.
- **Single test case**: write one, and the platform explores it. When it is unsure, it asks: **click the element on the screenshot**, choose from the matches, or skip. It then shows the steps with their locators, scores and screenshots and the generated code as a diff: **Approve & Execute**, **Edit** or **Regenerate**.
- **Runs** history and the **writing guide**.

The server listens on 127.0.0.1 only (V1 is single-user). Data is kept in `.auto-qa/` (SQLite database, uploads, explorations, runs) and generated projects in `workspaces/`. For UI development, `npm run web:dev` serves it with live reload on http://127.0.0.1:5173 next to `npm run serve`.

## Tests

```bash
npm test          # includes browser tests on a local page; AUTO_QA_SKIP_BROWSER=1 skips them
npm run typecheck
npm run lint      # Biome: lint + format check
npm run format    # apply formatting and safe fixes
```

## Code layout

| Path | What it does |
|---|---|
| `src/explorer/mcp-browser.ts` | Starts the Playwright MCP server and calls its tools. The platform is the MCP client. |
| `src/explorer/snapshot-parser.ts` | Turns MCP's accessibility snapshot into elements (role, name, ref, nearby text). |
| `src/cli/snapshot.ts` | Milestone 1 command line tool. |
| `src/model/test-model.ts` | The Structured Test Model: types and zod schema. |
| `src/parser/` | Test case → Test Model. `index.ts` (entry), `steps.ts` (actions, data binding), `assertions.ts` (checks), `target.ts` (element names), `test-data.ts`, `preconditions.ts`, `quality.ts`, `text.ts` (splitting, quotes). |
| `src/cli/parse.ts` | Milestone 2 command line tool. |
| `src/cli/tools.ts` | Lists every MCP tool by capability. |
| `src/locators/match.ts` | Candidate filter by role, scoring, ambiguity rule. Pure. |
| `src/locators/locator.ts` | Locators as data: print as code, run as a Playwright locator, read MCP's code without `eval`. |
| `src/locators/ladder.ts` | Locator ladder, fingerprint, page grouping. Pure. |
| `src/locators/probe.ts` | Locator Probe: starts the shared Chrome, reads element facts, validates locators. |
| `src/locators/engine.ts` | One step: snapshot → match → pin the element → ladder → first valid locator. |
| `src/locators/session.ts` | Starts the probe's Chrome and Playwright MCP on it together. |
| `src/cli/match.ts` | Milestone 3 command line tool. |
| `src/explorer/controller.ts` | Exploration: the step state machine, resolver, settle and verify-effect rules. |
| `src/explorer/values.ts` | Step values from env, Test Data, literals and generators; secret masking. |
| `src/cli/explore.ts` | Milestone 4 command line tool, with a terminal resolver. |
| `src/generator/plan.ts` | What to generate: pages, properties, grouped action methods, spec steps. Pure. |
| `src/generator/names.ts` | Naming rules for properties, methods and files. |
| `src/generator/render.ts`, `templates/` | Handlebars templates + Prettier → files. |
| `src/cli/generate.ts` | Milestone 5 command line tool. |
| `src/executor/runner.ts` | Runs a generated project, follows its events, keeps evidence, masks secrets. |
| `src/results/verdict.ts` | PASS / FAIL / BLOCKED / NEEDS REVIEW with expected vs actual. Pure. |
| `src/results/report.ts` | Terminal report. |
| `src/pipeline/run-cases.ts` | The whole flow for a set of test cases. |
| `src/cli/execute.ts`, `src/cli/auto-qa.ts` | Milestone 6 command line tools; `auto-qa` also takes a workbook (M6b). |
| `src/importer/columns.ts` | Header → field matching. |
| `src/importer/workbook.ts` | Reads .xlsx/.csv test cases with their row numbers. |
| `src/importer/results.ts` | Writes the results copy and the Auto QA sheet. |
| `src/pipeline/batch.ts` | A whole workbook: progress, resume, review queue. |
| `examples/demo-app/make-workbook.ts` | Builds a realistic 100-row workbook for the demo app. |
| `src/server/` | API (`app.ts`), job runner (`jobs.ts`), SQLite storage (`store.ts`), credentials in `.env` (`credentials.ts`), entry (`index.ts`). |
| `src/assist/provider.ts` | Extension point for an optional helper; does nothing by default. |
| `web/` | The React UI: pages (`web/src/pages`), pick element (`web/src/components/PickElement.tsx`). |
| `examples/demo-app/` | Local app and test cases for end-to-end tests (`npm run demo`). |
| `examples/test-cases.json` | Sample test cases (saucedemo, the-internet, and one with deliberate problems). |

## Milestones

- [x] M1: connect to Playwright MCP and list page elements
- [x] M2: parse a written test case into steps, test data and checks
- [x] M3: match a step to an element and validate the locator
- [x] M4: explore a full test case and save locators
- [x] M5: generate Page Objects and specs
- [x] M6: run with Playwright Test and report PASS/FAIL
- [x] M6b: run a whole workbook and write PASS/FAIL and actual results into a copy of the sheet
- [x] M7: web UI with upload, progress, review screen and results
