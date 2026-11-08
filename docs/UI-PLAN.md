# U1: the project-first UI

| | |
|---|---|
| **Target** | The 14 mock-ups in `docs/ui-redesign/` (canvas: https://claude.ai/artifact/92PLbX7KtkoxPrj9YZSUCS) |
| **Checklist** | The gap check (https://claude.ai/artifact/AEun5ZCvS1E3VKB8A3bRnr): every action the app has today must still exist after the step that replaces its page |
| **Decisions (owner, 8 Nov 2026)** | Focus review with the Ripple map is in (step 6). The project-first layout replaces Dashboard / Test Cases / Web Automation / Releases; Automation and Releases become project tabs. Dark mode stays. One branch; per step only the tests of what changed, the full suite once at the end, then commit and merge. |

## Rules for every step
- No new UI library: React 19, our own small components, design tokens in `web/src/styles.css`.
- Light and dark from the same tokens; motion off under "reduce motion"; every action reachable by keyboard.
- Old addresses keep working: `/test-cases`, `/automation`, `/releases`, `/projects/:id?tab=…` redirect to the project pages.
- The UI tests (`src/server/ui.test.ts`, `review-ui.test.ts`, `walkthrough*.test.ts`) are updated in the step that changes their page, and each step adds tests for its screens.

## Steps

| # | Step | Screens | Server work |
|---|---|---|---|
| 1 | Foundation | Tokens (light and dark), fonts, shared parts, motion layer, the project sidebar, project routes, redirects | none |
| 2 | Start | All projects (welcome box, status ring, project cards, Today's focus, releases in progress), New project drawer | tile colour as a project setting; a live address check |
| 3 | Test cases | Overview, Test cases list, Upload, Case detail, Case form | none |
| 4 | Running | Live run with its questions, Plan check, Run result | none |
| 5 | Review | Project Review page with every E0.19 card part; "Remove this step" | `GET /api/projects/:id/review`; remove a step from the cases of a card |
| 6 | Focus review + Ripple map | One question at a time, keys, undo, the Ripple map | the ripple count |
| 7 | Walkthrough and Settings | Walkthrough, Settings, What the engine learned, Danger zone | none |
| 8 | Automation and Releases | A short design pass, then both as project tabs | none |
| 9 | Close | Accessibility, dark mode, phone width, all UI tests, the full suite, docs, CI green, merge | |

**Not built now:** "Move the note to Test Data" (with the engine's open "Note:" item), "Report as a bug" and "Likely cause" (no tracker, no cause explanations yet). The Yes/No page question on a card is a PASS/FAIL card, as the app decides it.

**Measured:** active review time and questions (E0.19 `engine:kpi`) on one real review session before step 5, and again after step 6.

## Status
- **Step 1, foundation (8 Nov 2026):**
  - **Look:** new tokens for light and dark (`web/src/styles.css`, same token names, so every page takes the new look), Inter and Space Grotesk with system fallbacks, the motion layer (off under "reduce motion"), and shared parts (`web/src/components/ui.tsx`: icons, chips, project tile).
  - **Shells** (`web/src/shell.tsx`): the project shell has a project switcher and the sections Overview, Test cases, Runs, Review, Automation, Releases and Settings; all projects and the guide have a top bar.
  - **Addresses** (`web/src/routes.ts`): `/projects/:id/<section>`; the old addresses redirect.
  - **Until their own step,** each section shows today's page:
    - Overview: run a workbook and a single test case.
    - Review: the open cards of the latest runs.
    - Settings: the project form, the rules and Delete.
    - Automation and Releases: today's pages for that project.
  - **Tests:** the UI tests were moved to the sidebar, and `src/server/routes.test.ts` was added.
- **Step 2, start (8 Nov 2026):**
  - **All projects** (`web/src/pages/HomePage.tsx`) replaces the Dashboard and the Projects list at `/` and `/projects`:
    - a welcome box with the greeting, the date, the last run, and Today's focus (the open question that covers the most test cases, with Answer it)
    - a ring of every test case by its last result
    - Questions to answer, Answers remembered, Approved, Scripts ready
    - a card per project, with filters All / Needs you / All passing
    - a New project card, and Releases in progress
  - **New project** is a drawer with every project setting, a tile colour and a live check of the address.
  - **Server:** project setting `tile`; `POST /api/probe`; `needs` and `blocked` on the dashboard; `GET /api/review-summary`.
  - **Tests:** `src/server/home.test.ts` added and `ui.test.ts` extended. The Dashboard, Projects and Test Cases pages were removed; nothing they showed is lost.
- **Step 3, test cases (8 Nov 2026):**
  - **Overview** (`web/src/pages/sections.tsx`): a live-run notice, the open questions of the last run (with the first suggestion) and Open review, the last run, the counts of test cases, and recent runs.
  - **Test cases:** filters (All, Needs you, Failed, Passed, Not run), search, Approve / Unapprove, Run again and Walkthrough on every row; Export, Upload and New test case in the page head.
  - **Upload** (`/projects/:id/upload`): run the test cases, or import only.
  - **New test case** (`/projects/:id/new-case`): the form, with tips.
  - **Test case page:**
    - numbered steps with the expected result of each, test data, expected result and type
    - runs, versions, and Automation with Approve
    - Walkthrough, Edit as a new version, Run again
    - Remove, which asks in the page instead of a browser pop-up
  - **Old addresses:** `?tab=workbook` and `?tab=single` open Upload and New test case.
- **Step 4, running (8 Nov 2026):**
  - **The page head** of a run: its status, what kind of run it is, the test case, when it started and finished; Run again or Cancel run.
  - **Live run:**
    - shows how far the run is and the state of each case, read from the run's own log (`web/src/progress.ts`)
    - the questions the run asks sit right below it
    - the log is open while the run goes and folded away once it is done
  - **Run result:**
    - five status tiles
    - a notice with Open review when cases need you
    - the review cards and the results table, whose test case cell was rearranged
  - **Plan check:** the new look; its actions are unchanged (Approve & Execute, Edit, Regenerate).
  - **Tests:** `src/server/progress.test.ts` added.
- **Step 5, review (8 Nov 2026):**
  - **One review for the whole project** (`web/src/pages/ReviewSection.tsx`, `GET /api/projects/:id/review`): the cards of its finished runs, each case only from its latest run, each card saying which run it is from. Filters: Needs you, Held, Decided, Answered; the held cases are listed; the sidebar shows the count of open questions beside Review.
  - **The review card:**
    - the sentence and why come first
    - a wording card leads with the answer: suggestions, the pattern, or "Or remove this step from N test cases" (`POST /api/jobs/:id/review-queue/remove-step`, `src/review/remove-step.ts`: a new version of each case, the steps numbered again, the expected results moved with their steps); what the run saw and PASS/FAIL are folded away below
    - a card about what the page showed has expected and actual, the pictures, then PASS / FAIL and the remembered note
    - decisions show with who and when; walkthrough per case; changed since this run; holds
  - **Tests:** `src/review/project-review.test.ts` added, and `review-ui.test.ts` extended.
- **Step 6, Focus review and the Ripple map (8 Nov 2026):**
  - **Focus review** (`/projects/:id/focus`, `web/src/pages/FocusReview.tsx`):
    - the open questions of the project one at a time, with a ring of how many are left
    - wording questions are answered with numbered options (the suggestions, Remove the step, write it yourself, which takes the pattern)
    - PASS/FAIL questions show expected and actual and decide with P and F; P does nothing where PASS is not offered
    - S skips, W opens a walkthrough, Z goes back
    - a strip shows Now, Next and Then, and the end says what was done
  - **The Ripple map** (`GET /api/jobs/:id/review-queue/ripple`, `ReviewService.ripple`): every test case of the project as a tile, by sheet, coloured by its last result; the ones the answer settles glow before it is given (for a wording question, every case of the project with that sentence, in every sheet). It also shows how many cases that is, the questions left, and what the engine will remember.
  - **Entry:** Focus review from the Review page.
  - **Tests:** a Ripple test in `project-review.test.ts`, and a browser test that answers with the keyboard in `review-ui.test.ts`.
- **Step 7, Walkthrough and Settings (8 Nov 2026):**
  - **Settings** has three tabs, kept in the address (`?tab=learned`, `?tab=danger`):
    - **Project:** the form with the live address check, and Saved after Save.
    - **What the engine learned** (`RulesTab`): filters by kind; a switch per entry (off: the engine asks again); Change the meaning in place (`updateRule`, checked like a new answer); Remove, which asks in the row; Export and Import; Teach it yourself.
    - **Danger zone:** Delete project.
  - **Walkthrough:** numbered step circles (current, done, failed), and a clearer "To save at the end" list; its behaviour is unchanged.
  - **Tests:** a browser test of the three tabs and of adding, changing, switching off and removing an entry (`ui.test.ts`).
- **Step 8, Automation and Releases (8 Nov 2026):** both are project sections (since step 1); now in the new look. Both have the page head of the other sections.
  - **Automation:** tiles for approved, scripts ready, out of date and not recorded; script and result chips; Record, Execute, Download script, Assertions and View script on each row; the expanded panel shaded.
  - **Releases:** New release in the head; each release a card with a side stripe and stat tiles, and its features, scope lock, date move and change log as before.
  - No mock-up was drawn first: the screens were checked on the running app instead.
  - **Tests:** `ui.test.ts` and `automation.test.ts` pass unchanged.
- **Step 9, close (8 Nov 2026):**
  - **Pop-ups:** the last browser pop-ups in Releases (deleting a release; removing a feature after the scope is locked, which asks why) are now asked in the page.
  - **Every screen checked** in light, dark and at phone width (390 px), with a Playwright script: sideways scrolling, controls without a name, fields without a label, images without alt text, and text contrast (WCAG 4.5:1, 3:1 for large text). Fixed:
    - every page scrolled sideways by about 80 px (the drifting glows); fixed with `overflow-x: clip` on the page
    - the green, red and blue status text on its pale chip was just under 4.5:1; the tokens are darker now
    - white text on the Ripple tiles and on the dark-mode PASS button; those colours are now the same in both themes
  - **Result:** the full suite once, then commit, merge and CI.
