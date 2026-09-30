# Changelog

Code changes by milestone. Specification changes are in [docs/SPEC.md §14](docs/SPEC.md#14-change-log).

## Unreleased

### Added
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
