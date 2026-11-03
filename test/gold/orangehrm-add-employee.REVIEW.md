# Gold readings to review: OrangeHRM Add Employee (E0.15)

DRAFT by Claude, 3 Nov 2026. The E0.15 exit test measures the engine against these readings (at least 90% of sentences read as approved), so they must be **yours**, not mine. Each distinct sentence of the 19 cases is below once; the 19 cases are built from them by `test/gold/make-add-employee-gold.ts`.

**How to review:** for each row, write OK in the last column, or what it should be. "A person decides" means the engine must not guess: it asks. When you are done, the readings are corrected and `review` is filled in with your name.

Readings follow the earlier gold sets: a browser-opening line is set aside; a check written as a step ("Checking…") is set aside as a step, and its reading is the expected result that goes with it; a page name ("navigate to … page") is a URL check on that page.

## Steps

| # | The tester wrote | Reading | Why | Your verdict |
|---|---|---|---|---|
| 1 | Open Browser | **a person decides** | opening a browser is the test setup, not something the application does | |
| 2 | Enter url for Orange Hrm server | NAVIGATE **application** | 'Enter url' means go to the application's address (the project's base URL), not type into a field; no address is written | |
| 3 | Checking the login section at middle of the page | **a person decides** | a check written as a step: its reading is the expected result that goes with it | |
| 4 | Checking the tabs of Admin,PIM (Personal Information Manager), Leave, Time, Benfits, Recruitment, Reports, Bug Tracker, Help are visible or not. Note:The PIM should be as Default Page. | **a person decides** | a check written as a step: its reading is the expected result that goes with it. The tabs show only after a login that no step writes: the case assumes it (E0.16 setup block) | |
| 5 | Under Employee Information Section there should be add button. Which should be in PIM page | **a person decides** | a check written as a step: its reading is the expected result that goes with it | |
| 6 | Click on the Add Button | CLICK **Add** |  | |
| 7 | Enter the valid code/id in code text box Note: Text box should accept only numbers | ENTER_VALUE **Code** (value: VALID) | the Note is a rule of the field (digits only), not the value to type | |
| 8 | Enter valid Last name in Last name text box. Note: Text box should accept only alphabets | ENTER_VALUE **Last Name** (value: VALID) | the Note is a rule of the field (letters only), not the value | |
| 9 | Enter valid First name in First name text box. Note: Text box should accept only alphabets | ENTER_VALUE **First Name** (value: VALID) | the Note is a rule of the field (letters only), not the value | |
| 10 | Enter valid Middle name in Middle name text box. Note:Text box should accept only alphabets | ENTER_VALUE **Middle Name** (value: VALID) | the Note is a rule of the field (letters only), not the value | |
| 11 | Enter valid Nick name in Nick name text box. Note:Text box should accept only alphabets | ENTER_VALUE **Nick Name** (value: VALID) | the Note is a rule of the field (letters only), not the value | |
| 12 | upload a photo by clicking upload button | UPLOAD **Photograph** | the photo file input; 'by clicking upload button' is how a person does it. No file is named: a valid image is needed | |
| 13 | Entered text boxes and uploaded photo should empty by clicking reset | CLICK **Reset** | the action inside a sentence written as a check; the check is the expected result that goes with it | |
| 14 | Click on Save | CLICK **Save** | TRAP: in these cases Reset (the step before) has just emptied the form, so this Save sends an empty form. The reading is still a click on Save | |
| 15 | To checking the added data in personal information page | **a person decides** | a check written as a step: its reading is the expected result that goes with it | |
| 16 | Click on Back Button | CLICK **Back** |  | |
| 17 | Click on Employee Name | CLICK **Employee Name** | the name of the employee added earlier, a link in the Employee Information list (a row: E0.16 ledger, E0.17 rows) | |
| 18 | Enter/update the Job Title, Employement Status, Sub-Division and Supervisor in respective fileds on Employment section | SELECT **Job Title** (value: VALID) | a dropdown on the employee's Job page; no value is given | |
|  | 〃 | SELECT **Employment Status** (value: VALID) | a dropdown; no value is given | |
|  | 〃 | SELECT **Sub Division** (value: VALID) | OrangeHRM 2.5 calls it 'Sub Unit'; a dropdown; no value is given | |
|  | 〃 | **a person decides** | OrangeHRM 2.5 sets a supervisor under 'Report-to', not on the Job page: a person must say what is meant | |
| 19 | checking the same updated records in Employee information page | **a person decides** | a check written as a step: its reading is the expected result that goes with it | |
| 20 | Select preferred Enployee/Employees and Click on Delete Button | CHECK **the added employee** | 'preferred employee' is the one this case added: its row's checkbox in the list (E0.16 ledger). Never any other employee | |
|  | 〃 | CLICK **Delete** |  | |

## Expected results

| # | The tester wrote | Reading | Why | Your verdict |
|---|---|---|---|---|
| 1 | User should open browser | **a person decides** | an environment fact (the test's own browser), not something the application shows | |
| 2 | User should navigate to login section of Oragne Hrm | URL **login** | a page name, not address text. 'section' and 'of Oragne Hrm' are not part of the name (the application's name, misspelt) | |
| 3 | Login section should be middle of the page | LAYOUT **login** | where the login box sits on the page ('middle'): a layout check. 'section' is the kind of thing, not its name | |
| 4 | User Should see tabs and PIM as a default page | VISIBILITY **tabs** | the tabs named in the step: Admin, PIM, Leave, Time, Benefits, Recruitment, Reports, Bug Tracker, Help | |
|  | 〃 | URL **PIM** | the page shown after login is PIM: a page name | |
| 5 | User should add button in employee information section | VISIBILITY **Add** | 'should add button' is a slip for 'should see the Add button', in the Employee Information section | |
| 6 | User should navigate to Add Employee page/popup | URL **Add Employee** | a screen name ('page/popup': whichever it is) | |
| 7 | Text box should accept values | VALUE **the field of its step** | the field of the step it belongs to holds the value typed | |
| 8 | Upload button should accept photo | VALUE **Photograph** | the photo file input holds the chosen file | |
| 9 | User should see the empty text boxes and uploaded photo | VALUE **each field filled in before (empty)** | every field filled in and the photo chosen earlier is empty after Reset (E0.16 ledger) | |
| 10 | User should naviagte to Personal Information page | URL **Personal Information** | a page name ('naviagte' is a typo) | |
| 11 | User should see added data | TEXT **Personal Information** | the values entered earlier are shown (E0.16 ledger). TRAP: Reset emptied them before Save, so there is no added data to see | |
| 12 | User should navigate to Employee Information page | URL **Employee Information** | a page name | |
| 13 | User should naviagte to Employment section | URL **Employment** | a section of the employee's details (Job in OrangeHRM 2.5): a screen name | |
| 14 | Respective fileds should accept the values | VALUE **Job Title** | each field of the step holds the value chosen | |
|  | 〃 | VALUE **Employment Status** | each field of the step holds the value chosen | |
|  | 〃 | VALUE **Sub Division** | each field of the step holds the value chosen | |
| 15 | User should updated the data | **a person decides** | says the data was updated without saying what shows it (a message? the values kept after Save?): a person must say what to check | |
| 16 | User should see the same updated records | TEXT **the employee's row** | the list row of the employee shows the values updated earlier (E0.16 ledger, a row: E0.17). 'same' points back to them | |
| 17 | User Should succesfully Deleted Employee Data | VISIBILITY NOT **the deleted employee's row** | the employee is no longer in the list. OrangeHRM asks to confirm the delete first | |

## Two things in the cases themselves (not readings)

1. From TC12 on, step 13 (Reset) empties the form and step 14 saves it: the Save sends an empty form, so "User should see added data" cannot hold. The tester probably meant Reset to be its own case (TC11).
2. No step logs in, yet the tabs (step 4) show only after a login: the cases assume one. E0.16 turns these setup lines into one setup block that logs in.
