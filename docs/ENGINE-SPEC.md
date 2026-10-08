# Deterministic Semantic QA Engine: Specification

| | |
|---|---|
| **Spec version** | 1.2: records the owner's build decisions of 8 Oct (PD-3, PD-5, PD-6, PD-8) |
| **Date** | 2026-10-08 |
| **Owner** | Harikrishna Munjala |
| **Source** | `Deterministic_QA_Engine_Complete_BRD.docx` (every feature, mapped line by line in §15) |
| **Owner decisions** | 7 Oct 2026, recorded in §3 |
| **Status** | Draft. Replaces `Auto_QA.docx` as the source of requirements for the engine. `SPEC.md` stays for the parts the owner chose to keep (§3, DEC-04) until it is merged. |
| **Code changes** | None made with this spec. |

**Contents**
1. [Purpose](#1-purpose)
2. [Core principles](#2-core-principles)
3. [Owner decisions](#3-owner-decisions)
4. [How to read the requirements](#4-how-to-read-the-requirements)
5. [Language understanding layers (L1–L12)](#5-language-understanding-layers-l1l12)
6. [Context, state and test data (L13–L19)](#6-context-state-and-test-data-l13l19)
7. [Application knowledge and locators (L20–L25)](#7-application-knowledge-and-locators-l20l25)
8. [UI orchestration and interaction (L26–L35)](#8-ui-orchestration-and-interaction-l26l35)
9. [Action compilation, observation and assertions (L36–L50)](#9-action-compilation-observation-and-assertions-l36l50)
10. [Session, diagnostics and verdicts (L51–L70)](#10-session-diagnostics-and-verdicts-l51l70)
11. [Learning, governance, metrics and security (L71–L90)](#11-learning-governance-metrics-and-security-l71l90)
12. [QA-IR: the intermediate representation](#12-qa-ir-the-intermediate-representation)
13. [Verdicts, PASS safety gate and user review](#13-verdicts-pass-safety-gate-and-user-review)
14. [Delivery phases](#14-delivery-phases)
15. [BRD traceability (completeness check)](#15-brd-traceability-completeness-check)
16. [Open points found while writing this spec](#16-open-points-found-while-writing-this-spec)

---

## 1. Purpose

The engine takes manual test cases written by testers and **compiles** them, the way a compiler handles source code. It does not guess what they mean.

```
Excel/CSV → normalize → tokenize → patterns → vocabulary → grammar → clauses → negation → conditions
          → QA-IR → context → test data → page + target → action plan → validate plan
          → execute (Playwright MCP) → observe → evidence → PASS safety gate → verdict
```

It must:
- understand test cases as testers really write them
- **never give a wrong PASS (target 0.00%)**
- cut human review by about **90%** against the baseline (target from the BRD; 80% is the owner's minimum goal)
- use **no AI, no LLM and no statistical model**. The same input in the same state always gives the same result.

## 2. Core principles

From BRD §1. These apply to every requirement below.

| ID | Principle | Meaning |
|---|---|---|
| PR-01 | **Compilation, not inference** | No AI inference and no global "brittle regex rules". Test cases are translated into a structured representation. |
| PR-02 | **QA-IR** | Every test case becomes a machine-readable Semantic QA Intermediate Representation before anything runs (§12). |
| PR-03 | **DOM semantics** | Targets are judged on the page's semantic structure (roles, labels, relationships), not on screen pixels. |
| PR-04 | **Execution through Playwright MCP** | The browser is driven through MCP commands (with code export per DEC-01). |
| PR-05 | **0% wrong PASS** | A PASS is given only when evidence proves every expectation (§13). |
| PR-06 | **~90% review reduction** | Measured as `1 − (current reviews / baseline reviews)` (GV-08). |

## 3. Owner decisions

Decided on 7 Oct 2026. Where the BRD is silent or open, these decide.

| ID | Decision | Effect on this spec |
|---|---|---|
| **DEC-01** | Tests are **executed through Playwright MCP**, and the engine can also **export** a Playwright Test + Page Object Model project. | EX-02 executes via MCP. EXP-01 adds code export. The exported code must give the same verdict as the MCP run. |
| **DEC-02** | **Learning from user inputs** is required. | GV-01 is a Must. Learning only from explicit user review, never from guesses, and never stores a mapping that would create a vacuous check (§11, GV-01 rules). |
| **DEC-03** | **MFA/OTP is in scope.** The user selects the login type per application; for email OTP the system asks for the mailbox details and reads the OTP automatically (8 Oct). | VD-01 and AU-01…AU-09 (§10). |
| **DEC-04** | **Keep** the existing web UI, POM code export, database, API testing and CI. **Jira/TestRail import moves to the last phase.** | KP-01…05 in §14; Phase 7 = Jira/TestRail. |
| **DEC-05** | **No "PASS (with assumptions)".** When the engine cannot prove a result, it shows **expected vs actual** and the **user clicks PASS or FAIL**. | §13: user verdict flow; the status records that a person decided. Combined with DEC-02, the user's decision is learned for the next run. |

## 4. How to read the requirements

- **ID** = layer prefix + number. Example: `NG-02` = Negation layer, requirement 2. Every ID appears in the traceability table (§15).
- **Priority:** all BRD features are **Must** unless marked otherwise. The BRD calls itself a "100% feature-complete blueprint".
- **Acceptance** = how we know the requirement is done. Examples use real test cases from the OrangeHRM pilot.
- **"Test case"** = one row group in Excel. **"Step"** = one action. **"Expectation"** = one thing to verify. **"Clause"** = one part of a sentence after splitting.

### 4.1 Requirements by module and layer

The BRD's "90 features" are counted **per module and layer** (OP-1, decided 8 Oct 2026). Each module is built, tested and reported as one unit.

| Module | BRD layers | Layer | Requirement IDs | Count |
|---|---|---|---|---|
| **M1 Input** | L1 | Test case input | IN-01…IN-23 | 23 |
| **M2 Language understanding** | L2 | Text normalization | NM-01…NM-20 | 20 |
| | L3 | Tokenization | TK-01…TK-15 | 15 |
| | L4 | Regex / pattern engine | RX-01…RX-24 | 24 |
| | L5 | QA vocabulary | VO-01…VO-02 | 2 |
| | L6 | Synonym engine | SY-01…SY-02 | 2 |
| | L7 | QA grammar | GR-01…GR-11 | 11 |
| | L8 | Clause parser | CL-01…CL-02 | 2 |
| | L9 | Negation engine | NG-01…NG-02 | 2 |
| | L10 | Conditional logic | CD-01…CD-02 | 2 |
| | L11 | QA ontology | ON-01 | 1 |
| | L12 | QA-IR | IR-01 | 1 |
| **M3 Context and test data** | L13 | Context engine | CX-01…CX-10 | 10 |
| | L14 | Reference resolution | RF-01 | 1 |
| | L15 | Test state machine | ST-01…ST-02 | 2 |
| | L16 | Test data understanding | TD-01 | 1 |
| | L17 | Test data resolver | DR-01 | 1 |
| | L18 | Test data generator | DG-01 | 1 |
| | L19 | Data safety | DS-01…DS-04 | 4 |
| **M4 Knowledge and locators** | L20 | Application knowledge base | AK-01 | 1 |
| | L21 | Page knowledge base | PK-01 | 1 |
| | L22 | Locator understanding | LU-01 | 1 |
| | L23 | Locator candidate engine | LC-01 | 1 |
| | L24 | Locator confidence / ambiguity | LA-01 | 1 |
| | L25 | DOM semantic inspection | DM-01 | 1 |
| **M5 UI orchestration** | L26–L35 | Frames, tabs, modals, forms, controls, tables, lists, keyboard/mouse, waits | UI-01…UI-09 | 9 |
| **M6 Execution and assertions** | L36–L50 | Planner, MCP execution, observation, evidence, assertions, code export | EX-01…EX-09, EXP-01 | 10 |
| **M7 Authentication, verdicts and diagnostics** | L51–L70 | Login profiles and MFA/OTP, conditions, isolation, verdicts, PASS gate, review | VD-01…VD-11, AU-01…AU-09 | 20 |
| **M8 Learning and governance** | L71–L90 | Learning, audit, benchmark, KPIs, security, caching, versioning, pre-flight | GV-01…GV-16 | 16 |
| **Total** | | | | **186** |

Progress, test results and the review-reduction KPI (GV-08) are reported per module and per layer.

---

## 5. Language understanding layers (L1–L12)

### L1. Test case input layer

| ID | Requirement | Acceptance |
|---|---|---|
| IN-01 | **Excel test-case reader**: native programmatic workbook parser | Reads a workbook without Excel or Office installed |
| IN-02 | **XLSX support**: full Office Open XML spreadsheet support | Reads `.xlsx` with styles, merged cells, formulas (values used) |
| IN-03 | **CSV support** for flat comma-separated files | Reads UTF-8 CSV with quoted fields and embedded newlines |
| IN-04 | **Multiple worksheets**: iterate across all sheets of one file | A 3-sheet workbook imports test cases from all sheets; empty sheets skipped |
| IN-05 | **Multiple test-case formats**: variant row/column layouts handled dynamically | Both "one row per test case" and "one row per step" layouts import correctly |
| IN-06 | **Test Case ID recognition** | Column named "Testcase ID", "Test Case Id ", "TC ID" etc. is mapped |
| IN-07 | **Test Case Name recognition** | "Testcase Name", "Title", "Test Case Name" mapped |
| IN-08 | **Preconditions recognition** | "Preconditions", "Pre-requisites" mapped and kept separate from steps |
| IN-09 | **Test Steps recognition** | "Steps", "Test Design Description", "Procedure" mapped |
| IN-10 | **Test Data recognition**: explicit step variables | "Test Data" column read as data, e.g. `Username: cypress` |
| IN-11 | **Expected Result recognition** | "Expected Results", "Expected Outcome" mapped, per test case or per step |
| IN-12 | **Optional Actual Result column** mapped | Present → read and later written; absent → no error |
| IN-13 | **Optional priority/severity** tracked | Values carried into QA-IR metadata and reports |
| IN-14 | **Optional tags** (labels) | Comma-separated tags stored; usable to filter runs |
| IN-15 | **Empty-cell handling**: safe defaults, no breakdown | Empty optional cells never crash import; empty required cell → IN-21 |
| IN-16 | **Merged-cell handling**: value mapped to every child cell | Title merged over 5 rows applies to all 5 |
| IN-17 | **Multi-line cell handling**: split sub-steps on newlines | A cell with 3 lines gives 3 steps when lines are numbered or bulleted |
| IN-18 | **Step numbering recognition**: `1.`, `1)`, `Step 1:`; steps ordered by number | Out-of-order numbers are re-ordered; gaps reported |
| IN-19 | **Continuation-row detection**: rows without an ID continue the previous test case | Add_Employee.xlsx (228 rows, 19 test cases) imports as 19 test cases |
| IN-20 | **Duplicate test-case detection** before execution | Two identical IDs or identical content flagged before running |
| IN-21 | **Invalid structure detection**: halt on a flawed workbook schema | Missing Steps or Expected column → import stops with a clear message |
| IN-22 | **Input schema validation** against a strict schema | Each imported test case is validated; errors listed per row |
| IN-23 | **Test-case version tracking** | Re-import of a changed test case creates a new version with a diff |

### L2. Text normalization layer

| ID | Requirement | Acceptance |
|---|---|---|
| NM-01 | **Lowercase where appropriate**, never on literal data | "Click LOGIN" → `click login` for matching; data `'Cypress'` unchanged |
| NM-02 | **Preserve original text** as a pristine raw record | Raw text stored byte-for-byte with every test case |
| NM-03 | **Trim** outer whitespace | |
| NM-04 | **Collapse multiple spaces** into one | "Enter username  in" → one space |
| NM-05 | **Normalize tabs/newlines** to spaces (after IN-17 splitting) | |
| NM-06 | **Normalize punctuation** variants | "…" → "...", "‚" → "," |
| NM-07 | **Normalize quotation marks**: smart/curly → straight | “Login” → "Login", ‘x’ → 'x' |
| NM-08 | **Normalize apostrophes** | ’ ` ´ → ' |
| NM-09 | **Normalize hyphens/dashes** | – — ‑ → - |
| NM-10 | **Normalize Unicode variants** (NFKC, non-breaking spaces, full-width characters) | U+00A0 → space; full-width letters → ASCII |
| NM-11 | **Expand common abbreviations** | pwd → password, btn → button, txt box → text box, DDL → dropdown |
| NM-12 | **Normalize contractions** into fixed semantic forms | can't → cannot; doesn't → does not; shouldn't → should not |
| NM-13 | **Preserve technical terms** | `getByRole`, `data-testid`, API paths untouched |
| NM-14 | **Preserve case-sensitive test data** | `Admin123` stays `Admin123` |
| NM-15 | **Preserve passwords** exactly (value integrity inside processing; masking is DS-02) | Password with spaces or symbols is typed exactly as given |
| NM-16 | **Preserve IDs** | `TC_LOGIN_001`, `EMP-0042` unchanged |
| NM-17 | **Preserve URLs** | `https://x.com/Path?A=1` unchanged |
| NM-18 | **Preserve exact expected messages** (quoted text) | `"Invalid credentials"` compared exactly as written |
| NM-19 | **Normalized ↔ original mapping**: every normalized token points back to its original span | Report can highlight the original words behind any decision |
| NM-20 | **Data protection rule**: normalization never modifies test data under any condition | Automated test: 500 data values go through normalization unchanged |

### L3. Tokenization layer

| ID | Requirement | Acceptance |
|---|---|---|
| TK-01 | **Word tokens** | "Click the Login button" → 4 word tokens |
| TK-02 | **Number tokens** | "Enter 5 items" → `5` as NUMBER |
| TK-03 | **Symbol tokens** | `/`, `→`, `>` separated as SYMBOL |
| TK-04 | **Quoted-value tokens**: text inside quotes is one literal token | `'cypress'` → LITERAL(cypress) |
| TK-05 | **Variable tokens** | `${user}`, `{{email}}` → VARIABLE |
| TK-06 | **Placeholder tokens** | `<username>`, `[password]` → PLACEHOLDER |
| TK-07 | **URL tokens** | |
| TK-08 | **Email tokens** | `a@b.com` → EMAIL |
| TK-09 | **Date tokens** | `21/02/2024`, `2024-02-21` → DATE |
| TK-10 | **Special-character tokens** (masks, hidden characters) | `***`, zero-width characters identified |
| TK-11 | **camelCase recognition** | `userName` ↔ "user name" |
| TK-12 | **snake_case recognition** | `user_name` ↔ "user name" |
| TK-13 | **kebab-case recognition** | `user-name` ↔ "user name" |
| TK-14 | **Flat word recognition** | `username` ↔ "user name" |
| TK-15 | **Compound-word recognition** | "login name", "loginname", "Login Name" → one compound |

### L4. Regex / pattern engine

| ID | Requirement | Acceptance |
|---|---|---|
| RX-01 | **Isolation policy**: regular expressions live **only** in this layer. No other layer contains regex. | Static check in CI: regex literals outside `patterns/` fail the build |
| RX-02 | Pattern: **Email** | |
| RX-03 | Pattern: **Phone** | National and international formats |
| RX-04 | Pattern: **URL** | |
| RX-05 | Pattern: **Date** | Formats per project locale |
| RX-06 | Pattern: **Time** | 12/24-hour |
| RX-07 | Pattern: **Currency** | `$29.99`, `₹1,000` |
| RX-08 | Pattern: **Percentage** | |
| RX-09 | Pattern: **Numeric data** | Integers, decimals, thousands separators |
| RX-10 | Pattern: **ID schemas** | Project-configurable, e.g. `EMP-\d{4}` |
| RX-11 | Pattern: **License numbers** | Project-configurable |
| RX-12 | Extract: **test data** in sentences | "Enter 'cypress' as username" → value `cypress` |
| RX-13 | Extract: **quoted strings** | |
| RX-14 | Extract: **placeholders** | |
| RX-15 | Extract: **variables** | |
| RX-16 | Extract: **browser commands** | back, forward, refresh, new tab |
| RX-17 | Extract: **wait durations** | "wait 5 seconds" → 5000 ms (then handled by UI-09, never as a fixed sleep) |
| RX-18 | Extract: **keyboard keys** | Enter, Tab, Shift+Tab, Ctrl+A |
| RX-19 | Extract: **file paths** | `C:\data\photo.jpg`, `./files/a.pdf` |
| RX-20 | Extract: **API endpoints** | `GET /api/users/1` |
| RX-21 | **Regex safety and timeouts**: each pattern run has a hard limit (default 50 ms) to stop catastrophic backtracking | A known catastrophic pattern on a 10 kB string is stopped at 50 ms and reported |
| RX-22 | **Invalid regex detection** at load time | A broken pattern file fails start-up with the pattern's name |
| RX-23 | **Priority and conflict detection** between patterns | Two patterns matching the same span → the higher priority wins; conflicts listed in a report |
| RX-24 | **Versioning and verification**: every pattern has a version and a dedicated test suite | Each pattern has positive and negative examples run in CI |

### L5. QA vocabulary layer

| ID | Requirement | Acceptance |
|---|---|---|
| VO-01 | **Controlled action vocabulary** (word forms such as entered/entering/enters map to the canonical action through own deterministic word lists, PD-6), exactly: click, enter, type, fill, select, choose, upload, download, submit, login, logout, search, open, navigate, scroll, hover, drag, drop, press, check, uncheck, clear, remove, delete, edit, save, cancel, close, expand, collapse, refresh | Each of the 31 verbs has a definition, an action type and tests. A verb outside the list → VD-05 UNSUPPORTED unless mapped by SY-02. |
| VO-02 | **Controlled assertion vocabulary**, exactly: verify, validate, confirm, ensure, check, expect, should, must, displays, shows, contains, equals, remains, redirects, rejects, accepts | Each of the 16 words marks an expectation; "check" is resolved by grammar (action "check the box" vs assertion "check that…") |

### L6. Synonym engine

| ID | Requirement | Acceptance |
|---|---|---|
| SY-01 | **Granular synonym mapping**: no blanket "same meaning". click/press/tap are separate mechanical drivers. Mapping is explicit: click → CLICK, tap → CLICK, press → PRESS, select → SELECT. | "press Enter" → PRESS key; "press the Login button" → resolved by grammar to CLICK on a button, recorded as a decision |
| SY-02 | **Category directories**: separate synonym sets for Action, Assertion, Navigation, Authentication, Form, Error, Visibility, State, Data, Negation | Each category is its own versioned file; a word can map differently in different categories |

### L7. QA grammar layer

| ID | Requirement | Acceptance (example) |
|---|---|---|
| GR-01 | Model **Action + Target** | "Click Login" |
| GR-02 | Model **Action + Target + Value** | "Enter cypress in username field" |
| GR-03 | Model **Action + Target + Value + Condition** | "Enter 'abc' in Email if the field is empty" |
| GR-04 | Model **Action + Target + Expected Result** | "Click Save, a toast appears" |
| GR-05 | Model **Verify + Condition** | "Verify the Login button is disabled" |
| GR-06 | Model **Verify + Expected Result** | "Verify an error message is displayed" |
| GR-07 | Model **If + Condition + Then + Result** | "If the password is invalid then an error is shown" |
| GR-08 | Model **When + Condition + Result** | "When the fields are empty, Login is disabled" |
| GR-09 | Model **After + Action + Expected Result** | "After clicking Reset, the fields are empty" |
| GR-10 | Model **Before + Action + Expected Result** | "Before clicking Save, the Save button is enabled" |
| GR-11 | **Positional parameter translation** | "Enter cypress in username field" → `ACTION=ENTER_VALUE, TARGET=username field, VALUE=cypress` |

A sentence that fits no model is never guessed: it goes to the pre-flight check (GV-14) as "not understood".

### L8. Clause parser

| ID | Requirement | Acceptance |
|---|---|---|
| CL-01 | **Compound phrase splitter** on: and, or, but, then, while, because, if, when, unless, otherwise, after, before, until | "Login is not performed and the system displays a validation message" → 2 clauses |
| CL-02 | **Multi-expectation segregation**: each clause becomes its own expectation with its own verdict | "User should not log in and an error message should be displayed" → C1 "User should not log in", C2 "Error message should be displayed"; both must pass |

### L9. Negation engine

| ID | Requirement | Acceptance |
|---|---|---|
| NG-01 | **Negation terms → boolean controls**: not, no, never, cannot, can't, shouldn't, must not, should not, does not, doesn't, fails to, rejected, denied, unavailable, absent, hidden, disabled | Each term flips or sets the expected boolean of its clause |
| NG-02 | **Clause-specific negation**: a negation binds only inside its own clause and never changes another clause | TC_LOGIN_005: "Login is **not** performed and the system displays a validation message" → C1 LOGIN = false, C2 MESSAGE VISIBLE = true. (In the 5 Oct run, the "not" was lost and C2 was never checked: a wrong PASS.) |

### L10. Conditional logic engine

| ID | Requirement | Acceptance |
|---|---|---|
| CD-01 | **Conditional keywords → branches**: if, when, unless, only if, provided that, whenever, otherwise, in case, based on, depending on | Each keyword produces a CONDITION + EXPECTATION pair, and an optional OTHERWISE branch |
| CD-02 | **Conditional mapping validation** | "If the password is invalid, an error should be displayed" → `CONDITION: password = INVALID`, `EXPECTATION: error = VISIBLE`. The branch is chosen from **known facts** (test data class, observed state). If the condition's truth cannot be established → user review (§13), never a guessed branch. |

### L11. QA ontology

| ID | Requirement | Acceptance |
|---|---|---|
| ON-01 | **Controlled semantic model** (PD-3: a **core** ontology for all applications plus each application's own classes in AK-01; Applicant, Expert and similar domain classes are application classes, not core) with these classes: User, Applicant, Expert, Admin, Username, Password, Field, Button, Link, Dropdown, Checkbox, Radio button, Table, Row, Column, Modal, Page, Section, Message, Error, Validation, Dashboard, URL, File, Record, API Response Status | Every target in QA-IR has an ontology class; classes have allowed actions (e.g. Button: click; Field: enter/clear) and allowed assertions; an action not allowed for the class → VD-04 paradox |

### L12. Semantic QA intermediate representation (QA-IR)

| ID | Requirement | Acceptance |
|---|---|---|
| IR-01 | **QA-IR**: every test case is compiled into a typed, machine-readable structure of steps, targets, values, conditions and expectations **before execution**. Schema in §12. | Nothing executes without a valid QA-IR; the QA-IR is stored, versioned and shown in review |

---

## 6. Context, state and test data (L13–L19)

### L13. Context engine

| ID | Requirement | Acceptance |
|---|---|---|
| CX-01 | **Previous-step context** | "Then click it" refers to the previous step's target |
| CX-02 | **Previous-target context** | |
| CX-03 | **Previous-value context** | "the entered value" = last value typed |
| CX-04 | **Current-page context** | Targets are searched on the current page first |
| CX-05 | **Current-form context** | "Click Save" prefers the Save of the form just filled |
| CX-06 | **Current-modal context** | When a modal is open, targets are searched inside it first |
| CX-07 | **Current-user context** | Which user is logged in (for role checks) |
| CX-08 | **Current-test context** | Test ID, data set, step number |
| CX-09 | **Variable context** | Values saved during the run (e.g. a generated employee ID) |
| CX-10 | **Authentication context** | Logged in or not, MFA passed or not |

### L14. Reference resolution

| ID | Requirement | Acceptance |
|---|---|---|
| RF-01 | Resolve indirect references through the history: **it, this, that, same field, above field, below field, selected value, entered value, previous page, current page, newly opened tab, corresponding button, associated message** | Add_Employee TC18: "checking the **added data**" → the values entered in steps 7–10. A reference that cannot be resolved uniquely → review, never a guess. |

### L15. Test state machine

| ID | Requirement | Acceptance |
|---|---|---|
| ST-01 | **Lifecycle states**: APPLICATION_STARTED, LOGIN_PAGE, USERNAME_ENTERED, PASSWORD_ENTERED, LOGIN_SUBMITTED, LOGIN_SUCCESS, LOGIN_FAILED, DASHBOARD, ERROR_DISPLAYED, LOGGED_OUT (extensible per application via AK-01) | Each step's expected state transition is recorded in QA-IR |
| ST-02 | **Transition matrix validation** across: page, form, authentication, modal, navigation, data, element, test, previous and expected state | A step that would move to an impossible state (e.g. LOGIN_SUCCESS without LOGIN_SUBMITTED) is flagged by VD-04 before execution; at run time, actual state ≠ expected state is a FAIL with both states shown |

### L16. Test data understanding

| ID | Requirement | Acceptance |
|---|---|---|
| TD-01 | **Data classes**: Explicit, Valid, Invalid, Empty, Blank, Missing, Null, Boundary, Maximum, Minimum, Existing, Non-existing, Duplicate, Generated, Random, Credential, Environment | "Leave the Login Name blank" → Username = BLANK; "Enter an invalid username" → Username = INVALID; `Username: cypress` → EXPLICIT. Class is shown in review and report. |

### L17. Test data resolver

| ID | Requirement | Acceptance |
|---|---|---|
| DR-01 | **Resolution sources**, in a fixed, documented order: Excel (Test Data column / step text), environment variables, central configuration, credential store, test-data files, generated values, previous steps, values created by the application | TC_LOGIN_002 with `Username: invaliduser, Password: selenium` uses exactly those values. (On 5 Oct the engine made up a password instead: a wrong scenario.) An EXPLICIT value always wins over a generated one. |

### L18. Test data generator

| ID | Requirement | Acceptance |
|---|---|---|
| DG-01 | **Deterministic generation** of test keys, usernames, invalid values, emails, passwords, dates, boundary values and long strings; each generated value is reproducible (seeded by test ID + step + run) and logged | Same seed → same value; every generated value appears in the execution log with its rule |

### L19. Data safety layer

| ID | Requirement | Acceptance |
|---|---|---|
| DS-01 | **Remove production identifiers** from logs and evidence | Configured patterns (e.g. real customer IDs) never appear in reports |
| DS-02 | **Mask passwords** in logs, reports and screenshots | Password fields and secret values shown as `••••` |
| DS-03 | **Block clear-text secrets** in any stored output | A scan of all outputs after a run finds no secret value |
| DS-04 | **Encrypt configuration variables** that hold secrets | Credential store encrypted at rest (AES-256-GCM, key outside the store) |

---

## 7. Application knowledge and locators (L20–L25)

### L20. Application knowledge base

| ID | Requirement | Acceptance |
|---|---|---|
| AK-01 | Store per application: **application name, base URL, pages, routes, roles, modules, forms, fields, buttons, messages, business rules, navigation paths, authentication rules** | Editable in the UI; versioned; used by L13–L15 and L22 |

### L21. Page knowledge base

| ID | Requirement | Acceptance |
|---|---|---|
| PK-01 | Per page: **route, sections, forms, components, dynamic filters, messages, expected states** | "Navigate to Add Employee page/popup" resolves to the stored Add Employee page; its identity is checked (route + key elements) |

### L22. Locator understanding

| ID | Requirement | Acceptance |
|---|---|---|
| LU-01 | **Label consolidation**: "username", "username field", "login name", "user name textbox", "Username input" resolve to **one** physical component through a central mapping | In OrangeHRM, "Login Name text box" and "username" both resolve to the same field; the mapping is stored in PK-01 |

### L23. Locator candidate engine

| ID | Requirement | Acceptance |
|---|---|---|
| LC-01 | **Weighted priority**: Test ID ≥ Role ≥ Accessible name ≥ Label ≥ Placeholder ≥ Name ≥ ID ≥ Text content ≥ DOM relationships ≥ XPath ≥ MCP inspection | The first candidate that passes LA-01 is used; every candidate tried is logged with its weight |

### L24. Locator confidence and ambiguity

| ID | Requirement | Acceptance |
|---|---|---|
| LA-01 | **Zero-tolerance ambiguity**: detect zero matches, multiple matches, overlapping layers, inactive (disabled/hidden/covered) elements. **No PASS may be given on an unresolved ambiguous locator.** | Two equal "Save" buttons → NEEDS_REVIEW with both candidates shown on a screenshot |

### L25. DOM semantic inspection

| ID | Requirement | Acceptance |
|---|---|---|
| DM-01 | Analyse **HTML tag, accessibility role, label, visibility, parent–child relationships, nearby text, bounding box, focus** for every candidate | OrangeHRM label cell "Password :" is linked to the textbox beside it, so "password" gives one field, not two |

---

## 8. UI orchestration and interaction (L26–L35)

| ID | Requirement | Acceptance |
|---|---|---|
| UI-01 | **Frames and shadow DOM**: nested frames, cross-origin frames, shadow roots | A field inside an iframe inside a shadow root is found and filled |
| UI-02 | **Tabs and windows**: concurrent tabs, unexpected pop-ups, active tab, titles, redirects | "Help opens in a new tab" switches to and checks the new tab; unexpected pop-ups are recorded |
| UI-03 | **Modals and dialogs**: alerts, confirms, prompts, modal assertions | "Confirm the delete" accepts the confirm dialog; its text can be asserted |
| UI-04 | **Form boundaries**: field dependencies, error notifications, field constraints, submit | Field errors are linked to their field; a submit is recognised per form |
| UI-05 | **Control handlers** for: textbox, password, dropdown, checkbox, date/time picker, file upload, rich-text editor, slider, toggle | Each control type has its own fill/select/read logic and tests |
| UI-06 | **Table relational processing**: rows/columns linked to objects ("Click Edit for John" → table → John's row → Edit); sorting, pagination, duplicate rows | "Delete the employee added in this test" finds that row by its values across pages |
| UI-07 | **Lists and cards**: repeating grids, dynamic lists, parent–child hierarchies, container anchors | "Add to cart on the 'Backpack' card" targets the right card |
| UI-08 | **Keyboard and mouse**: Enter, Tab, Shift+Tab, Ctrl shortcuts, double-click, hover, drag-and-drop | Each listed interaction has a test |
| UI-09 | **Wait/synchronization engine with no fixed sleeps**: wait on page load, visibility, network completion, URL change, DOM mutation, spinner gone, API calls | Code scan: no fixed `sleep`/timeout waits in the engine; "Wait 5 seconds" becomes "wait until idle, max 5 s" |

---

## 9. Action compilation, observation and assertions (L36–L50)

| ID | Requirement | Acceptance |
|---|---|---|
| EX-01 | **Action planner**: QA-IR compiled into action chains, e.g. `ENTER_VALUE → find username → resolve locator → validate locator → fill username → observe result` | The plan is shown in review before execution and stored with the run |
| EX-02 | **Playwright MCP execution**: navigation, DOM inspection, user events and evidence through structured MCP commands (DEC-01) | A test case runs end to end through MCP with no generated code |
| EX-03 | **MCP capability manager**: discover available tools at start-up, map functions, manage fallbacks | A missing or renamed MCP tool is reported at start-up with its fallback, or the run is BLOCKED with the reason |
| EX-04 | **Observation engine**: continuously capture page state, DOM, location, visible errors, element properties | Each step stores a before and after observation |
| EX-05 | **Before/after comparison**: `state delta = post-action snapshot − pre-action snapshot` over visible text, URL and DOM | The report lists what changed after each action (new message, new URL, element appeared/disappeared) |
| EX-06 | **Expected result and assertion engines**: expectations become explicit verification conditions (AUTHENTICATION, VISIBILITY, CONTENT, …) checked against the indicators | Each expectation in QA-IR has one or more conditions and a result per condition |
| EX-07 | **Evidence freshness**: a failure/success indicator must be produced **by that step**; anything present before the step is rejected as evidence | An error message already on the page before clicking Login cannot prove "error is displayed" |
| EX-08 | **Vacuous assertion guard**: block checks that cannot fail or that do not test the business rule (e.g. "login failed" because a button is still visible; "text X is not visible" where X is a garbled phrase never expected on any page) | The 5 Oct TC_LOGIN_004–007 checks are rejected as vacuous; the case goes to the PASS gate as unproven, never PASS |
| EX-09 | **Business rules and boundaries**: enforce validation rules and boundary logic: Min−1, Max+1, empty, null, Unicode spaces, weekend/time boundaries | "Text box should accept only numbers" can be verified with a boundary/invalid value when the test case asks for it; never invented when it does not |
| EXP-01 | **Code export (DEC-01)**: export a Playwright Test + Page Object Model project from a verified QA-IR and its locators | The exported project runs with `npx playwright test` and gives the same verdicts as the MCP run on the same build |

---

## 10. Session, diagnostics and verdicts (L51–L70)

| ID | Requirement | Acceptance |
|---|---|---|
| VD-01 | **Authentication and authorization**: session milestones, credential failures, **MFA/OTP gates (DEC-03)**, account lock-outs, role-based permission checks | OTP read from a configured source (test mailbox, TOTP secret, or fixed test code); lock-out detected and reported as TEST_DATA_ERROR, never FAIL; "Viewer cannot see Admin" checked |
| AU-01 | **Login type per application**: the user selects the login type in the application settings: (a) username + password, (b) username + password + **email OTP**, (c) username + password + **authenticator app (TOTP)**, (d) username + password + **fixed test OTP**, (e) username + password + **SMS OTP** | The selected type is stored in the application knowledge base (AK-01) and used by every test case of that application |
| AU-02 | **The system asks for what the chosen type needs**, and nothing else | Email OTP → test mailbox address, mail server/provider, mailbox login (or app password), optional sender and subject filter. TOTP → the authenticator secret key. Fixed OTP → the code. SMS OTP → SMS provider details. Required fields are validated before saving. |
| AU-03 | **Mailbox connection test** when the details are saved | "Test connection" logs in to the mailbox and reads the latest message header; a failure shows the exact reason (wrong password, server unreachable, access disabled) |
| AU-04 | **Automatic email OTP**: after the login step, the engine reads the newest matching mail **received after that login step**, extracts the code with the pattern engine (L4), enters it, and continues | OrangeHRM-style login with email OTP completes with no user action; only a mail received after the step is accepted (EX-07 freshness) |
| AU-05 | **Automatic TOTP**: the engine computes the current code from the secret key (RFC 6238), deterministically from the clock | Code accepted on the first try; clock difference handled by using the next 30-second window once |
| AU-06 | **OTP wait and failure rules**: wait up to a configured time (default 60 s) for the mail; no code → **ENVIRONMENT_ERROR** "OTP mail not received"; code rejected by the app → **TEST_DATA_ERROR**; never FAIL | Each case reported with its reason; never counted as an application FAIL |
| AU-07 | **OTP secrecy**: mailbox password, TOTP secret and every OTP value are stored encrypted (DS-04) and masked in logs, screenshots and reports (DS-02) | Output scan after a run finds no mailbox password, secret or OTP |
| AU-09 | **Email adapter** (PD-5): all mail access goes through one adapter interface (connect, wait for a message after a time, read it); each provider is a separate adapter. The first real provider is chosen once the owner confirms which one the target application uses. | The engine has no provider-specific code outside the adapters; a local test mail server adapter passes AU-04 |
| AU-08 | **Expected OTP failures are testable**: a test case such as "Enter a wrong OTP → error shown" uses the OTP step without reading the mailbox (data class INVALID, TD-01) | Negative OTP test cases run as normal tests |
| VD-02 | **Preconditions and postconditions**: check the application is ready before; verify end states after ("Create user → user should exist") | A failed precondition → BLOCKED, not FAIL |
| VD-03 | **Dependency and isolation guards**: cross-test dependencies declared; full session reset between tests (cache, cookies, storage, data) | Two tests run in any order give the same verdicts |
| VD-04 | **Ambiguity and paradox interceptors**: flag missing attributes, impossible targets and contradictions **before** running | "Click Save while Save must remain disabled" flagged before execution |
| VD-05 | **Unsupported intent guard**: any operation that is not mapped → UNSUPPORTED immediately; no fallback guessing | "Do the needful" → UNSUPPORTED |
| VD-06 | **Recovery and retry limits**: self-correction (DOM rescan, frame switch, candidate re-evaluation) allowed; **no retry** on business or assertion failures | A locator miss retries once with a rescan; a failed assertion is never retried |
| VD-07 | **Root cause apportionment**: every failure classified as APPLICATION, AUTOMATION, ENVIRONMENT or TEST-DATA | Each FAIL/ERROR in the report carries one bucket and the evidence for it |
| VD-08 | **Confidence invariant**: confidence may steer how the engine works (which candidate first, when to ask) but **never decides PASS/FAIL** | Code review + test: changing confidence thresholds never changes a PASS to FAIL or the reverse |
| VD-09 | **PASS safety gate**: PASS only if all expectations were evaluated, evidence is fresh, targets verified, no ambiguity, no contradiction, no vacuous assertion | See §13; any failed condition blocks PASS |
| VD-10 | **Granular verdicts**, no catch-all: PASS, FAIL, NEEDS_REVIEW, NOT_VERIFIED, BLOCKED, UNSUPPORTED, AUTOMATION_ERROR, ENVIRONMENT_ERROR, TEST_DATA_ERROR | §13 defines each one; every run ends in exactly one |
| VD-11 | **Human review and deduplication**: complex ambiguities or environment shifts go to review; identical root causes across executions are merged into one review item | 4 test cases with the same unresolved wording → 1 review item covering 4 cases |

---

## 11. Learning, governance, metrics and security (L71–L90)

| ID | Requirement | Acceptance |
|---|---|---|
| GV-01 | **Deterministic learning from user input (DEC-02)**: mapping registries (labels, synonyms, page aliases, references, user verdict decisions) are updated **only** from explicit user review records, for future runs, with no AI | See rules below |
| GV-02 | **Locator contracts and audit registry**: Page → Component → Semantic name → Selector chain; full audit trail of every action and MCP tool call | Every executed action can be traced to its contract and tool call |
| GV-03 | **Explainability records**: for every step, a readable log of expectation, observation and selector used | A tester can read why each step passed or failed without opening code |
| GV-04 | **Assumptions and configuration as singletons**: execution assumptions tracked in real time; operational rules, credential paths and vocabulary centralised | One configuration source per concern; every assumption listed in the report (and never leads to PASS, DEC-05) |
| GV-05 | **Deterministic decisions**: identical state + data + configuration → identical interpretation and execution path | Running the benchmark twice gives byte-identical QA-IR and decision logs |
| GV-06 | **Regression benchmark system**: permanent suite of real test cases (text variations and UI scenarios) with known correct verdicts | Starts with the 29 OrangeHRM cases (10 login, 19 add-employee); every engine change runs it |
| GV-07 | **Language coverage analytics**: vocabulary health across actions, negations, conditions | Report: % of steps understood per category, top unknown words |
| GV-08 | **Review reduction metric**: `Review reduction = 1 − (current reviews / baseline reviews)`; **target ~90%** (owner minimum 80%) | Shown per batch and per benchmark run |
| GV-09 | **Wrong-PASS KPI**: wrong PASS count, false PASS by source (parser, locator, assertion, evidence, recovery); **target 0.00** | Any wrong PASS in the benchmark fails the build |
| GV-10 | **Information security**: access control, scrubbing, field masking, encrypted logs | Logs encrypted at rest; masking verified by DS-03 scan |
| GV-11 | **Performance and caching**: cache parser, locator and metadata results; reuse DOM snapshots; clean up resources | A re-run of an unchanged batch reuses caches and is measurably faster; no leaked browsers |
| GV-12 | **Component version control**: separate versions for grammar, ontology, knowledge registries, assertion code | Each run records the version of each component |
| GV-13 | **Automated protection gates**: any change to grammar, vocabulary, ontology, patterns or registries triggers the regression benchmark | A change that lowers the understood rate or adds a wrong PASS is blocked |
| GV-14 | **Quality pre-flight**: before execution, scan steps for missing data, ambiguous wording, target conflicts, impossible objectives | Pre-flight report shown before the run; blocking issues listed per test case |
| GV-15 | **Intent compilation sequence**: Read test case → Understand → Validate → Build QA-IR → Resolve data → Resolve page → Resolve target → Build execution plan → Validate plan → Execute | Each stage is a separate, testable component; its output is logged |
| GV-16 | **Terminal verification protocol** before any verdict: understood? → every action understood? → data resolved? → correct target found? → correct action performed? → expected result understood? → actual behaviour observed? → evidence proves every expectation? → any ambiguity? → any contradiction? → any stale evidence? → any automation/environment error? → PASS / FAIL / REVIEW | The 12 answers are stored with every verdict and shown in the report |

**GV-01 learning rules** (from DEC-02 and from what went wrong on 5 Oct):
1. A learned entry is created only from an explicit user action in review (a pick, a mapping, a PASS/FAIL decision), recorded with who, when, and which test case.
2. A learned entry must pass the vacuous assertion guard (EX-08) and the benchmark (GV-13) before it is used. A mapping that turns a sentence into a check that cannot fail is rejected. (5 Oct, TC_LOGIN_004: a learned rule rewrote the expected result into *"Appropriate user name Password not given should shown"*, which produced a wrong PASS.)
3. A learned entry is versioned, can be viewed, edited and switched off, and the report shows when one was used.
4. A user PASS/FAIL decision (§13) on an unprovable expectation is stored as a concrete, checkable expectation where one can be derived (e.g. the exact message seen), so the next run can decide automatically.

---

## 12. QA-IR: the intermediate representation

Every test case compiles to one QA-IR document. Minimum structure:

```json
{
  "testCase": { "id": "TC_LOGIN_005", "name": "Login with blank username", "version": 3,
                "source": { "file": "OrangeHRM_Login_Test_Cases_Updated.xlsx", "sheet": "Sheet1", "rows": [6] },
                "priority": null, "tags": [] },
  "preconditions": [ { "type": "STATE", "state": "LOGIN_PAGE" } ],
  "data": {
    "username": { "class": "BLANK",    "source": "EXCEL", "value": "" },
    "password": { "class": "EXPLICIT", "source": "EXCEL", "value": "***", "secret": true }
  },
  "steps": [
    { "id": "S1", "action": "NAVIGATE", "target": { "ontology": "Page", "name": "Login" },
      "expectedState": "LOGIN_PAGE", "original": "Open the OrangeHRM login page." },
    { "id": "S2", "action": "CLEAR", "target": { "ontology": "Username", "label": "Login Name" },
      "value": "$data.username", "original": "Leave the Login Name text box blank." },
    { "id": "S3", "action": "ENTER_VALUE", "target": { "ontology": "Password" },
      "value": "$data.password", "original": "Enter password in the Password text box." },
    { "id": "S4", "action": "CLICK", "target": { "ontology": "Button", "name": "Login" },
      "expectedState": "LOGIN_SUBMITTED", "original": "Click the 'Login' button." }
  ],
  "expectations": [
    { "id": "E1", "clause": "Login is not performed", "negated": true,
      "condition": { "type": "AUTHENTICATION", "expect": "LOGIN_FAILED" }, "afterStep": "S4" },
    { "id": "E2", "clause": "the system displays a validation message indicating that the username is required",
      "negated": false,
      "condition": { "type": "VISIBILITY", "target": { "ontology": "Validation", "near": "Username" },
                     "fresh": true }, "afterStep": "S4" }
  ],
  "conditionals": [],
  "references": [],
  "assumptions": [],
  "versions": { "grammar": "1.0.0", "vocabulary": "1.0.0", "ontology": "1.0.0", "patterns": "1.0.0" }
}
```

Rules:
- Every field points back to the original text (NM-19).
- Secrets are references, never values, outside the credential store (DS-02/03).
- QA-IR is validated against a schema before planning (GV-15 "Validate").

## 13. Verdicts, PASS safety gate and user review

### 13.1 Verdicts (VD-10)

| Verdict | When | Counts as passed? |
|---|---|---|
| **PASS** | Every expectation proven by fresh evidence and the PASS gate holds, **or** the user clicked PASS (marked "decided by user") | Yes |
| **FAIL** | An expectation was evaluated and disproven by fresh evidence (APPLICATION root cause) | No |
| **NEEDS_REVIEW** | The engine cannot proceed or decide: ambiguity, unresolved reference, unknown condition branch. The user sees expected vs actual and decides (13.3). | No, until decided |
| **NOT_VERIFIED** | Steps ran, but an expectation cannot be observed through the UI (e.g. "email is sent") and no adapter exists | No |
| **BLOCKED** | A precondition failed or the run could not start | No |
| **UNSUPPORTED** | The test case contains an intent the engine does not support (VD-05) | No |
| **AUTOMATION_ERROR** | The engine or MCP failed (crash, tool missing) | No |
| **ENVIRONMENT_ERROR** | Environment down, network failure, deployment in progress | No |
| **TEST_DATA_ERROR** | Data missing, invalid for its class, account locked | No |

**There is no "PASS (with assumptions)"** (DEC-05).

### 13.2 PASS safety gate (VD-09) and terminal verification (GV-16)

PASS requires **all** of:
1. Test case understood (no UNSUPPORTED clause)
2. Every action understood and performed on a verified target
3. Test data resolved from a stated source (no invented value where an explicit one exists)
4. Every expectation evaluated
5. Evidence for each expectation is fresh (EX-07)
6. No ambiguity (LA-01), no contradiction (VD-04)
7. No vacuous assertion (EX-08)
8. No stale evidence, no automation or environment error
9. No assumption used for any expectation

If 1–8 hold but 9 does not, or an expectation cannot be proven, the result is **NEEDS_REVIEW** (13.3), never PASS.

### 13.3 User review flow (DEC-05)

```
Engine cannot prove an expectation
      │
      ▼
Review card:  Expected  |  Actual (observed)  |  Evidence (screenshot before/after, state delta)
      │
      ├── User clicks PASS → verdict PASS (decided by user, who, when)
      ├── User clicks FAIL → verdict FAIL (decided by user, who, when, optional note)
      └── User fixes the step/target → re-run
      │
      ▼
GV-01: the decision is learned as a concrete expectation where possible, so the next run decides automatically
```

- Identical items across a batch are merged into one card (VD-11).
- A user decision never changes the evidence. Both are kept.

---

## 14. Delivery phases

No fixed dates (owner decision). Each phase ends when the benchmark (GV-06) shows **wrong PASS = 0** and the phase's acceptance criteria pass.

| Phase | Builds | Why in this order |
|---|---|---|
| **0. Measure** | GV-06 benchmark (29 real cases with correct verdicts), GV-08, GV-09, GV-05, GV-13 | Every later change must be measured |
| **1. Language core** | IN-01…23 (gaps), NM-01…20, TK-01…15, RX-01…24, VO-01…02, SY-01…02, GR-01…11, CL-01…02, NG-01…02, CD-01…02, ON-01, IR-01 | Understanding is the main source of reviews |
| **2. Context and data** | CX-01…10, RF-01, ST-01…02, TD-01, DR-01, DG-01, DS-01…04 | Fixes wrong data and "added data"-type references |
| **3. Knowledge and locators** | AK-01, PK-01, LU-01, LC-01, LA-01, DM-01 | Removes target ambiguity |
| **4. UI orchestration** | UI-01…09 | Covers real-application controls |
| **5. Execution and verdicts** | EX-01…09, EXP-01, VD-01…11, AU-01…09 (login types, email OTP via adapter, TOTP), §13 user review | MCP execution, PASS gate, 9 verdicts, MFA/OTP |
| **6. Learning and governance** | GV-01…04, GV-07, GV-10…12, GV-14…16 | Learning with safety rules; full explainability |
| **7. Integrations (last, DEC-04)** | Jira import, TestRail import | Owner decision: last phase |

### Kept from the existing product (DEC-04)

| ID | Kept capability | Note |
|---|---|---|
| KP-01 | Web UI (import, review, results) | Gains the §13.3 review card |
| KP-02 | POM code export | = EXP-01 |
| KP-03 | Database (versioned migrations, history) | Stores QA-IR, verdicts, learned registries |
| KP-04 | API testing | Uses the same QA-IR with API steps |
| KP-05 | CI integration | Runs the benchmark gate (GV-13) and exported tests |

---

## 15. BRD traceability (completeness check)

Line numbers refer to the BRD text extracted on 2026-10-08 (174 lines). Every content line maps to at least one ID.

| BRD line | BRD item | Spec IDs |
|---|---|---|
| 6 | Core design principles | PR-01…PR-06 |
| 9–31 | Layer 1: 23 input features | IN-01…IN-23 (one per line, in order) |
| 33–51 | Layer 2: 19 normalization features | NM-01…NM-19 (one per line, in order) |
| 52 | Important data protection rule | NM-20 |
| 54–68 | Layer 3: 15 tokenization features | TK-01…TK-15 (one per line, in order) |
| 70 | Regex isolation policy | RX-01 |
| 71 | Pattern engines (10 types) | RX-02…RX-11 |
| 72 | Technical extraction fields (9) | RX-12…RX-20 |
| 73 | Regex safety and timeouts | RX-21 |
| 74 | Invalid regex detection | RX-22 |
| 75 | Priority and conflict detection | RX-23 |
| 76 | Versioning and verification suite | RX-24 |
| 78 | Action vocabulary (31 verbs) | VO-01 |
| 79 | Assertion vocabulary (16 words) | VO-02 |
| 81 | Granular synonym policy | SY-01 |
| 82 | Category directories (10) | SY-02 |
| 84 | 10 grammar models | GR-01…GR-10 |
| 85 | Positional parameter translation | GR-11 |
| 87 | Compound phrase splitter (13 connectors) | CL-01 |
| 88 | Multi-expectation segregation | CL-02 |
| 90 | Negation terms (17) | NG-01 |
| 91 | Clause-specific negation | NG-02 |
| 93 | Conditional keywords (10) | CD-01 |
| 94 | Conditional mapping validation | CD-02 |
| 96 | QA ontology (26 classes) | ON-01 |
| 98 | QA-IR | IR-01, §12 |
| 100 | Context engine (10 contexts) | CX-01…CX-10 |
| 102 | Reference resolution (13 phrases) | RF-01 |
| 104 | Lifecycle states (10) | ST-01 |
| 105 | Transition matrix (10 state kinds) | ST-02 |
| 107 | Data classes (17) | TD-01 |
| 109 | Resolver sources (8) | DR-01 |
| 111 | Deterministic generator | DG-01 |
| 113 | Redaction guardrails (4) | DS-01…DS-04 |
| 115 | Application knowledge base (13 fields) | AK-01 |
| 117 | Page knowledge base | PK-01 |
| 119 | Label consolidation | LU-01 |
| 121 | Locator hierarchy (11 levels) | LC-01 |
| 123 | Zero-tolerance ambiguity | LA-01 |
| 125 | DOM semantic inspection | DM-01 |
| 127 | Frames / shadow DOM | UI-01 |
| 128 | Tabs / windows | UI-02 |
| 129 | Modals / dialogs | UI-03 |
| 130 | Form boundaries | UI-04 |
| 131 | Control handlers (9 controls) | UI-05 |
| 132 | Table relational processing | UI-06 |
| 133 | Lists / cards | UI-07 |
| 134 | Keyboard and mouse | UI-08 |
| 135 | Wait / synchronization engine | UI-09 |
| 137 | Action planner | EX-01 |
| 138 | Playwright MCP execution | EX-02 (+ EXP-01 per DEC-01) |
| 139 | MCP capability manager | EX-03 |
| 140 | Observation engine | EX-04 |
| 141 | Before/after comparison | EX-05 |
| 142 | Expected result and assertion engines | EX-06 |
| 143 | Evidence freshness | EX-07 |
| 144 | Vacuous assertion guard | EX-08 |
| 145 | Business rules and boundaries | EX-09 |
| 147 | Authentication and authorization | VD-01, AU-01…AU-09 (DEC-03, PD-5) |
| 148 | Preconditions and postconditions | VD-02 |
| 149 | Dependency and isolation | VD-03 |
| 150 | Ambiguity and paradox interceptors | VD-04 |
| 151 | Unsupported intent guard | VD-05 |
| 152 | Recovery and retry limits | VD-06 |
| 153 | Root cause apportionment | VD-07 |
| 154 | Confidence invariant | VD-08 |
| 155 | PASS safety gate | VD-09, §13.2 |
| 156 | Granular verdicts (9) | VD-10, §13.1 |
| 157 | Human review and deduplication | VD-11, §13.3 |
| 159 | Deterministic learning | GV-01 |
| 160 | Locator contracts and audit | GV-02 |
| 161 | Explainability | GV-03 |
| 162 | Assumptions and configuration singletons | GV-04 |
| 163 | Deterministic decisions | GV-05 |
| 164 | Regression benchmark | GV-06 |
| 165 | Language coverage analytics | GV-07 |
| 166 | Review reduction metric | GV-08 |
| 167 | Wrong-PASS KPI | GV-09 |
| 168 | Information security | GV-10 |
| 169 | Performance and caching | GV-11 |
| 170 | Component version control | GV-12 |
| 171 | Automated protection gates | GV-13 |
| 172 | Quality pre-flight | GV-14 |
| 173 | Intent compilation sequence | GV-15 |
| 174 | Terminal verification protocol | GV-16, §13.2 |

**Count (checked by script on 2026-10-08):** all 139 content lines of the BRD map to the IDs above; the only unmapped lines are section and layer headings. The spec has **186 unique requirement IDs** (176 from the BRD, EXP-01 from DEC-01, AU-01…AU-09 from DEC-03 and PD-5), plus 6 principles (PR), 5 owner decisions (DEC) and 5 kept capabilities (KP). Controlled lists stay complete inside their ID: VO-01 holds all 31 action verbs, VO-02 all 16 assertion words, NG-01 all 17 negation terms, CD-01 all 10 conditional keywords, CL-01 all 13 connectors, ON-01 all 26 ontology classes, TD-01 all 17 data classes, DR-01 all 8 sources, AK-01 all 13 fields, LC-01 all 11 locator levels, RF-01 all 13 reference phrases.

## 16. Open points found while writing this spec

The BRD is complete but leaves these open. They do not block the spec; they need an owner answer before the phase that uses them.

| # | Point | Needed by |
|---|---|---|
| OP-1 | ~~"All 90 Features" vs the items listed~~ **Decided 8 Oct:** requirements are organised and counted per module and layer (§4.1). | Done |
| OP-2 | ~~Applicant and Expert in the ontology~~ **Decided 8 Oct (PD-3):** core ontology plus per-application classes. | Done |
| OP-3 | ~~Which OTP source?~~ **Decided 8 Oct:** the user selects the login type per application; for email OTP the system asks for the mailbox details and reads the OTP automatically (AU-01…AU-08). Still to confirm in Phase 5: which mail providers must be supported first (e.g. Gmail, Outlook/Microsoft 365, company mail server). | Phase 5 |
| OP-4 | NM-01 "lowercase where appropriate" vs NM-14 "preserve case-sensitive data": the spec lowercases only for matching, never for values. Confirm. | Phase 1 |
| OP-5 | NM-15 "preserve passwords: clear text integrity" vs DS-02/03 masking: the spec keeps exact values in memory and in the encrypted store, and masks them in all output. Confirm. | Phase 2 |
| OP-6 | ~~Regex refactor of the current code~~ **Decided 8 Oct (PD-1):** the new engine is built separately, so RX-01 applies to `src/engine/` from the start; the legacy code is not refactored. | Done |
| OP-7 | EX-02 vs EXP-01: when the MCP run and the exported code disagree on a verdict, which one is reported? Proposal: the MCP run, and the disagreement is an AUTOMATION_ERROR on the export. | Phase 5 |
| OP-8 | ~~Who marks the benchmark verdicts?~~ **Decided 8 Oct:** Claude drafts the answer key; the owner or a tester confirms each row by running it by hand. Done at E1.0 (release check). | E1.0 |
