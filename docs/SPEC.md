# Auto QA: Product Specification

| | |
|---|---|
| **Product** | Auto QA: manual test cases to Playwright automation |
| **Spec version** | 1.5 |
| **Date** | 2026-09-30 |
| **Owner** | Harikrishna Munjala |
| **Source** | `Auto_QA.docx` (sections §1–§30), plus the design decisions agreed after it (§ references below point to that document) |
| **Related** | [ARCHITECTURE.md](ARCHITECTURE.md), [architecture.html](architecture.html) |

---

## 1. Purpose

Testers write manual test cases in Excel, Jira or TestRail. Converting them into Playwright automation by hand is slow.

Auto QA imports those test cases. It explores the application with **Playwright MCP**, finds and validates stable locators, generates a **Playwright TypeScript project using the Page Object Model**, runs it with **Playwright Test**, and reports **expected vs actual** with evidence.

It works **without any paid AI API**. Every decision is made by the platform's own rule-based code.

## 2. Scope

### In scope
- Web applications in a desktop browser, **any web app** (the app does not need `data-testid` attributes)
- Username + password login
- Test case import from Excel/CSV (V1) and Jira/TestRail (V2)
- Generated code: Playwright Test + TypeScript + Page Object Model
- **API tests** for HTTP/JSON (REST) services, written in the same sheet as UI tests (V2, §6.21)
- Local, single-user use first; a shared team server later

### Out of scope (for now)
| Item | Reason / plan |
|---|---|
| OTP, MFA, SSO logins | Not needed now. Listed in the backlog (§12). |
| CAPTCHA | Must never be bypassed. The test environment must switch it off. |
| Native mobile apps | Web only. Mobile *browser* emulation is in V3. |
| Paid AI APIs (OpenAI, Anthropic, Gemini…) | A core rule of the product (§27). |
| Inventing extra test cases | The platform never adds behaviour the tester did not write (§19). Generating optional drafts is in the backlog. |

## 3. Users and deployment

| Stage | Users | Where it runs | Storage |
|---|---|---|---|
| V1–V2 | One person (the owner) | Own Windows laptop | SQLite + local files |
| V3+ | The QA team | Shared company server (Docker) | PostgreSQL + file/S3 storage |

The design must allow moving from stage 1 to stage 2 **without a rewrite**. All data has an owner/project ID from day one, and no paths are hard-coded.

## 4. Key design decisions

| ID | Decision | Why |
|---|---|---|
| **D1** | **The platform is the MCP client and orchestrator.** It calls Playwright MCP tools itself. There is no AI agent. | A standalone app has no Cursor/Claude agent. The test case already contains the plan, so the platform only has to follow it. |
| **D2** | MCP is used **only** for exploration (new test), re-discovery and locator recovery. | Speed, repeatability, CI portability. |
| **D3** | Normal runs use **Playwright Test** on the generated code, never MCP. | What the tester approved is exactly what runs. |
| **D4** | Playwright **Codegen is not used** to write scripts. It is only a manual "pick locator" backup. | Codegen records a human, hard-codes passwords, and creates no POM or locator repository. |
| **D5** | The **platform** and the **generated project** are separate codebases. The generated project runs on its own with `npx playwright test`. | Any engineer or CI server can run it without the platform. |
| **D6** | **Ask, don't guess.** If a step is vague or matches more than one element, the platform stops and asks the tester. | Wrong guesses create false PASS/FAIL results. |
| **D7** | Locators are validated with the **Playwright library (Locator Probe)** connected to the **same browser** as MCP (CDP). | MCP refs (`e15`) are temporary, not locators. Validation must use the same engine as the tests. |
| **D8** | Exploration runs in **Chromium/Chrome only**. Other browsers are used only for execution. | The locators work in every browser, and CDP sharing needs Chromium. |
| **D9** | Exploration is allowed only on **non-production** environments by default. | Exploration really clicks buttons and can create data. |
| **D10** | Locator self-healing is **proposed for approval** by default (not auto-applied). Assertion targets are never healed. | A changed element may be a real defect. |
| **D11** | An AI helper is **not planned**. The code keeps one extension point (`AssistProvider`) so one could be added later. | "Decide later". The platform must be complete without it. |
| **D12** | Check the MCP tool names at startup and **pin the MCP version**. | Tool inputs change between versions (e.g. `ref` → `target` in v0.0.83). |
| **D13** | All MCP capability groups are on (72 tools in v0.0.83). The platform calls a tool only where code uses it. The two tools that run arbitrary page code (`browser_run_code_unsafe`, `browser_evaluate`) are **off** unless explicitly allowed. | The extra tools help later milestones (`browser_generate_locator` for FR-LO-07, `browser_storage_state` for login reuse, tracing/video for evidence). Arbitrary code breaks NFR-02. |
| **D14** | **API tests do not use MCP or a browser.** They are parsed into the same Test Model and generated as Playwright Test specs that use Playwright's built-in API client (`request` / `APIRequestContext`). | An API has no UI to explore, and Playwright MCP has no tool to send requests. The same runner, reports and CI serve both kinds of test. |
| **D15** | The **generated project holds only what a test needs to run**: pages, tests, locators, fixtures, data, config, reporter and `reports/`. The document's §9 `utils/` (test-parser, locator-engine, result-validator, evidence-manager, script-generator) are **platform** components and are not copied into it. The run-time parts of result validation and evidence live in `fixtures/test.fixture.ts` and `reporters/`. | The generated project never parses or explores, so it has no use for them (D5). One copy of the engine means one place to fix it. |
| **D16** | The locator repository is **one file per Page Object** (`locators/login.locators.json` for `LoginPage`), not one file per feature and not one file for everything. | The document shows both of the other layouts (§7 per feature, §9 a single `locator-repository.json`). Per page matches the POM: each Page Object loads its own file, and two features that share a page share its locators. |
| **D17** | **[Generate & Execute Test]** (document §3) means generate → review → **Approve & Execute**. Review is never skipped in V1. | §11 and §12 require review before execution, and a wrong locator gives a false PASS/FAIL (D6). Optional auto-approve is FR-RV-08 (V2). |
| **D18** | The form's **Browser** field (document §1, §28) is shown from V1 with only **Chromium** enabled; Firefox and WebKit are enabled in V3. The choice applies to **execution**; exploration always uses Chromium (D8). | The MVP keeps one browser, and the field is in the form from day one so the input does not change later. |

## 5. Test case input format

Every test case, however it is imported, becomes these fields:

| Field | Required | Example |
|---|---|---|
| ID | yes (generated if missing) | `TC-REG-014` |
| Title | yes | Verify email rejects an already registered address |
| Type | no | positive / negative / validation / boundary |
| Preconditions | no | `Unauthenticated visitor`; `On Registration page` |
| Steps | yes | 1. Enter Email  2. Click Continue |
| Test data | no | `Email=existing.registered@example.com` |
| Expected result | yes | Error "This email is already registered" is shown |
| Requirement ID | no (V4) | `REQ-REG-001` |
| Scenario ID | no (V4) | `SC-REG-003` (the test scenario the case belongs to, FR-EN-01) |

**Run settings.** The web form (FR-IN-04) also asks for the settings a run needs, as in the document's §3 example. They belong to the environment, not to the test case, so an imported sheet does not need them.

| Setting | Required | Stored as |
|---|---|---|
| Application URL | yes | `BASE_URL` of the environment |
| Username | yes, if the app needs a login | `TEST_USERNAME` (FR-ENV-05) |
| Password | yes, if the app needs a login | `TEST_PASSWORD`; the field is masked and never shown again (FR-ENV-05) |
| Browser | yes (Chromium in V1, D18) | Playwright project used for execution |
| Environment | from V2 | Which environment's settings to use (FR-ENV-02) |

### 5.1 API test cases (V2)

An API test uses the same fields, with **Type = `api`** (or a first step that sends a request). Steps and checks are plain English, parsed by the same rule-based parser with an API vocabulary. No JSON knowledge is needed beyond the request body.

| Field | Example |
|---|---|
| Title | Verify a new user can be created |
| Type | `api` |
| Preconditions | `Authenticated as admin` (a named auth profile, §6.21) |
| Steps | 1. Send POST `/api/users` with body `NewUser`  2. Save response field `id` as `userId`  3. Send GET `/api/users/{{userId}}` |
| Test data | `NewUser={"name":"Asha","role":"tester"}` |
| Expected result | Status is 201 · Response field `name` is "Asha" · Response header `Content-Type` contains "json" |

The base URL comes from the environment (FR-ENV), so steps use paths, not full URLs. Tokens and passwords come from secrets, never from the sheet (same rule as UI tests, FR-TD).

---

## 6. Functional requirements

**Version** = the first version that includes the feature. **Acceptance** = how we know it is done.

### 6.1 Input and import (FR-IN)

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-IN-01 | Import test cases from `.xlsx` and `.csv` | V1 | A 50-row sheet imports as 50 test cases |
| FR-IN-02 | **Column mapping screen**: the tester maps the sheet's columns to the fields in §5. The mapping is saved and reused for the next import. | V1 | A sheet with different column names imports correctly after mapping |
| FR-IN-03 | Steps in one cell are split on numbering (`1.`, `2)`) and line breaks | V1 | A cell with "1. … 2. … 3. …" gives 3 steps |
| FR-IN-04 | Enter or edit a single test case in a web form (§3 of the doc), with the run settings: Application URL, Username, Password and Browser | V1 | Form fields and run settings as in §5; one click starts generation (D17) |
| FR-IN-05 | Import from **Jira** (Xray/Zephyr) | V2 | Pull test cases by project/filter |
| FR-IN-06 | Import from **TestRail** | V2 | Pull test cases by suite |
| FR-IN-07 | Re-import updates changed test cases (matched by ID) and shows what changed | V2 | Changed steps are flagged for re-generation |

### 6.2 Test case parser (FR-PA) · §4

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-PA-01 | Convert each test case into the **Structured Test Model** (§8 of ARCHITECTURE.md) before any browser opens | V1 | Model JSON is shown in review · ✅ Parsed (M2) |
| FR-PA-02 | **Action lexicon** (JSON, editable): open/go to/navigate → navigate; enter/type/input/fill → fill; click/press/tap/submit → click; select/choose → select; check/tick/uncheck → check; hover → hover; upload → upload; press key → press | V1 | Each verb maps correctly · ✅ Parsed (M2) |
| FR-PA-03 | **Target extraction**: the words after the verb, with role words ("button", "field", "link") removed and kept as a `roleHint` | V1 | "Click the Login button" → target `Login`, roleHint `button` · ✅ Parsed (M2) |
| FR-PA-04 | **Alternative names**: "X (or Y)", "X (Y)", "X / Y" → several candidate names | V1 | "Apply to the Network (or Apply)" → 2 names · ✅ Parsed (M2) |
| FR-PA-05 | Ignore noise: arrows (→ ➜ >), text in brackets that isn't an alternative name, filler ("as applicable", "the", "valid", "successfully") | V1 | "Click Apply →" → target `Apply` · ✅ Parsed (M2) |
| FR-PA-06 | **Check words**: observe / verify / should / is displayed / is shown → assertion, not action | V1 | "Observe Registration page" → visibility assertion · ✅ Parsed (M2) |
| FR-PA-07 | **Assertion patterns**: redirected to X → url; X displayed → visible; message "Y" → text; remain on X → url unchanged; X enabled/disabled; field value | V1 | Examples parse to the right type · ✅ Parsed (M2) |
| FR-PA-08 | **Negative assertions**: cannot / does not / is not / rejects / blocked → negated check | V1 | "User cannot open Personal" → `not.toHaveURL` · ✅ Parsed (M2) |
| FR-PA-09 | **Browser actions**: back, forward, refresh, open URL directly, switch/close tab, accept/dismiss dialog | V1 (back, refresh, open URL) · V2 (tabs, dialogs) | "Use browser Back" → `goBack` · ✅ Parsed (M2): back, forward, refresh, open URL |
| FR-PA-10 | **Data binding**: "valid username" → `env.TEST_USERNAME`; quoted value → literal; value from Test Data column; `{{unique.email}}` → generated | V1 (env, literal, column) · V2 (generators) | Secrets are never literal in the model · ✅ Parsed (M2), generators included |
| FR-PA-11 | Steps that match no rule are marked **UNPARSED** with a reason. No guessing. | V1 | Shown as a warning in review · ✅ Parsed (M2) |
| FR-PA-12 | Synonyms table (JSON, editable): username ↔ email ↔ user id; login ↔ sign in ↔ log in; continue ↔ next ↔ proceed | V1 | Team can add entries without code changes · ✅ Parsed (M2) |
| FR-PA-13 | **Table steps and checks**: act in a row found by its text (`Click Edit in the row containing "Jason"`), check a cell (`Email in the row containing "Jason" is "jsmith@gmail.com"`), the row count (`Users table has 4 rows`), or that the table shows a text | V2 | Parsed into a step or check with a `row` qualifier; locators are row-scoped (FR-LO-13) |

### 6.3 Test case quality check (FR-QC)

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-QC-01 | Flag vague steps ("Reach X step", "as applicable", "equivalent route") before generation | V1 | Listed with a suggestion · ✅ Done (M2) |
| FR-QC-02 | Flag a missing starting point (first step is not navigate and there is no precondition) | V1 | Warning shown · ✅ Done (M2) |
| FR-QC-03 | Flag near-duplicate test cases (same steps, data and expected result) | V2 | Similar pair shown with a similarity % |
| FR-QC-04 | Quality score per imported sheet (ready / needs fixes / blocked) | V2 | Summary after import |
| FR-QC-05 | Built-in **writing guide** for testers (§11) | V1 | Linked from the import and review screens |

### 6.4 Preconditions and reusable flows (FR-PF)

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-PF-01 | Precondition keywords: "Unauthenticated visitor" → fresh browser context; "Logged in as X" → saved login state | V1 | Both work · ✅ Parsed (M2); applied in M4 |
| FR-PF-02 | **Reusable flows**: save a sequence of steps under a name (e.g. `On Registration page`) and use it as a precondition or step | V2 | One flow is used by many tests |
| FR-PF-03 | Flows are generated as Page Object methods / fixtures, not copied into every test | V2 | One method, many callers |
| FR-PF-04 | A flow can take parameters (e.g. `Login as {user}`) | V2 | |

### 6.5 Test data (FR-TD) · §16

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-TD-01 | Parse `key=value` pairs (one per line or `;`-separated) from the Test Data column | V1 | `Email=a@b.com` → data key `Email` · ✅ Parsed (M2) |
| FR-TD-02 | Credentials and secrets come only from environment variables (`TEST_USERNAME`, `TEST_PASSWORD`, `BASE_URL`) | V1 | No secret in generated code, model or report · ✅ Parser side (M2): secret-looking values become env refs and are masked |
| FR-TD-03 | Non-secret data goes to `data/*.data.ts` in the generated project | V1 | |
| FR-TD-04 | **Unique data generators**: `{{unique.email}}`, `{{unique.number}}`, `{{today}}` for tests that create records | V2 | Registration test passes twice in a row |
| FR-TD-05 | Data sets: run one test with several data rows (data-driven) | V3 | 3 rows → 3 test runs |

### 6.6 Exploration through MCP (FR-EX) · §5, §11

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-EX-01 | The platform starts Playwright MCP itself (stdio) and checks the required tools at startup | V1 | ✅ Done (M1) |
| FR-EX-02 | **Step state machine**: LOCATE → VALIDATE → ACT → VERIFY_EFFECT → SETTLE → DONE; any failure → NEEDS_REVIEW | V1 | Each step shows its state in the log |
| FR-EX-03 | Fixed **action → MCP tool** mapping (see ARCHITECTURE.md §5) | V1 | |
| FR-EX-04 | **Settle rule**: page loaded + no network activity for 500 ms + two identical snapshots in a row, within a timeout | V1 | No step runs on a half-loaded page |
| FR-EX-05 | **Verify effect**: after a fill, the value is present; after a click, the URL, the snapshot, a dialog or the network changed | V1 | A click that does nothing is flagged |
| FR-EX-06 | Exploration performs the steps in order (a guided dry run), so later pages can be explored | V1 | Dashboard elements found after Login |
| FR-EX-07 | Per-step screenshot during exploration | V1 | Shown in review |
| FR-EX-08 | Exploration refused on Production unless confirmed | V1 | Confirmation dialog |
| FR-EX-09 | Chromium only for exploration | V1 | |
| FR-EX-10 | Handle an unexpected dialog/pop-up/cookie banner (dismiss, or ask) | V2 | |

### 6.7 Locator discovery and validation (FR-LO) · §6

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-LO-01 | Parse the MCP snapshot into elements (role, name, ref, attributes, context) | V1 | ✅ Done (M1) |
| FR-LO-02 | **Nearby-text fallback** for unlabeled elements (text after a checkbox/radio, before a field; a heading just above an unnamed field, with a lower score) | V1 | ✅ Done (M1; heading in M3) |
| FR-LO-03 | Filter candidates by role compatibility with the action (fill → textbox/combobox, click → button/link/menuitem/tab, check → checkbox/radio/switch) | V1 | ✅ Done (M3) |
| FR-LO-04 | **Score** candidates: exact name, contains, fuzzy (Levenshtein), synonyms, nearby text, roleHint, context (form/dialog) | V1 | Scores shown in review · ✅ Done (M3); constants in `src/locators/match.ts` (`SCORE`) |
| FR-LO-05 | **Ambiguity rule**: if no candidate reaches the minimum score, or the top two are within the margin → NEEDS_REVIEW with the candidates | V1 | Never picks between two equal "Save" buttons · ✅ Done (M3): minimum 0.6, margin 0.1 |
| FR-LO-06 | **Locator ladder**: getByTestId → getByRole+name → getByLabel → getByPlaceholder → getByText → CSS → XPath. The first one that validates wins. | V1 | ✅ Done (M3). CSS skips generated-looking ids; position-based locators (`.nth()`) come after all others |
| FR-LO-07 | Use the code MCP reports after an action as an extra candidate | V1 | ✅ M3: MCP's `browser_generate_locator` suggestion joins the ladder and pins the element. Code reported after an action: M4 |
| FR-LO-08 | **Validation (Locator Probe)**: `count() === 1`, visible, enabled/editable, the action is possible | V1 | Invalid locators are never stored · ✅ Done (M3): also checks it is the same element the matcher chose; "possible" uses Playwright's trial actions |
| FR-LO-09 | Configurable test-id attribute per project (`data-testid`, `data-test`, `data-qa`…) | V1 | ✅ Done (M3) |
| FR-LO-10 | **Page grouping**: each element belongs to the page (URL path + title) where it was found | V1 | LoginPage vs DashboardPage · ✅ Done (M3): named from the tester's page name, else the path, else the title |
| FR-LO-11 | Store a **fingerprint** (role, name, label, tag, key attributes, parent form) for recovery | V1 | ✅ Built (M3); saved to the locator repository in M5 |
| FR-LO-12 | Scoped locators when needed (`form "Login"` → `getByRole('form').getByRole('button', …)`) to make a locator unique | V2 | |
| FR-LO-13 | **Row-scoped locators** for tables: `getByRole('row').filter({ hasText: 'Jason' }).getByRole('link', { name: 'edit' })`, and cells by their column header | V2 | The 8 identical "edit" links on the-internet `/tables` resolve by row, not by position |

### 6.8 Locator repository (FR-LR) · §7

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-LR-01 | One JSON file per page in the generated project: `locators/<page>.locators.json` with locator, strategy, page, validatedAt, fingerprint, history | V1 | |
| FR-LR-02 | Reuse a validated locator before exploring again | V2 | A second generation of the same page is faster |
| FR-LR-03 | Locator history (who/what changed it, when, why) | V2 | |
| FR-LR-04 | Mirror in the database for search ("which tests use this locator?") | V2 | |

### 6.9 Review and approval (FR-RV) · §12

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-RV-01 | Show the plan: steps, locators with scores, assertions, per-step screenshots, warnings | V1 | |
| FR-RV-02 | **Pick element on screenshot**: the tester clicks the right element for a NEEDS_REVIEW step. The platform builds and validates the locator. | V1 | Resolves ambiguous and unnamed elements |
| FR-RV-03 | Actions: **Approve & Execute**, **Edit**, **Regenerate** | V1 | |
| FR-RV-04 | Show the generated code with a diff against the previous version | V1 | |
| FR-RV-05 | Edits to steps flow back into the Test Model (not only the code) | V1 | |
| FR-RV-06 | Approve locator-healing proposals (FR-REC) | V3 | |
| FR-RV-07 | **Re-discover** a saved test (document §11: UI change, explicit request): explore again for all or chosen steps, compare the new locators with the repository and show the differences for approval | V2 | Only changed locators are updated; unchanged ones keep their history |
| FR-RV-08 | Optional per-project **auto-approve**: a generated test with no NEEDS_REVIEW step, no UNPARSED item and no warning is approved and run without the review screen | V2 | Off by default (D17) |

### 6.10 Code generation (FR-GE) · §9, §10

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-GE-01 | Template-based generation (Handlebars + Prettier) | V1 | |
| FR-GE-02 | Page Objects: `pages/<Name>Page.ts` with locators and action methods | V1 | Matches the §10 example |
| FR-GE-10 | **Action methods** (document §10, §30 "reusable actions"), by fixed rules: (1) a run of fill / select / check steps on one page that ends with a click or Enter on the same page becomes **one method named after that click** (`Login` → `login()`, `Save changes` → `saveChanges()`); (2) each filled value is a parameter, named after its field (`username`, `password`); (3) any other step becomes a one-action method (`openCart()`, `selectCountry(value)`); (4) checks stay in the spec file, using the page's locators. The spec passes secrets as `process.env.X!` | V1 | The §3 login test generates `LoginPage.login(username, password)` and the spec in document §10 |
| FR-GE-11 | A method with the same name and the same steps is reused; the same name with different steps gets a number (`login2`) and a warning in review | V1 | Deterministic (FR-GE-06) |
| FR-GE-03 | Specs: `tests/<name>.spec.ts`. Each step is a `test.step('S2: Enter username', …)` | V1 | Results map back to the tester's step numbers |
| FR-GE-04 | Secrets as `process.env.X!` only, plus a `.env.example` | V1 | |
| FR-GE-05 | `playwright.config.ts`, `package.json`, fixtures, data files, and a `reports/` folder (git-ignored) for each run's HTML report, results and evidence | V1 | `npx playwright test` works standalone (D15) |
| FR-GE-06 | **Deterministic output**: the same model always gives the same code | V1 | Re-generating shows an empty diff |
| FR-GE-07 | Update existing Page Objects without rewriting them (ts-morph) | V2 | Adding a test adds methods, keeps the old ones |
| FR-GE-08 | Each approval is a git commit in the generated project | V2 | |
| FR-GE-09 | Cucumber output: `features/`, `step-definitions/` (optional) | V4 | |

### 6.11 Execution (FR-RUN) · §11, §18, §21, §22

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-RUN-01 | Run a test with `npx playwright test` in the generated project, injecting the environment's variables | V1 | |
| FR-RUN-02 | Custom reporter streams step events live to the UI | V1 | |
| FR-RUN-03 | Chromium | V1 | |
| FR-RUN-04 | Log in once and reuse the session (`storageState` setup project) | V2 | |
| FR-RUN-05 | Regression suites: select tests → Run Selected / Run All, with a summary | V2 | |
| FR-RUN-06 | Firefox and WebKit through config `projects` | V3 | |
| FR-RUN-07 | Parallel execution through Playwright `workers` | V3 | |
| FR-RUN-08 | Mobile browser emulation (Mobile Chrome/Safari devices) | V3 | |
| FR-RUN-09 | Run from CI (GitHub Actions / Jenkins / Azure DevOps) with a JUnit + HTML report | V4 | |
| FR-RUN-10 | Scheduled runs (e.g. nightly regression) | V4 | |

### 6.12 Expected vs actual validation (FR-VAL) · §13

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-VAL-01 | For each assertion: expected, actual, result | V1 | |
| FR-VAL-02 | **Actual** is built from captured facts: current URL, title, main heading, visible alerts/validation messages, the assertion error | V1 | "Actual: stayed on /login; alert 'Invalid credentials'" |
| FR-VAL-03 | Report the failed step, failure reason and evidence | V1 | |
| FR-VAL-04 | Built-in **health check ("No crash")** in every test: no uncaught page errors, no 5xx on the page's requests, no error page | V1 | Can be switched off per test |

### 6.13 Failure classification and retry (FR-FC) · §15

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-FC-01 | Categories: Environment, Network, Application, Authentication, Test Data, Locator, Timeout, Assertion | V3 (basic labels in V1) | |
| FR-FC-02 | Rules are checked in a fixed order (see ARCHITECTURE.md §7) | V3 | |
| FR-FC-03 | **Controlled retry**: retry once only for Environment, Network and Timeout; Locator → recovery; **never** retry Assertion, Application, Auth or Test Data | V3 | |

### 6.14 Evidence (FR-EV) · §14

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-EV-01 | Screenshot on failure, error message, failed locator/assertion, URL, timestamps, duration | V1 | |
| FR-EV-02 | Trace, video, console logs, network errors | V2 | |
| FR-EV-03 | **Masking**: every secret value is replaced with `••••` in logs, errors and reports | V1 | |
| FR-EV-04 | Traces from tests that type a secret are marked **restricted** | V2 | |
| FR-EV-05 | Retention setting (e.g. keep evidence 30 days) | V3 | |

### 6.15 Locator recovery / self-healing (FR-REC) · §8

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-REC-01 | Only for a **Locator Failure**, at most once per step per run | V3 | |
| FR-REC-02 | Start MCP at the failing state, score elements against the stored fingerprint, validate the best candidate | V3 | "Login" → "Sign In" is healed |
| FR-REC-03 | Policy per project: `propose` (default) or `auto-apply` | V3 | |
| FR-REC-04 | Record every change (old → new, score, run, screenshots) and commit it | V3 | |
| FR-REC-05 | Never heal assertion targets | V3 | |

### 6.16 Environments (FR-ENV) · §17

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-ENV-01 | One environment (base URL + credentials) | V1 | |
| FR-ENV-02 | Several environments: Development, QA, Staging, UAT, Production | V2 | Same test, different env |
| FR-ENV-03 | **Page name → URL map** per environment (e.g. `Home → /`, `Opportunities → /opportunities`) | V2 | "Open Opportunities page" works in any env |
| FR-ENV-04 | Secrets encrypted at rest (AES-GCM), shown masked in the UI | V2 | |
| FR-ENV-05 | **V1 credential storage** (document §30 "enter credentials securely"): the username and password from the form are written only to the generated project's `.env`, which is git-ignored, and passed to the run as environment variables. They are never stored in the database, the Test Model, generated code, logs or reports. The password field is masked and never sent back to the browser. | V1 | A search of the database, the git history and the reports finds no password. Replaced by encrypted storage in V2 (FR-ENV-04) |

### 6.17 History and reporting (FR-HI) · §20

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-HI-01 | Result screen for the last run: PASS/FAIL, steps, expected vs actual, screenshot, duration, code | V1 | |
| FR-HI-02 | Execution history list (test, status, duration, env, browser, date) | V2 | |
| FR-HI-03 | Open any past run: steps, evidence, trace, logs, generated code at that time | V2 | |
| FR-HI-04 | Standalone HTML report per run/suite | V2 | |
| FR-HI-05 | Dashboards: pass rate trend, flaky tests, most-healed locators | V4 | |

### 6.18 Team mode (FR-TM)

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-TM-01 | Run on a shared server (Docker Compose) | V3 | |
| FR-TM-02 | User login and roles (Admin, QA Engineer, Viewer) | V3 | |
| FR-TM-03 | Several projects (one per application under test) | V3 | |
| FR-TM-04 | Move from SQLite to PostgreSQL | V3 | |

### 6.19 Enterprise (FR-EN) · §23–§25

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-EN-01 | **Requirement traceability**: Requirement → Test Scenario → Test Case → Automation → Execution → Result → Defect (document §25) | V4 | `REQ-REG-001 → SC-REG-003 → TC-REG-014 → AUTO-REG-014 → EXEC-2026-00124 → FAIL → BUG-REG-032` |
| FR-EN-06 | **Stable IDs from V1**, so traceability needs no renumbering later: generated automation `AUTO-<test case id without TC->` (TC-REG-014 → AUTO-REG-014); executions `EXEC-<year>-<5-digit sequence>`. Requirement and scenario IDs come from the sheet or Jira; defect IDs from Jira | V1 (automation and execution IDs) · V4 (the rest) | IDs never change after they are given |
| FR-EN-02 | **API + UI hybrid** steps (e.g. create data by API, check in UI) | V4 | Reuses the API steps from §6.21 inside a UI test |
| FR-EN-03 | Create a Jira defect from a failed run, with evidence attached | V4 | |
| FR-EN-04 | Push results back to Jira/TestRail | V4 | |
| FR-EN-05 | Cucumber / Gherkin generation | V4 | Same as FR-GE-09 |

### 6.20 Optional AI helper (FR-AI) · decide later

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-AI-01 | Keep an `AssistProvider` interface with a "no-op" default | V1 (interface only) | The platform works without it |
| FR-AI-02 | If added: a **local** model only (e.g. Ollama), used only at fallback points (unparsed step, low match score, recovery ranking, failure summary) | Decide later | |
| FR-AI-03 | AI output is only a suggestion: it goes through the same validation and human review | Decide later | |
| FR-AI-04 | Never used during test execution | Always | |

### 6.21 API testing (FR-API) · D14

| ID | Requirement | Version | Acceptance |
|---|---|---|---|
| FR-API-01 | Test cases with Type `api` (or a first step that sends a request) are API tests. They skip MCP exploration and go straight from the parser to code generation. | V2 | No browser opens |
| FR-API-02 | **Request steps**: `Send GET/POST/PUT/PATCH/DELETE <path>`, optionally `with body <data key>` and `with query <data key>` | V2 | Parsed into an `api` step in the Test Model |
| FR-API-03 | **Headers**: `Set header <name> to <value>` for the rest of the test | V2 | |
| FR-API-04 | **Auth profiles** per environment: bearer token, basic, API key header. Chosen by a precondition such as `Authenticated as admin`. Values come from secrets. | V2 | Tokens never appear in code, reports or logs (FR-EV-03) |
| FR-API-05 | **Checks**: status code (`Status is 201`), response field by path (`Response field user.name is "Asha"`), field exists / is empty, response contains text, header value, list length, response time under N ms | V2 | Each check reports expected vs actual (FR-VAL) |
| FR-API-06 | **Chaining**: `Save response field <path> as <name>`, then use `{{name}}` in later paths, bodies and checks | V2 | |
| FR-API-07 | **Generated code**: `tests/api/<id>.spec.ts` using Playwright's `request` fixture, and one API client per service (`api/<Service>Client.ts`), the API equivalent of a Page Object | V2 | Runs with `npx playwright test` like UI tests (D5) |
| FR-API-08 | **Evidence**: method, URL, status, request and response bodies, timings, with secrets masked | V2 | |
| FR-API-09 | **Contract check**: `Response matches schema <Name>`, using JSON Schema or an imported OpenAPI file | V3 | |
| FR-API-10 | Import request definitions from OpenAPI or a Postman collection so testers pick endpoints instead of typing paths | V3 | |
| FR-API-11 | API tests that change data run only on non-production environments by default | V2 | Same rule as D9 |

---

## 7. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 | **No paid AI API.** All core functions work offline from AI. |
| NFR-02 | **Deterministic.** The same input gives the same model, the same locators (for the same page) and the same code. |
| NFR-03 | **Security.** No secret in generated code, logs, reports or git. Secrets are encrypted at rest (V2) and masked in the UI. |
| NFR-04 | **Portability.** The generated project runs with only Node + `npx playwright test`, without the platform. |
| NFR-05 | **Windows first.** Works on Windows 11 with Node 22 (the owner's machine); Linux in Docker for team mode. |
| NFR-06 | **Pinned versions.** Playwright MCP and Playwright versions are pinned. Tool names are checked at startup. |
| NFR-07 | **Performance targets (V1).** Exploration: under 10 s per step on a normal page. Run of a 10-step test: under 30 s. |
| NFR-08 | **Explainability.** Every locator shows why it was chosen (score, strategy, validation result). |
| NFR-09 | **Safety.** Exploration never runs on Production without confirmation. CAPTCHA is never bypassed. |
| NFR-10 | **Maintainability.** Lexicon, synonyms and templates are data files that can be changed without code changes. |

---

## 8. Version plan

| Version | Theme | Main features |
|---|---|---|
| **V1 · MVP** | One test case, end to end | Excel/CSV import + column mapping · parser (lexicon, alternatives, checks, negatives, data binding, UNPARSED) · basic quality check · MCP exploration with the step state machine · locator scoring, ladder, validation, nearby text · review with **pick element** · POM + spec generation with **action methods** · run settings in the form (URL, credentials, browser) · credentials only in a git-ignored `.env` · run in Chromium · expected vs actual · health check · screenshot · masking |
| **V2 · Automation management** | Many tests, reused | Jira/TestRail import · reusable flows · unique data generators · locator repository reuse + history · environments + page URL map + encrypted secrets · login state reuse · suites · trace/video · history · duplicate detection · git commits · **API tests** (requests, auth profiles, checks, chaining) · **table steps and checks** · **re-discover** a saved test · optional auto-approve |
| **V3 · Intelligent automation + team** | Stable at scale | Locator recovery (propose/auto) · failure classification · controlled retry · Firefox/WebKit · parallel · mobile emulation · data-driven runs · API contract checks + OpenAPI/Postman import · **team mode** (server, login, roles, PostgreSQL) |
| **V4 · Enterprise QA** | Connected to the QA process | Traceability · API + UI hybrid · Cucumber · Jira defects + result sync · CI/CD · scheduled runs · dashboards |
| **Backlog** | Ideas, not planned | See §12 |

### V1 build milestones

| Milestone | Delivers | Status |
|---|---|---|
| M1 | Connect to Playwright MCP, list page elements (FR-EX-01, FR-LO-01, FR-LO-02) | ✅ Done |
| M2 | Parser: text → Test Model (FR-PA-*, FR-TD-01, FR-TD-02, FR-PF-01 parsing, FR-QC-01/02) | ✅ Done |
| M3 | Locator matching + Locator Probe validation (FR-LO-03…11) | ✅ Done |
| M4 | Full exploration of one test case (FR-EX-02…09) | ⬜ Next |
| M5 | Code generation (FR-GE-01…06) | ⬜ |
| M6 | Execution + expected vs actual + evidence (FR-RUN-01…03, FR-VAL-*, FR-EV-01, FR-EV-03) | ⬜ |
| M7 | Web UI: import, column mapping, review with pick element, results (FR-IN-01…04, FR-RV-*, FR-HI-01) | ⬜ |

Practice sites used during development: `saucedemo.com` (login), `the-internet.herokuapp.com` (checkboxes, dropdowns, dialogs, tables).

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **MCP client** | The program that calls Playwright MCP's tools. Here that is the platform itself. |
| **Snapshot** | MCP's text view of the page: each element's role, name and a temporary ref (`e15`) |
| **Ref** | A temporary handle for one element in one snapshot. It is **not** a locator. |
| **Locator** | A stable Playwright expression such as `getByRole('button', { name: 'Login' })` |
| **Locator Probe** | Platform code that checks a locator with the Playwright library on the same browser |
| **Test Model** | The structured JSON form of a test case: steps, data, assertions |
| **Flow** | A named, reusable sequence of steps used as a precondition |
| **Fingerprint** | Stored facts about an element used to find it again after the UI changes |
| **NEEDS_REVIEW** | A step the platform could not resolve safely; the tester decides |
| **Action method** | A Page Object method that performs one step or a group of steps, e.g. `login(username, password)` (FR-GE-10) |
| **Re-discovery** | Exploring a saved test again to refresh its locators after the UI changed (FR-RV-07) |
| **Run settings** | Application URL, credentials, browser and environment for a run. They belong to the environment, not the test case (§5) |
| **API test** | A test case that sends HTTP requests and checks the responses, with no browser (§6.21) |
| **API client** | Generated class with one method per endpoint a test uses; the API equivalent of a Page Object |
| **Auth profile** | A named way to authenticate API requests in an environment (bearer, basic, API key), with values from secrets |

---

## 10. Data model (summary)

Project · Environment · Secret · TestCase · TestModelVersion · Flow · PageObject · Locator · LocatorChange · Suite · Execution · StepResult · Evidence · ImportMapping · (V4) Requirement · Scenario · Defect.
The full diagram is in [ARCHITECTURE.md §9](ARCHITECTURE.md#9-data-model).

---

## 11. Test case writing guide (for testers)

1. **One action per step.** "Enter email and click Continue" → two steps.
2. **Use the exact text on the screen** for buttons, links and fields: "Click **Browse Opportunities**".
3. **Say where the test starts.** First step "Open Home page", or a precondition such as "On Registration page".
4. **Put data in the Test Data column** as `Field=value`, not inside the step.
5. **Write checks you can see**: "Error *This email is already registered* is shown", not "works correctly".
6. **Avoid vague words**: "as applicable", "equivalent", "etc.", "reach X step" (use a named flow instead).
7. **Negative tests**: state what must *not* happen: "User stays on the OTP page".
8. **Never type a password into a step or the sheet as plain text.** "Enter password" uses the test user's password. For a wrong one, add `Wrong Password=…` to Test Data and write "Enter wrong password". It becomes the env var `TEST_WRONG_PASSWORD`.

---

## 12. Backlog (future ideas, not scheduled)

| Idea | Note |
|---|---|
| OTP / MFA support | Fixed test OTP, or reading a test mailbox (e.g. Mailpit) |
| SSO logins (Google, Microsoft, Okta) | Pre-recorded login state |
| Optional local AI helper | See FR-AI; decide later |
| Draft negative/boundary tests from a positive test | Always as drafts for review (§19) |
| Visual comparison (screenshot diff) | Playwright `toHaveScreenshot` |
| Accessibility checks | axe-core in the health check |
| Record-and-convert | Tester records in the browser; the platform turns it into a Test Model |
| Test impact analysis | Which tests use a changed page/locator |
| Performance timings per step | Trend in dashboards |

## 13. Open questions

| # | Question | Needed by |
|---|---|---|
| Q1 | Which CI tool does the team use? | V4 |
| Q2 | Which Jira test plugin (Xray, Zephyr, none)? | V2 |
| Q3 | Keep evidence for how long? | V3 |
| Q4 | AI helper: yes or no? | After V2 |
| Q5 | Which API auth types do our services use (bearer, basic, API key, OAuth client credentials)? | V2 |
| Q6 | Do our services publish OpenAPI files or Postman collections? | V3 |
| Q7 | Are GraphQL or SOAP services in scope, or only REST/JSON? | V2 |

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-09-29 | First version from `Auto_QA.docx` |
| 1.1 | 2026-09-29 | Added decisions D1–D12 (MCP orchestration, no agent, Codegen role), import + column mapping, preconditions/flows, test data rules, quality check, health check, pick element, team mode, backlog. Scope: any web app, username/password only. M1 done. |
| 1.2 | 2026-09-29 | M2 done: parser and Test Model. Added a `clear` action and a `checked` assertion type. "Select X" without "from" is read as choosing a radio/checkbox. Secret-looking test data keys become env vars (`Wrong Password` → `TEST_WRONG_PASSWORD`), and a password typed in a step is unparsed (`SECRET_LITERAL`). |
| 1.3 | 2026-09-30 | Added API testing (§5.1, §6.21 FR-API, D14): API tests skip MCP and run with Playwright's `request` client; core in V2, contract checks and OpenAPI/Postman import in V3. D13: all 72 MCP tools on, unsafe tools off by default. Open questions Q5–Q7. |
| 1.4 | 2026-09-30 | M3 done: locator matching, ladder and Locator Probe on a Chrome shared with MCP over CDP. An unnamed field just after a heading is named by it (lower score). Position-based locators rank last; generated-looking ids are not used for CSS. FR-LO-07 uses `browser_generate_locator` now; code after an action comes in M4. |
| 1.5 | 2026-09-30 | Checked against every section of `Auto_QA.docx`. Added: run settings in the form (§5, FR-IN-04), V1 credential storage (FR-ENV-05), table steps and row-scoped locators (FR-PA-13, FR-LO-13), POM action methods (FR-GE-10, FR-GE-11), re-discovery and optional auto-approve (FR-RV-07, FR-RV-08), `reports/` folder (FR-GE-05), Test Scenario level and stable IDs (FR-EN-01, FR-EN-06). Recorded where the spec differs from the document: D15 (no `utils/` in the generated project), D16 (one locator file per page), D17 (Generate & Execute still reviews), D18 (Browser field with Chromium only in V1). |
