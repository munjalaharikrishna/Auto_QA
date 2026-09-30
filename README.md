# Auto QA

Turns manual test cases into Playwright + Page Object automation. Playwright MCP is used to explore the app; the platform itself decides every step with fixed rules (no AI API).

## Documents

| File | What it is |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Full specification: every feature (FR-…) by version, key decisions (D1–D12), non-functional rules, tester writing guide, backlog |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture diagrams (Mermaid): components, MCP orchestration, flows, data model, deployment, architecture by version |
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

## Tests

```bash
npm test
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
| `examples/test-cases.json` | Sample test cases (saucedemo, the-internet, and one with deliberate problems). |

## Milestones

- [x] M1: connect to Playwright MCP and list page elements
- [x] M2: parse a written test case into steps, test data and checks
- [ ] M3: match a step to an element and validate the locator
- [ ] M4: explore a full test case and save locators
- [ ] M5: generate Page Objects and specs
- [ ] M6: run with Playwright Test and report PASS/FAIL
- [ ] M7: web UI with Excel import and review screen
