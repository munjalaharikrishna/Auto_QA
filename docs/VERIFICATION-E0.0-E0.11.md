# Version-by-version verification: E0.0 to E0.11 (29 Oct 2026)

| | |
|---|---|
| **What was checked** | Every exit test of [ENGINE-PLAN.md](ENGINE-PLAN.md) §4 for E0.0 to E0.10, matched to the test that covers it and run again on the code as it is now (after Packages 1 to 7). E0.11 is not in the plan; it is checked by its own tests and by the live run. |
| **How** | Each version's test files were run as one group (two files at a time). The new engine was then run on the real OrangeHRM login workbook, headless, against the local OrangeHRM 2.5.0.2: the database was read from a snapshot copy, nothing was written to it, no record was created. |
| **Code changes made by the verification** | None. |
| **Marks** | ✅ the test exists and passes now · 🟡 partly: it passes, but not all of what the row asks · ❌ does not hold, or cannot be run · ❓ cannot be checked from here |

## 1. Result in one table

| Version | Rows | ✅ | 🟡 | ❌ | ❓ | Tests run now |
|---|---|---|---|---|---|---|
| E0.0 Clean start | 5 | 2 | 1 | 1 | 1 | lint, type check, git, baseline files |
| E0.1 Foundation | 5 | 4 | 0 | 1 | 0 | 33 of 33 |
| E0.2 Input | 5 | 5 | 0 | 0 | 0 | 31 of 31 |
| E0.3 Text and patterns | 6 | 6 | 0 | 0 | 0 | 85 of 85 |
| E0.4 Language to QA-IR | 10 | 10 | 0 | 0 | 0 | 87 of 87 |
| E0.5 Context and data | 6 | 6 | 0 | 0 | 0 | 55 of 55 |
| E0.6 Knowledge and locators | 6 | 6 | 0 | 0 | 0 | 60 of 60 |
| E0.7 MCP execution and UI | 7 | 5 | 0 | 2 | 0 | 41 of 41 |
| E0.8 Verdicts and review | 9 | 7 | 1 | 1 | 0 | 62 of 62 |
| E0.9 Login types and OTP | 8 | 7 | 0 | 1 | 0 | 44 of 44 |
| E0.10 Learning and governance | 8 | 5 | 3 | 0 | 0 | 95 of 95 |
| E0.11 Semantic fallback (not in the plan) | n/a | | | | | 86 of 86 |
| **All** | **75** | **63** | **5** | **6** | **1** | **679 of 679** |

All 679 tests in these groups pass. The six ❌ and the five 🟡 are things the tests do not cover or cannot cover, and **one of them is a real defect that the live run found** (section 2).

## 2. The finding that matters most

**A valid login from the sheet fails on the new engine, on the real site.** TC_LOGIN_001 ("valid login", expected PASS, and PASS on 11 Oct) gives **FAIL**: the login form is still shown, with "Invalid Login".

Cause, shown without printing any secret:
- The legacy parser replaces the sheet's password with `••••` in the test data it keeps (`parser/index.ts`, `rawTestData: mask(raw.testData)`, there since the first commit).
- The product's run path (`run-cases.ts`, `rawOf`) and the compare tool give that masked text to the new engine.
- The new engine reads `Password: ••••` as an explicit value and **types the four bullet characters as the password**. The sheet's real password is 8 characters. With the unmasked sheet data the value resolves correctly (the same length and value as the sheet's and the `.env`).

Effect: every case whose password comes from the sheet logs in with a wrong password. TC_LOGIN_001 becomes a wrong FAIL (not a wrong PASS), and TC_LOGIN_003 (a wrong password on purpose) is right only by accident. It is the audit's open finding "legacy masks secrets before the new engine sees them" (AUDIT §2, S4), and it means the live login set is worse than the 11 Oct baseline (see section 4).

This was not changed: it is outside what you asked of the verification.

## 3. Row by row

### E0.0 Clean start

| Exit test | Result | Evidence |
|---|---|---|
| Full test suite | ✅ | 1,076 of 1,076 passed in the last complete run (before Packages 6 and 7); the groups run now are 679 of 679. A fresh complete run after Package 7 has not been done. |
| Type check and lint | ✅ | Lint (322 files) and both type checks are clean. |
| Git | ❌ | `main` holds all committed work and is on `origin` (the engine branches are 0 commits ahead of it). The tag `baseline-before-engine` is **local only**. **89 uncommitted entries.** |
| Review baseline | 🟡 | Files are in `test/baseline/`. Three figures disagree (plan §6, `live-run.md`, `review-baseline.json`): see AUDIT §5. |
| CI | ❓ | `.github/workflows/ci.yml` runs lint, type check, web build and tests. Whether it ran and passed on the pushed commits cannot be seen from here (no GitHub access). |

### E0.1 Foundation

| Exit test | Result | Evidence |
|---|---|---|
| QA-IR schema, 20 valid and 20 broken | ✅ | `engine.test.ts`: "accepts twenty valid documents", "rejects: … naming the field", "has twenty broken documents" |
| Pipeline contract | ✅ | "stops a stage that returns the wrong shape, naming the stage and the field" |
| Determinism | ✅ | "gives an identical QA-IR, plan and decision log on every run" |
| Engine switch | ✅ | "leaves the legacy engine exactly as it was" (`skeleton.test.ts`). Note: the new engine is now the default (E1.0 was done before E0.12 to E0.19, which the plan v2.0 puts first). |
| Walking skeleton on the real site | ❌ | The skeleton test passes on the demo app. On the real OrangeHRM, TC_LOGIN_001 gives **FAIL**, not the correct PASS (section 2). |

### E0.2 Input, E0.3 Text and patterns, E0.4 Language, E0.5 Context and data, E0.6 Knowledge and locators

All 33 rows ✅. Each row maps to a named test, for example: Add_Employee 228 rows to exactly 19 cases and the broken workbook naming the missing column (E0.2); 500 test-data values byte-identical, the 200-sentence token golden set, the regex isolation scan (E0.3); the 110-sentence grammar golden set, TC_LOGIN_005/006/007 clause negation, the unsupported and paradox sets, the 5 Oct traps (compile part), the first measurement (E0.4); TC_LOGIN_002 uses the sheet's values, the secret scan DS-03 (E0.5); the DOM fixture pages in real Chrome, the label-cell page, candidate order, per-application vocabulary (E0.6).

### E0.7 MCP execution and UI

| Exit test | Result | Evidence |
|---|---|---|
| Each UI scenario on the demo app | ✅ | `execute.test.ts`, `frames.test.ts`, `cards.test.ts` (UI-07 added in Package 7) |
| "Click Edit for John" on page 2 of a sorted table | ✅ | "the row on page 2 of the table, found across pages" |
| Before/after delta | ✅ | "lists exactly what a failed login changed, and nothing else" |
| MCP tool missing | ✅ | "is BLOCKED, naming the tool" |
| No-sleep scan | ✅ | `units.test.ts` |
| OrangeHRM login cases on the real site | ❌ | Only **6 of 10 run end to end**: TC_LOGIN_005, 006 and 007 stop at the step that leaves a field blank (`VALUE_UNRESOLVED`), and TC_LOGIN_010 is not run (compiles to review). |
| Employee list cases (PD-4) | ❌ | **No such workbook exists.** The plan marks it as the owner's to provide. |

### E0.8 Verdicts and user review

| Exit test | Result | Evidence |
|---|---|---|
| Verdict matrix, 9 verdicts | ✅ | `verdict.test.ts` |
| Freshness | ✅ | "an error already on the page before the click is not accepted" |
| Vacuous set (5 Oct) | ✅ | "rejects the 5 Oct checks … never PASS" |
| Confidence invariant | ✅ | "changing every confidence changes no verdict" |
| User review: stored with who and when, "decided by user" | ✅ | The library test, and since Package 6 the endpoints, the database table and the screen (105 related tests passed then; 62 of 62 now) |
| Dedupe | ✅ | "4 cases with the same cause are one card" |
| Basic learning (BP-4) | 🟡 | The library test passes. In the product a person's PASS/FAIL is **not** turned into a rule for the next run (Package 6 left that out on purpose). |
| T5 traps, full run on the real site | ✅ | **0 wrong PASS** in the 9 login cases that ran |
| Login 10 cases match the 5 Oct hand-check | ❌ | The hand-check document was not found, so they were scored against the answer key, which is an unsigned draft. TC_LOGIN_001 is a wrong FAIL (section 2); TC_LOGIN_005 to 008 are set aside where the key expects PASS. See section 4. |

### E0.9 Login types and OTP

7 rows ✅ (Packages 2 and 3): adapter interface and local mailbox; 20 logins in a row with a mailed code; an old mail is ignored; no mail gives ENVIRONMENT_ERROR "OTP mail not received"; a wrong code is an ordinary test; TOTP against the RFC 6238 vectors; no OTP or secret in any output. One row ❌: the **settings screen per login type** is not built (a decision left open in Package 2). One intermittent failure of the 20-login test was seen once, under load, and not reproduced (3 runs).

### E0.10 Learning and governance

| Exit test | Result | Evidence |
|---|---|---|
| User maps "Login Name" to a field; next run uses it; report shows who and when | 🟡 | Learned entries are used by a run and keep who and when; the results report does not show it. |
| Learning safety (the 5 Oct rule) | ✅ | The rewrite is refused; the four live rules that judged nothing are quarantined (Package 5) |
| Switch off or edit a learned entry | ✅ | `learning.test.ts`, the rules screen |
| A PASS/FAIL with a visible message becomes a check the next run uses | 🟡 | Passes in the library; not connected in the product (as BP-4 above). |
| Protection gate | ✅ | `governance.test.ts`. The gate itself currently **blocks**: review reduction is 10.0%, below the 80% minimum. |
| Cache on and off | ✅ | `cache.test.ts` (reusing page snapshots was deliberately not built) |
| Audit trail | ✅ | `audit.test.ts` (the new engine only) |
| KPI report | 🟡 | Review reduction and wrong PASS per module are printed, from the compile and from the answer key, not from run-time reviews. |

### E0.11 Semantic fallback (not in the plan)

86 of 86 tests pass. The live run shows the fallback cannot yet get a valid login right on the real site (section 2).

## 4. The real OrangeHRM login workbook, new engine

| Case | Result now | Answer key (draft) | Why |
|---|---|---|---|
| TC_LOGIN_001 | **FAIL** | PASS | The masked password was typed (section 2). A wrong FAIL, not a wrong PASS. |
| TC_LOGIN_002, 003, 004 | NEEDS REVIEW | NEEDS REVIEW | The page showed "Invalid Login", not the wording the sheet expects. As the key says. |
| TC_LOGIN_005, 006, 007 | NEEDS REVIEW | PASS | The step that leaves a field blank cannot be done (`VALUE_UNRESOLVED`). Not run to the check. |
| TC_LOGIN_008 | NEEDS REVIEW | PASS | "the actual password text is not visible" is a check that cannot fail, so it is not accepted. |
| TC_LOGIN_009 | PASS | PASS | Both checks proven. |
| TC_LOGIN_010 | not run | NEEDS REVIEW | Compiles to review. As the key says. |

**Wrong PASS: 0.** Totals now: 1 PASS, 1 FAIL, 7 NEEDS REVIEW or not run. The 11 Oct baseline was 4 PASS, 5 NEEDS REVIEW, 1 NOT VERIFIED, so the live login set has fewer PASS than before. The cause is the masked password plus the blank-field step, not a wrong PASS.

## 5. The six ❌ and what each needs

| # | What | Needs |
|---|---|---|
| 1 | E0.0 git: the tag is not on `origin`; 89 uncommitted entries | Your decision on committing and pushing (you asked for no git changes) |
| 2 | E0.1 walking skeleton on the real site | The masked-password fix (section 2) |
| 3 | E0.7 login cases on the real site: 6 of 10 end to end | The masked-password fix, and the executor step that leaves a field blank |
| 4 | E0.7 Employee list cases (PD-4) | **You** provide the Employee list workbook |
| 5 | E0.8 login cases against the hand-check | The hand-check document, or a signed answer key |
| 6 | E0.9 settings screen per login type | A decision to build it |

## 6. Other things found while verifying

- **Other versions are better than the earlier estimate.** Rows that looked missing from a code scan (IN-06 and others) are covered; the earlier "about 80% done" was too low for E0.1 to E0.6, which pass fully.
- **No GitHub access from here:** CI results and the tag on `origin` could not be checked.
- **A fresh full run after Package 7** has not been done; the grouped runs above cover the engine, review, learning and pipeline tests, not every file in the project.
