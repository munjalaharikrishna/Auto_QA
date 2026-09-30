# Auto QA

Turns manual test cases into Playwright + Page Object automation. Playwright MCP is used to explore the app; the platform itself decides every step with fixed rules (no AI API).

## Documents

| File | What it is |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Full specification: every feature (FR-…) by version, key decisions (D1–D21), API testing, non-functional rules, tester writing guide, backlog |
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
| `examples/demo-app/` | Local app and test cases for end-to-end tests (`npm run demo`). |
| `examples/test-cases.json` | Sample test cases (saucedemo, the-internet, and one with deliberate problems). |

## Milestones

- [x] M1: connect to Playwright MCP and list page elements
- [x] M2: parse a written test case into steps, test data and checks
- [x] M3: match a step to an element and validate the locator
- [x] M4: explore a full test case and save locators
- [ ] M5: generate Page Objects and specs
- [ ] M6: run with Playwright Test and report PASS/FAIL
- [ ] M7: web UI with Excel import and review screen
