# Legacy engine baseline: what the current parser understands (no browser)

Measured 2026-10-11 on `feat/m8-database` with the legacy parser (`src/parser/`), before any engine work.
It reads each workbook with the importer and parses every case; a step or check counts as **understood** when the parser does not mark it `unparsed`.

**This is only the first half of the E0.0 review baseline.** It shows how much of the text the parser reads. It does **not** show how many cases need review when run against the real application: that needs a run against the OrangeHRM site (base URL and test user), and is still to be done (see `ENGINE-PLAN.md` E0.0 step 5).

| Workbook | Cases | Steps understood | Checks understood | Cases with every step and check understood |
|---|---|---|---|---|
| `OrangeHRM_Login_Test_Cases.xlsx` | 10 | 30 of 39 | 26 of 28 | 4 of 10 |
| `OrangeHRM_Login_Test_Cases_Updated.xlsx` | 10 | 39 of 39 | 26 of 28 | 9 of 10 |
| `Managing Employee Data.xlsx` (the Add Employee cases), steps from "Test Design Steps" | 19 | 0 of 228 | 235 of 248 | 0 of 19 |
| same workbook, steps from "Test Design Description" | 19 | 68 of 307 | 292 of 440 | 0 of 19 |

Notes
- Both workbooks were read from `Downloads`; the files themselves are not copied here.
- `Managing Employee Data.xlsx` has no column the importer recognises as steps. It was mapped by hand: id = `Test Case Id`, title = `Test Case Name`, expected = `Expected Results`, preconditions = `Test Case Description`. Its "Test Design Steps" column holds only "Step 1", "Step 2", ...; the real step text is in "Test Design Description". The two rows above are the two possible mappings; neither is right, which is the input-layout problem E0.2 sets out to fix.
- The Employee workbook is the PD-4 Add Employee file (the plan notes it holds the same 19 cases as `Add_Employee.xlsx`). No separate Employee list file exists yet.
