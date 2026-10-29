# Auto QA: What Commercial Tools Do, and What to Copy (28 Oct 2026)

| | |
|---|---|
| **Purpose** | Learn from mabl, testRigor, Tricentis Tosca, Testim, Katalon, ACCELQ, Leapwork, Virtuoso, Functionize, Reflect, Ghost Inspector, Autify, Rainforest, QA Wolf, Applitools, Percy, Playwright, Cypress, Cucumber and Robot Framework, and apply their **techniques** in Auto QA. Auto QA does **not** use these tools. |
| **Constraint** | No AI or LLM. Each technique is marked **DET** (deterministic) or **AI**; only DET versions are recommended. |
| **Method** | Web research of public documentation, engineering blogs, papers and patents. Pages opened and read are linked. Where a site blocked access (mabl help center, some Testim and Leapwork pages), only the search-result summary was available: those are marked *(summary only)* and are less certain. |
| **Related** | [AUDIT-2026-10-25.md](AUDIT-2026-10-25.md) (audit IDs U, E, S, P), [ENGINE-PLAN.md](ENGINE-PLAN.md) §10 (the build plan that applies this document) |

---

## 1. The common principle

> **First learn the application, then read the test case against it. Never guess at run time: anything uncertain gets its own status and a human decision, made once and remembered.**

Most "AI" features in these tools (self-healing, smart waits, smart locators) are deterministic underneath: weighted attribute matching, ordered fallback lists, frame paths and load-state waiting.

---

## 2. Understanding plain-English steps

| Tool | Mechanism | Type | Source |
|---|---|---|---|
| testRigor | Fixed English commands with targets in quotes: `click "cart"`, `enter "Peter" into "First Name"`, `check that page contains "…"`, `save value … as "name"`, ordinals (`click on the 3rd "hello"`), relative position (`below`, `near`), tables (`at row containing "id1" and column "Actions"`), alternatives (`"A" or "B"`) | Mostly DET; element references use ML; optional AI mode | https://testrigor.com/docs/language/ |
| Cucumber | Cucumber Expressions: `{int}`, `{string}`, optional text `cucumber(s)`, alternatives `belly/stomach`, custom parameter types; keywords (Given/When/Then) ignored when matching | DET | https://cucumber.io/docs/cucumber/cucumber-expressions , https://cucumber.io/docs/gherkin/reference/ |
| Robot Framework | Keywords with embedded arguments (`Select ${animal} from list`), best-match rule, `--dryrun` checks syntax without running | DET | https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html#embedding-arguments-into-keyword-name |
| Tricentis Tosca | No English parsing: a step is a scanned **Module** + attribute + **ActionMode** (Input, Verify, Buffer, WaitOn…) + value | DET, model-based | https://docs.tricentis.com/tosca-2026.1/en-us/content/tbox/action_modes.htm |
| ACCELQ | Statements built by picking an element in a recorded view and choosing an operation | DET core | https://support.accelq.com/hc/en-us/articles/360052600191-Creating-Action-logic-from-UI-Views |
| Research (IBM, ICSE 2012) | Each manual step split into (action, target, data) segments; ambiguity resolved by **trying options against the running application**; over 82% of steps automated without help | DET (search) | https://moss.csc.ncsu.edu/~mueller/seminar/fall12/suresh-112612.html , https://patents.justia.com/patent/20130227366 |

**Copy into Auto QA:** a typed slot grammar instead of phrase lists (optional words, alternatives, a verb table: hides → not visible, return to → navigate); ignore "Given/When/Then" and "user should". **Fixes:** U3, U6, U7.

## 3. Learning the application first

| Tool | Mechanism | Source |
|---|---|---|
| Tosca XScan | Scans the app into Modules first; warns when a control is not unique; rescan shows a diff before update | https://docs.tricentis.com/tosca-cloud/en-us/content/create_tests/scan_xscan.htm , https://documentation.tricentis.com/tosca/1430/en/content/tosca_commander/synchronizing_xmodules.htm |
| ACCELQ | Element repository per context; unknown elements must be named before use | https://support.accelq.com/hc/en-us/articles/115006672328-How-do-I-insert-a-new-statement-from-an-element-in-the-View-Canvas |
| testRigor / Playwright | Elements found by what the user sees (text, label, role); Playwright locators are strict: an action fails if more than one element matches | https://testrigor.com/docs/language/ , https://playwright.dev/docs/locators |

**Copy into Auto QA:** scan each page (including iframes) into a page model **before** reading test cases; match step words against it strictly (exact → normalised → synonym → overlap; element type must fit; a tie stops). **Fixes:** U2.

## 4. Setup blocks and references to earlier data

| Tool | Mechanism | Source |
|---|---|---|
| testRigor rules | Named, parameterised step sequences; "Find and Replace Steps" turns repeated steps into a rule call | https://testrigor.com/certification/rules/ |
| Tosca | Reusable TestStepBlocks with business parameters; **Buffer** / XBuffer store run-time values | https://docs.tricentis.com/tosca-2025.1/en-us/content/tosca_commander/reusable_teststepblocks.htm |
| Gherkin / Robot / Katalon | `Background`, `Suite Setup`, test listeners run setup before each case | https://cucumber.io/docs/gherkin/reference/ |
| mabl | Parameterised, nested flows; variables from element values *(summary only)* | https://help.mabl.com/docs/parameterized-flows |

**Copy into Auto QA:** repeated setup lines become one setup block; a **data ledger** records every entered or created value so "the entered details" and "the added employee" refer to it. **Fixes:** U4, U5.

## 5. Finding elements, iframes and identical elements

| Tool | Mechanism | Type | Source |
|---|---|---|---|
| Reflect | Several unique selectors per element, ordered by specificity (test attributes first); first one that uniquely finds a **visible** element wins; iframe selector recorded with the element | DET | https://support.smartbear.com/reflect/docs/en/recording/create-resilient-tests.html , https://support.smartbear.com/reflect/docs/en/recording/supported-actions.html |
| Ghost Inspector | Backup selectors tried in order within the element timeout | DET | https://docs.ghostinspector.com/test-editor/ |
| Testim | Target + parent attributes with weights; colour shows non-unique selectors; auto-improve only when validation passes, saved as a revision | DET-like scoring | https://docs.tricentis.com/testim/content/editing-tests/editing-your-tests/editing-target-element-properties.htm , https://www.testim.io/blog/announcing-auto-improving-smart-locators-dare-we-say-genius-locators/ |
| Katalon | Ordered locator methods; iframe stored as the object's parent | DET (+ optional LLM stage) | https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio , https://docs.katalon.com/katalon-studio/keywords/using-keywords-in-katalon-studio/web-testing/handling-iframe-issue-with-katalon-studio |
| Telerik Test Studio | Frame matched by Id/Name/BaseUrl, index only as back-up | DET | https://www.telerik.com/teststudio/documentation/automated-tests/elements/frames |
| Playwright | `frameLocator` chains; strict locators; narrow with `filter({hasText, has})`; `nth()` not recommended | DET | https://playwright.dev/docs/api/class-framelocator , https://playwright.dev/docs/locators |
| Cypress | Retry frame + document + body together before using iframe content | DET | https://www.cypress.io/blog/working-with-iframes-in-cypress |
| Virtuoso | Anchor to nearby unique text, then the element | heuristic | https://docs.virtuoso.qa/guide/making-the-most-of-virtuoso/elements/ |

**Copy into Auto QA:**
- every locator carries its **frame path** (name/id → src → index); if unknown, search **all frames** and accept exactly one match
- an ordered list of unique locators per element, plus a weighted fingerprint (role, name, label, text high; class low) for fallbacks
- repeated widgets anchored to their **row or section**; position only as a logged tie-breaker; nested same-named containers → the innermost
- **Fixes:** E1, E2, E4, E5, E6

## 6. Waiting after actions

| Tool | Mechanism | Type | Source |
|---|---|---|---|
| Playwright | Actionability: visible, stable, enabled, editable, receives events; frame events `framenavigated`/`framedetached`; `networkidle` discouraged in favour of web assertions | DET | https://playwright.dev/docs/actionability , https://playwright.dev/docs/api/class-frame , https://playwright.dev/docs/navigations |
| Katalon Smart Wait | Waits for the DOM to settle and background requests to finish; checks visibility, stability, topmost, enabled, editable | DET | https://docs.katalon.com/katalon-studio/keywords/using-keywords-in-katalon-studio/web-testing/wait-and-enhanced-waiting-&-checking-keyword-logic |
| mabl Intelligent Wait | Uses timing history of earlier passing runs *(summary only)* | statistical | https://help.mabl.com/docs/how-intelligent-wait-works |
| Reflect | Retries before a step until the element is visible and interactable | DET | https://support.smartbear.com/reflect/docs/en/recording/create-resilient-tests.html |

**Copy into Auto QA:** after each action, listen for frame navigation; if a frame navigates, wait for **that frame** to load, then for requests to finish and the DOM to go quiet; on "execution context destroyed" or "frame detached", wait again and retry once; never reuse element handles across steps. **Fixes:** E3.

## 7. Self-healing without false PASS

| Tool | Safeguard | Source |
|---|---|---|
| Katalon | Never heals verify, wait or "not present" steps (warns of false positives); healed locators go to an approve/discard list | https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio |
| mabl | Heals only on a strong match, fails on low confidence; saves heals only if the whole test passes *(summary only)* | https://help.mabl.com/docs/how-auto-heal-works , https://help.mabl.com/hc/en-us/articles/19078598947092-Reviewing-auto-heals |
| Autify | A healed step is "Review Needed": neither passed nor failed | https://help.autify.com/docs/review-needed-flag |
| Virtuoso | High confidence: healed and revertible; lower: a proposal to accept; too low: no heal | https://docs.virtuoso.qa/guide/making-the-most-of-virtuoso/elements/ |
| Functionize | Healing "cannot override a failed verification" | https://www.functionize.com/blog/self-healing-tests-arent-magic-heres-whats-actually-happening-under-the-hood |

**Copy into Auto QA:** heal clicks and typing only, never checks; a healed step gets the status **PASS-HEALED (review needed)**; a heal is kept only after approval and only from a passing run. **Fixes:** S2, S3, S6.

## 8. Honest verdicts

| Practice | Source |
|---|---|
| Web-first, auto-retrying assertions; present vs visible are different checks | https://playwright.dev/docs/test-assertions , https://playwright.dev/docs/best-practices , https://helpcenter.autify.com/docs/actions-and-assertions |
| A negative check can pass before the app has rendered: assert the loaded state first | https://glebbahmutov.com/blog/negative-assertions |
| A pass on retry is "flaky", not passed | https://playwright.dev/docs/test-retries |
| Mutation testing: change the app on purpose; a test that still passes is weak | https://research.google/pubs/state-of-mutation-testing-at-google/ |
| The oracle problem: without a specification, a human is the oracle | https://discovery.ucl.ac.uk/1471263/ |

**Copy into Auto QA:**
- every expected result produces at least one real check; otherwise the result is not PASS
- statuses: **PASS / FAIL / INCONCLUSIVE / PASS-HEALED**; "not found" reported separately from "found but hidden"
- "not displayed" passes only after the page is proven loaded, all frames were searched, and no fallback locator was used
- **Fixes:** S1, S2, S5, S6

## 9. Review once, remember safely

| Tool | Mechanism | Source |
|---|---|---|
| Percy | Approvals carry forward: an identical approved snapshot stays approved on later builds; new snapshots always need approval | https://www.browserstack.com/docs/percy/visual-testing-workflows/view-percy-build-results/approval |
| Applitools | Identical differences grouped and decided once; warns that broad acceptance can mask changes | https://applitools.com/tutorials/concepts/reviewing-tests/test-maintenance |
| Playwright snapshots | A new snapshot fails until accepted, "so new snapshots don't pass silently" | https://playwright.dev/docs/aria-snapshots |
| Ghost Inspector | "Accept New Screenshot as Baseline" after review | https://docs.ghostinspector.com/comparing-screenshots/ |
| testRigor / Tosca / Robot | Reusable rules referenced not copied; conflicts must be resolved explicitly | https://testrigor.com/certification/rules/ , https://docs.tricentis.com/tosca-2026.1/en-us/content/tosca_commander/teststep_libraries.htm |

**Copy into Auto QA:**
- people see only ambiguous, not-found, vague and healed items, grouped, with candidates on a screenshot
- each approval stored by a **fingerprint of the step** (locator + action + expected value): unchanged means no review next time
- taught rules become **versioned library entries with an example**; rejected if they reduce or weaken checks; active only after approval
- **Fixes:** S3, review volume

## 10. Record once (optional, for hard cases)

| Tool | Mechanism | Source |
|---|---|---|
| Playwright codegen | Records actions; picks role/text/test-id locators and refines them until unique; saves login state | https://playwright.dev/docs/codegen |
| Rainforest | Capture "the smallest area that is still unique"; duplicates make tests flaky | https://help.rainforestqa.com/docs/screenshot-best-practices |
| Autify / mabl | Record steps, then add assertions by clicking elements *(mabl: summary only)* | https://helpcenter.autify.com/docs/actions-and-assertions |

**Copy into Auto QA:** for a case with unresolved questions, a tester records it once; the recording is aligned to the Excel steps by order, action type and word overlap; only the gaps go to review.

## 11. Test data, environment and metrics

| Practice | Source |
|---|---|
| Log in once, save `storageState`; one account per worker; negative-login tests start with an empty state | https://playwright.dev/docs/auth , https://playwright.dev/docs/test-parallel |
| Setup/teardown as projects; seed and clean up through the API | https://playwright.dev/docs/test-global-setup-teardown , https://playwright.dev/docs/api-testing |
| Quarantine flaky tests with an owner, a cap and a time limit | https://www.atlassian.com/blog/atlassian-engineering/taming-test-flakiness-how-we-built-a-scalable-tool-to-detect-and-manage-flaky-tests , https://www.martinfowler.com/articles/nonDeterminism.html |
| Metrics: flake rate, persistent flakes, skipped tests, unique errors, time to root cause | https://www.qawolf.com/blog/six-metrics-to-gauge-the-real-impact-of-test-coverage |

**Copy into Auto QA:**
- one account per parallel worker; Excel credentials used exactly as written for negative tests (a build check fails if a "wrong password" equals the real one)
- unique names for created data, a clean-up list per run, a nightly sweep
- one frozen baseline; KPIs: wrong PASS, wrong FAIL, flake rate, reviews per 100 steps, review time
- **Fixes:** S4, P3, P5, inconsistent KPIs

---

## 12. The flow for Auto QA

| # | Stage | Fixes |
|---|---|---|
| 1 | **Scan the app** into page models, iframes included | U2 |
| 2 | **Lint the sheet**: understood / matched / ambiguous / not found / vague, with suggestions | vague results |
| 3 | **Slot grammar** instead of phrase lists | U3, U6, U7 |
| 4 | **Match words to the page models strictly**; a tie stops | U2 |
| 5 | **Setup blocks and a data ledger** | U4, U5 |
| 6 | **Frame-aware locating and per-frame waiting**; row/section anchors | E1–E6 |
| 7 | **Honest verdicts**: PASS / FAIL / INCONCLUSIVE / PASS-HEALED; negative-check guard; no healing on checks | S1, S2, S5, S6 |
| 8 | **Review once, remember safely**: approval fingerprints, versioned rules with examples | S3 |
| + | Optional: record once for hard cases | ambiguity |
| + | Answer key and broken-app tests; per-worker accounts; data clean-up; fixed KPIs | measurement, S4, P3, P5 |

The build plan for this flow is in [ENGINE-PLAN.md §10](ENGINE-PLAN.md#10-flow-realignment-versions-e012e019).
