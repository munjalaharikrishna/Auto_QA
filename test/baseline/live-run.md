# Review baseline: the legacy engine run on the real application

Run on 2026-10-11 with the code of tag `baseline-before-engine` plus the E0.1 engine switch (the legacy path is unchanged), unattended, headless, with **no learned project rules** (fresh folders, so nothing from earlier sessions was reused).
Application: the local OrangeHRM 2.5.0.2 (`http://127.0.0.1/orangehrm-2.5.0.2/login.php`), user `cypress`. The password is not in these files.

This is the number every later engine version is measured against (GV-08): **cases set aside for a human, per workbook.**

| Workbook | Cases | PASS | NEEDS REVIEW | NOT VERIFIED | FAIL / BLOCKED |
|---|---|---|---|---|---|
| `OrangeHRM_Login_Test_Cases_Updated.xlsx` | 10 | 4 | **5** | 1 | 0 |
| `Managing Employee Data.xlsx` (Add Employee; steps mapped from "Test Design Description") | 19 | 0 | **19** | 0 | 0 |

Why they need review
- Login, 5 cases (TC_LOGIN_002, 003, 004, 007, 008): every one is the **expected result**, not a step. The sentence mixes an outcome with details ("Login is rejected and an appropriate invalid username/password error message is displayed"), and the legacy engine looks for an element called "appropriate invalid username" or "missing credentials" or "actual password" and cannot find it or finds several. Outcome wording is what E0.4 (clauses, negation) and E0.8 (verdicts) are for.
- Add Employee, 19 cases: all 19 stop on the same step, S6 "the page" ("I cannot tell what to do in 'the page'"), because of how the workbook lays out its steps (E0.2 input layer).

Engine switch check (E0.1): the same Login workbook run with `engine = semantic` gives **identical verdicts case by case** (4 PASS, 5 NEEDS REVIEW, 1 NOT VERIFIED). TC_LOGIN_001 passes on the real site, and its QA-IR and decision log (`TC_LOGIN_001.qa-ir.json`, `TC_LOGIN_001.decision-log.json`) show every compilation stage.

Files: `live-login-legacy.json`, `live-employee-legacy.json`, `live-login-semantic.json` (verdict per case and the review questions). Parse-only numbers are in `legacy-parse.md`.

Not the same as the figure in `SPEC.md` (9 of 10 login cases running with 1 not verified): that figure is for a project that already holds the answers learned in review. This baseline starts without them, which is the state of a new project.
