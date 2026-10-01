# Auto QA: Database Specification and Architecture

Part of [SPEC.md](SPEC.md) (requirements FR-DB-…, decisions D24–D28) and [ARCHITECTURE.md](ARCHITECTURE.md) §9. Diagrams are Mermaid.
**Status (2026-10-01):** M8 is in progress. Built: the driver and dialect layer, the migration runner (checksums, backup, downgrade guard), migrations 0001–0003 (baseline, environments + page routes + settings + counters + audit log, job log ids), the store moved to `src/db/` with a transaction API, and `npm run db -- status | backup | verify`. Everything else below is still the plan; §10 shows which steps are done.

**Contents**
1. [Goals](#1-goals)
2. [Where data lives today](#2-where-data-lives-today)
3. [Principles and decisions](#3-principles-and-decisions)
4. [Architecture](#4-architecture)
5. [Schema](#5-schema)
6. [Versioning and migrations](#6-versioning-and-migrations)
7. [Cross-cutting rules](#7-cross-cutting-rules)
8. [SQLite to PostgreSQL](#8-sqlite-to-postgresql)
9. [Testing the database layer](#9-testing-the-database-layer)
10. [Build plan (M8)](#10-build-plan-m8)
11. [Requirements (FR-DB)](#11-requirements-fr-db)
12. [Risks and open questions](#12-risks-and-open-questions)

---

## 1. Goals

| # | Goal |
|---|---|
| G1 | **One source of truth** for everything the platform knows: projects, test cases, explorations, locators, runs, results, history. No state is only in a JSON file. |
| G2 | **Survive every later version**: V2 (environments, locator repository, suites, history, API tests), V3 (team, PostgreSQL, recovery), V4 (traceability, defects) are *added* to the schema. They never need a rewrite or a manual data fix. |
| G3 | **Same code on a laptop and on a server**: SQLite now, PostgreSQL in V3, behind one interface (SPEC §3: "without a rewrite"). |
| G4 | **Safe upgrades**: a new Auto QA version upgrades the old database itself, with a backup first, and never loses data. |
| G5 | **No secrets, no machine paths** in the database (FR-ENV-05, NFR-03, SPEC §3 "no paths are hard-coded"). |
| G6 | **Deterministic and explainable** (NFR-02, NFR-08): a past result can be shown exactly as it was, with the test model, locators and code of that moment. |

Non-goals: the database does not store large files (screenshots, videos, workbooks, generated projects stay as files, referenced from the database), and it does not replace the generated project, which must run on its own without the platform (D15, NFR-04).

## 2. Where data lives today

| Data | Stored in | Problem |
|---|---|---|
| Projects, uploads, jobs, job logs, questions, verdicts | SQLite `.auto-qa/auto-qa.db` (7 tables, `CREATE TABLE IF NOT EXISTS`) | No migration versioning: a new column cannot be added safely. `projects.workspace` and `uploads.file` hold **absolute Windows paths**, so a move to a server breaks them. |
| Learned page URLs | `.auto-qa/pages.json`, keyed by origin | Global, not per project; no history; lost if the file is deleted. |
| Batch progress | `.auto-qa/batches/<key>.json` | Duplicates job state; key is a hash of the workbook path. |
| Exploration result per test | `explore/<TC>/exploration.json` | Cannot be searched ("which steps needed review?", "which tests use this locator?"). |
| Execution IDs `EXEC-YYYY-NNNNN` | Next number found by scanning `runs/` folders | Two runs at once could get the same ID; gone if `runs/` is cleaned. |
| Verdict per test | `verdicts.verdict` as one JSON blob | Cannot be filtered or aggregated (pass rate, flaky tests). |
| Test models | Re-parsed from the sheet each run | No version history of a test case; no "test case as it was at that run". |
| Locator fingerprints and history | `locators/*.locators.json` inside each generated project | Fine for the project (D16), but there is no cross-project search (FR-LR-04). |

The first milestone (M8) moves these into the database without changing what the user sees.

## 3. Principles and decisions

| ID | Decision | Why |
|---|---|---|
| **D24** | **Hybrid storage.** The database is the system of record for *metadata, structure and history*. Files hold *bulk artifacts* (screenshots, traces, videos, workbooks, generated projects). A row points to a file through a **storage reference**, never an absolute path. | Queries and history need rows; megabytes of PNG do not belong in them. Also keeps D15 (the generated project stands alone). |
| **D25** | **Portable SQL, two dialects.** One schema source rendered for SQLite and PostgreSQL. Only the common SQL subset is used (no triggers, no stored procedures, no vendor functions, no ORM-specific magic). Data access goes through **repositories**; no SQL outside `src/db/`. | G3. The V3 move is a driver change plus a data copy. |
| **D26** | **Forward-only, versioned, checksummed migrations**, applied automatically at start, **additive first** (expand, then contract in a later release). A backup is taken before any migration. The app refuses to run against a database newer than itself. | G4. Old and new versions must never corrupt each other's data. |
| **D27** | **Storage references.** A file is identified as `scheme:key` (`local:projects/orangehrm/explore/TC-1/S2.png`), relative to a configured root. `s3:bucket/key` arrives with V3 (`EvidenceStore`, ARCHITECTURE §14). | G5. Moving the data directory or going to S3 changes configuration, not rows. |
| **D28** | **Secrets.** V1: never in the database (FR-ENV-05 stays). V2: only as **AES-256-GCM ciphertext** in `secrets`, with the key outside the database. A secret value never appears in a log, an audit row, a JSON payload or an export. | NFR-03. A stolen database file must not leak a login. |

Supporting conventions (apply to every table):

- **Ids.** Text primary keys, prefixed and random for internal rows (`JOB-3fa9c2…`, as today). Human-facing ids keep their meaning and are **unique per project, not primary keys**: `TC-…` (from the sheet), `AUTO-…`, `EXEC-YYYY-NNNNN` (FR-EN-06). The only integer ids are `users.id` and append-only log tables.
- **Ownership on every row.** Each top-level row has `project_id`; each row a person creates has `created_by` → `users.id`. V1 has one user (`1`, Owner), so team mode needs no data migration (SPEC §3, ARCHITECTURE §9).
- **Time.** UTC, ISO-8601 `…Z` text in SQLite, `timestamptz` in PostgreSQL. Never local time.
- **No hard-coded paths, no secrets, no environment names** in code or rows.
- **Soft delete only where users can undo** (`deleted_at` on test cases, projects). History tables are append-only.
- **Optimistic locking.** Rows edited by people carry `version INTEGER`; an update says `WHERE id=? AND version=?`. Needed once two testers edit (V3), free to add now.

## 4. Architecture

```mermaid
flowchart TB
  subgraph app["Auto QA process"]
    api[Fastify API + WebSocket]
    jobs[JobRunner]
    cli[CLI tools]
    pipe[parse · explore · generate · run]
  end
  subgraph db["src/db (the only place SQL lives)"]
    repo["Repositories<br/>ProjectRepo · TestCaseRepo · ExecutionRepo · LocatorRepo · …"]
    uow["Unit of work (transaction)"]
    mig[Migration runner]
    drv["Driver interface<br/>query · exec · transaction"]
    sqlite[SQLite driver<br/>node:sqlite]
    pg[PostgreSQL driver<br/>pg · V3]
  end
  store["ArtifactStore<br/>local disk · S3 later"]
  api --> repo
  jobs --> repo
  cli --> repo
  pipe --> repo
  repo --> uow --> drv
  mig --> drv
  drv --> sqlite
  drv -.-> pg
  pipe --> store
  repo -. "storage refs" .-> store
  sqlite --> f1[(auto-qa.db)]
  pg -.-> f2[(PostgreSQL)]
  store --> f3[(evidence/ workspaces/)]
```

### 4.1 Layers

| Layer | Responsibility | Rules |
|---|---|---|
| **Driver** | Open a connection; run a statement with parameters; run a function in a transaction; report the dialect. Two implementations. | No business logic. `?` placeholders in SQLite; the PostgreSQL driver rewrites them to `$1…`. |
| **Dialect** | The few differences (§8): JSON type, timestamp type, boolean, upsert, full-text search, auto-increment. | Small and tested. A new difference is added here, never inline. |
| **Migration runner** | Applies pending migrations in order, records them, takes a backup, checks checksums. | §6. |
| **Repositories** | One per aggregate. Typed methods (`executions.start(...)`, `locators.usedBy(locatorId)`). Map rows ↔ domain types and validate JSON with the existing zod schemas. | The rest of the code sees domain types, never rows or SQL. |
| **Unit of work** | `db.transaction(async tx => …)`. A job step that writes several tables (a finished run: execution + results + steps + evidence) is **one transaction**. | No transaction spans a browser action or an `await` on the network. |
| **ArtifactStore** | Write and read files by storage reference. `LocalArtifactStore` now; `S3ArtifactStore` in V3. | Writes the file first, then the row. A crash leaves an orphan file (cleaned by §7.6), never a row pointing to nothing. |

The current `Store` class (`src/server/store.ts`) is split into repositories behind the same method names, so `app.ts` and `jobs.ts` change only their imports.

### 4.2 Configuration

```
AUTO_QA_DB=sqlite:.auto-qa/auto-qa.db        # default; relative to AUTO_QA_DATA
AUTO_QA_DB=postgres://user:pass@host/autoqa  # V3
AUTO_QA_DATA=.auto-qa                        # storage root (evidence, uploads)
```

SQLite uses WAL and `busy_timeout`; one writer at a time is fine for one laptop (jobs already run one at a time). PostgreSQL uses a pool.

### 4.3 Where each concern goes

```mermaid
flowchart LR
  sheet[Workbook upload] --> imp[Importer] --> tc[(test_cases<br/>test_model_versions)]
  tc --> ex[Explorer] --> exp[(explorations<br/>exploration_items)]
  exp --> gen[Generator] --> gp[(generated_files<br/>locators)]
  gp --> run[Executor] --> res[(executions · test_results<br/>step_results · check_results)]
  run --> ev[(evidence → files)]
  res --> rep[Reports · history · dashboards]
```

## 5. Schema

Notation: `PK`, `FK`, `UQ`. Types are portable names (`TEXT`, `INTEGER`, `BOOL`, `TS` = timestamp, `JSON`) rendered per dialect (§8). Every table below also has the conventions of §3 where they apply.
Tier = the version that first creates it: **V1** (built in M8), **V2**, **V3**, **V4**. A later tier is *designed now* so V1 columns already leave room (for example `environments`, `suite_id`, `browser`), and *built later*.

### 5.1 Entity overview

```mermaid
erDiagram
  USERS ||--o{ PROJECTS : owns
  PROJECTS ||--o{ ENVIRONMENTS : has
  ENVIRONMENTS ||--o{ PAGE_ROUTES : maps
  ENVIRONMENTS ||--o{ SECRETS : holds
  PROJECTS ||--o{ UPLOADS : receives
  PROJECTS ||--o{ IMPORT_MAPPINGS : remembers
  PROJECTS ||--o{ TEST_CASES : contains
  TEST_CASES ||--o{ TEST_MODEL_VERSIONS : versions
  TEST_CASES ||--o{ EXPLORATIONS : explored
  EXPLORATIONS ||--o{ EXPLORATION_ITEMS : steps
  PROJECTS ||--o{ PAGE_OBJECTS : generates
  PAGE_OBJECTS ||--o{ LOCATORS : owns
  LOCATORS ||--o{ LOCATOR_CHANGES : history
  LOCATORS ||--o{ LOCATOR_USAGES : "used by"
  TEST_CASES ||--o{ LOCATOR_USAGES : uses
  PROJECTS ||--o{ SUITES : groups
  SUITES ||--o{ SUITE_CASES : includes
  PROJECTS ||--o{ JOBS : runs
  JOBS ||--o{ JOB_LOGS : logs
  JOBS ||--o{ QUESTIONS : asks
  JOBS ||--o{ EXECUTIONS : triggers
  ENVIRONMENTS ||--o{ EXECUTIONS : "runs in"
  EXECUTIONS ||--o{ TEST_RESULTS : contains
  TEST_CASES ||--o{ TEST_RESULTS : "result of"
  TEST_RESULTS ||--o{ STEP_RESULTS : steps
  TEST_RESULTS ||--o{ CHECK_RESULTS : checks
  TEST_RESULTS ||--o{ EVIDENCE : captures
  EXECUTIONS ||--o| GENERATION_SNAPSHOTS : "code at run time"
  PROJECTS ||--o{ FLOWS : defines
  PROJECTS ||--o{ API_REQUESTS : "API tests (V2)"
  TEST_RESULTS ||--o{ FAILURE_CLASSIFICATIONS : "classified (V3)"
  LOCATORS ||--o{ RECOVERY_PROPOSALS : "healed (V3)"
  REQUIREMENTS ||--o{ SCENARIOS : "splits into (V4)"
  SCENARIOS ||--o{ TEST_CASES : "groups (V4)"
  TEST_RESULTS ||--o{ DEFECTS : "raises (V4)"
```

This refines [ARCHITECTURE.md §9](ARCHITECTURE.md#9-data-model): an **execution** is one Playwright run (many tests, as `runner.ts` already does), and a **test result** is one test inside it. Step results belong to the test result.

### 5.2 Platform core (V1)

**`schema_migrations`**: `version INTEGER PK`, `name TEXT`, `checksum TEXT`, `applied_at TS`, `app_version TEXT`, `duration_ms INTEGER`.
**`users`**: `id INTEGER PK`, `name`, `email NULL UQ`, `role` (`admin` | `qa` | `viewer`), `status` (`active` | `disabled`), `created_at`. Row `1` = Owner. Passwords and sessions are V3 (§5.9).
**`settings`**: `scope` (`global` | `project` | `user`), `scope_id`, `key`, `value JSON`, `updated_at`; `UQ(scope, scope_id, key)`. Replaces scattered files such as `checkboxes.json`.
**`counters`**: `name` (`execution`), `scope` (`2026`), `value INTEGER`; `UQ(name, scope)`. `EXEC-YYYY-NNNNN` comes from `UPDATE … SET value = value + 1 … RETURNING`, in one transaction. No directory scanning, no duplicate ids.
**`audit_log`** (append-only): `id INTEGER PK`, `at TS`, `user_id`, `project_id NULL`, `action` (`project.create`, `locator.approve`, `job.cancel`, …), `entity`, `entity_id`, `detail JSON` (never a secret). One row per user-visible change.

### 5.3 Projects and environments (V1, extended V2)

```sql
projects(
  id TEXT PK, owner_id INTEGER FK users, name TEXT, slug TEXT UQ,
  browser TEXT DEFAULT 'chromium',          -- D18
  test_id_attribute TEXT,
  workspace_ref TEXT,                       -- storage ref, relative (D27); replaces absolute `workspace`
  created_at TS, updated_at TS, archived_at TS NULL, version INTEGER DEFAULT 1)

environments(                               -- V1 creates exactly one row per project: "Default"
  id TEXT PK, project_id FK, name TEXT,     -- Development | QA | Staging | UAT | Production (FR-ENV-02)
  base_url TEXT, is_production BOOL DEFAULT 0,   -- NFR-09 guard
  is_default BOOL, created_at TS, updated_at TS, UQ(project_id, name))

page_routes(                                -- replaces .auto-qa/pages.json (D19, FR-ENV-03)
  id TEXT PK, environment_id FK, page_name TEXT, path TEXT,
  source TEXT,                              -- learned | tester | check
  created_at TS, updated_at TS, UQ(environment_id, page_name))

secrets(                                    -- V2 only. Never in V1 (FR-ENV-05)
  id TEXT PK, environment_id FK, name TEXT, -- TEST_USERNAME, TEST_PASSWORD
  ciphertext BLOB, nonce BLOB, key_id TEXT, -- AES-256-GCM, key outside the DB (D28)
  created_at TS, rotated_at TS, UQ(environment_id, name))
```

*Why environments now:* V1 has one environment, but creating the `environments` table in M8 with one default row lets V2 add Dev/QA/UAT as **new rows**, with no table split. `projects.base_url` is copied to `environments.base_url`, kept (read-only) for one release, then dropped (expand/contract, §6.3).

### 5.4 Test assets (V1, extended V2)

```sql
uploads(id TEXT PK, project_id FK, file_ref TEXT, original_name TEXT, sha256 TEXT, size_bytes INTEGER,
        uploaded_by INTEGER FK, created_at TS)
import_mappings(id TEXT PK, project_id FK, name TEXT, mapping JSON, created_at TS, UQ(project_id, name))   -- D21

test_cases(
  id TEXT PK,                               -- internal: TCS-…
  project_id FK, ext_id TEXT,               -- the sheet's id, e.g. TC-LOGIN-001; UQ(project_id, ext_id)
  title TEXT, type TEXT NULL, requirement_ref TEXT NULL,
  source_kind TEXT,                         -- workbook | form | jira | testrail (V2)
  source_ref TEXT, source_row INTEGER NULL, -- upload id + row, or an external key
  current_version INTEGER,
  created_by INTEGER FK, created_at TS, updated_at TS, deleted_at TS NULL, version INTEGER DEFAULT 1)

test_model_versions(                        -- immutable: edits add a version
  test_case_id FK, version INTEGER, PK(test_case_id, version),
  model JSON,                               -- the zod TestModel (src/model/test-model.ts)
  model_schema INTEGER,                     -- schema version of that JSON (§6.4)
  content_hash TEXT,                        -- hash of steps + assertions + data: dedupe, "same steps as TC-x"
  reason TEXT,                              -- import | edit | reimport | rediscover
  created_by INTEGER FK, created_at TS)

flows(id TEXT PK, project_id FK, name TEXT, model JSON, created_at TS, UQ(project_id, name))      -- V2 FR-PF-02
flow_uses(test_case_id FK, flow_id FK, PK(test_case_id, flow_id))                                   -- V2
suites(id TEXT PK, project_id FK, name TEXT, description TEXT, created_at TS)                       -- V2
suite_cases(suite_id FK, test_case_id FK, position INTEGER, PK(suite_id, test_case_id))             -- V2
```

`test_cases.current_version` plus immutable `test_model_versions` gives "the test case as it was at that run" (G6) and a re-import diff (V2 importer) without keeping copies of sheets.

### 5.5 Exploration and generation (V1)

```sql
explorations(
  id TEXT PK, project_id FK, test_case_id FK, model_version INTEGER, environment_id FK,
  job_id FK NULL, status TEXT,              -- complete | needs-review | failed | cancelled
  started_at TS, finished_at TS, result_ref TEXT,  -- full exploration.json kept as a file
  counts JSON)                              -- {steps, review, unparsed}

exploration_items(                          -- one row per step/check, queryable
  exploration_id FK, item_id TEXT,          -- S2, A1
  seq INTEGER, kind TEXT, phase TEXT, raw TEXT, action TEXT, status TEXT,
  resolved_by TEXT, strategy TEXT, locator_code TEXT, score REAL,
  page_name TEXT, effect TEXT, screenshot_ref TEXT, warnings JSON,
  PK(exploration_id, item_id))

generation_snapshots(                       -- "generated code at that time" (FR-HI-03)
  id TEXT PK, project_id FK, execution_id FK NULL, git_commit TEXT NULL,   -- V2 git commits
  manifest JSON,                            -- path → sha256 of every generated file
  archive_ref TEXT NULL, created_at TS)
```

Why items are rows: it answers "which steps most often need review?", "which pages are slowest to settle?" and feeds the V3 failure classifier and the V2 reuse of validated locators (FR-LR-02), none of which a folder of JSON files can.

### 5.6 Locator repository (V2, FR-LR-02…04)

```sql
page_objects(id TEXT PK, project_id FK, name TEXT, path TEXT, file_ref TEXT, UQ(project_id, name))
locators(
  id TEXT PK, page_object_id FK, key TEXT,  -- usernameInput
  code TEXT, strategy TEXT, role TEXT, accessible_name TEXT,
  fingerprint JSON,                         -- FR-LO-11
  validated_at TS, status TEXT,             -- active | proposed | retired
  success_count INTEGER, heal_count INTEGER, UQ(page_object_id, key))
locator_changes(                            -- append-only history (FR-LR-03)
  id INTEGER PK, locator_id FK, at TS, by_user INTEGER FK NULL,
  source TEXT,                              -- explore | rediscover | recovery | manual
  old_code TEXT, new_code TEXT, reason TEXT, approved BOOL, execution_id FK NULL)
locator_usages(test_case_id FK, locator_id FK, step_id TEXT, PK(test_case_id, locator_id, step_id))   -- "which tests use this locator?"
```

The JSON file in each generated project (D16) stays the runtime copy; these tables are its searchable mirror and history. The platform writes both in one operation, and a check (§7.7) reports any difference.

### 5.7 Execution, results and evidence (V1)

```sql
jobs(                                       -- exists today; extended
  id TEXT PK, project_id FK, kind TEXT, status TEXT,
  input JSON, output JSON, error TEXT, parent_job_id FK NULL,   -- review-queue re-run links back
  created_by INTEGER FK DEFAULT 1, created_at TS, started_at TS, finished_at TS)
job_logs(id INTEGER PK, job_id FK, at TS, level TEXT DEFAULT 'info', message TEXT)   -- INDEX(job_id, id)
questions(...)                              -- unchanged

executions(                                 -- one Playwright run
  id TEXT PK,                               -- EXEC-2026-00001 (from counters)
  project_id FK, environment_id FK, job_id FK NULL, suite_id FK NULL,
  trigger TEXT,                             -- job | cli | schedule | ci
  browser TEXT, status TEXT,                -- running | done | failed | cancelled
  totals JSON,                              -- {pass, fail, blocked, review}
  runner_version TEXT, playwright_version TEXT, mcp_version TEXT,
  started_at TS, finished_at TS, duration_ms INTEGER, created_by INTEGER FK)

test_results(                               -- replaces `verdicts`
  id TEXT PK, execution_id FK, test_case_id FK, model_version INTEGER,
  automation_id TEXT, status TEXT,          -- PASS | FAIL | BLOCKED | NEEDS REVIEW
  category TEXT NULL,                       -- Assertion | Locator | Application | …
  failed_step TEXT NULL, reason TEXT, expected TEXT, actual TEXT,
  attempt INTEGER DEFAULT 1,                -- V3 controlled retry
  duration_ms INTEGER, started_at TS, sheet_row INTEGER NULL, UQ(execution_id, test_case_id, attempt))
step_results(test_result_id FK, step_id TEXT, seq INTEGER, raw TEXT, result TEXT,
             duration_ms INTEGER, error TEXT NULL, PK(test_result_id, step_id))
check_results(test_result_id FK, check_id TEXT, seq INTEGER, raw TEXT,
              expected TEXT, actual TEXT, result TEXT, PK(test_result_id, check_id))

evidence(
  id TEXT PK, test_result_id FK, step_id TEXT NULL,
  kind TEXT,                                -- screenshot | trace | video | html-report | results-xlsx | log
  storage_ref TEXT, mime TEXT, size_bytes INTEGER, sha256 TEXT,
  masked BOOL DEFAULT 1,                    -- FR-EV-03: masking was applied before writing
  restricted BOOL DEFAULT 0, created_at TS, expires_at TS NULL)    -- retention (§7.5), Q3
```

`verdicts` stays for one release as a read-only compatibility view of `test_results`, then is dropped (§6.3). Every value in these tables has already been through the masking step, so a secret cannot reach them (FR-EV-03).

### 5.8 API tests (V2, FR-API)

`api_collections(id, project_id, name)` · `api_requests(id, collection_id, test_case_id, method, url_path, headers JSON, body JSON, position)` · `api_auth_profiles(id, project_id, kind, config JSON, secret_id FK NULL)` · `api_checks(request_id, kind, expected JSON)`.
They use the same `test_cases`, `test_model_versions`, `executions` and `test_results`, with `test_cases.source_kind` and a `type` of `api`. Only the request definitions are new (D14).

### 5.9 Team mode (V3, FR-TM)

`user_credentials(user_id PK, password_hash, algo, changed_at)` · `sessions(id, user_id, created_at, expires_at, ip)` · `api_tokens(id, user_id, hash, scope, expires_at)` · `project_members(project_id, user_id, role, PK(project_id, user_id))`.
Authorization is by `project_members.role` (Admin, QA Engineer, Viewer; FR-TM-02). Every repository method already takes `project_id`, so access control is one check at the API edge, not a change in every query. PostgreSQL row-level security can be added as defense in depth.

Intelligence (V3): `failure_classifications(test_result_id, category, confidence, rule, detail JSON)` · `recovery_proposals(id, locator_id, execution_id, candidate_code, score, status, decided_by, decided_at)` (D10: proposed, then approved) · `browser_matrix` is a column (`executions.browser`), not a table.

### 5.10 Enterprise (V4, FR-EN)

`requirements(id, project_id, ext_id, title, source)` · `scenarios(id, requirement_id, ext_id, title)` · `test_cases.scenario_id` (nullable column added then) · `defects(id, test_result_id, tracker, ext_key, url, status, created_at)` · `external_links(entity, entity_id, system, ext_key, synced_at)` for Jira/TestRail ids · `schedules(id, project_id, suite_id, cron, environment_id, enabled)` · `webhooks`/`ci_runs`.
The chain `REQ → SC → TC → AUTO → EXEC → result → BUG` (FR-EN-01) then is a join over keys that already exist from V1 (FR-EN-06), with no renumbering.

### 5.11 Indexes (V1)

| Table | Index | Serves |
|---|---|---|
| `test_cases` | `(project_id, ext_id)` unique; `(project_id, deleted_at)` | lookups from a sheet; lists |
| `test_results` | `(test_case_id, started_at DESC)`; `(execution_id)`; `(status)` | history of a test; a run's results; pass-rate queries |
| `executions` | `(project_id, started_at DESC)` | history list (FR-HI-02) |
| `step_results`, `check_results` | primary key | one result's detail |
| `jobs` | `(project_id, created_at DESC)`; `(status)` | job list; restart recovery |
| `job_logs` | `(job_id, id)` | live log tail |
| `exploration_items` | `(status)`; `(locator_code)` | review statistics |
| `evidence` | `(test_result_id)`; `(expires_at)` | a result's files; retention sweep |
| `locator_usages` | `(locator_id)` | "which tests use this locator?" |

Indexes are added with the table that needs them. A new index is its own migration (cheap, reversible by a later migration).

## 6. Versioning and migrations

### 6.1 Rules

1. A migration is a numbered file: `src/db/migrations/0007_add_environments.ts` (SQL per dialect, plus optional data steps written in code).
2. **Forward-only.** Fixes go in a *new* migration. A released migration is never edited; its stored checksum is compared at start and a mismatch stops the app.
3. **One transaction per migration** (SQLite and PostgreSQL both have transactional DDL). A failed migration changes nothing.
4. **Backup first.** Before applying any pending migration the runner copies the database (`auto-qa.db` → `backups/auto-qa-<yyyymmdd-hhmmss>-v<from>.db`, using SQLite's online backup; `pg_dump` hint for PostgreSQL). The last five backups are kept.
5. **Downgrade guard.** If the database has a migration the code does not know, the app refuses to start and says "this data was created by a newer Auto QA".
6. **Same result on both dialects.** CI migrates an empty database on SQLite and PostgreSQL and compares the resulting schema (§9).
7. **Data migrations are idempotent and batched**, and never load a whole table in memory.

### 6.2 Starting from the database that exists today

The current database (7 tables, no version table) is adopted, not recreated:

```mermaid
flowchart TD
  start[App starts] --> q1{schema_migrations exists?}
  q1 -- yes --> run[Apply pending migrations]
  q1 -- no --> q2{old tables exist?}
  q2 -- yes --> base["Stamp 0001_baseline (the current 7 tables), back up, then apply 0002…"]
  q2 -- no --> fresh[Create everything from 0001]
  base --> run
  fresh --> run
  run --> ok[Ready]
```

Then M8 migrations: `0002` environments and `page_routes` (copy `projects.base_url`, import `pages.json`), `0003` test cases and model versions, `0004` explorations, `0005` executions and results (copy `verdicts`), `0006` evidence, `0007` counters/settings/audit, `0008` convert absolute paths to storage references.

### 6.3 Expand and contract (how a column or table changes without breaking an older build)

| Step | Release | Example: move `projects.base_url` to `environments.base_url` |
|---|---|---|
| **Expand** | N | Create `environments`; copy the value; code writes **both**, reads the new one. |
| **Migrate** | N | Backfill any missed rows. |
| **Contract** | N+1 or later | Stop writing the old column; a later migration drops it. |

A rollback to release N−1 between steps still works because the old column was not removed yet. The same pattern retires `verdicts`.

### 6.4 JSON payload versions

Columns that hold JSON (`test_model_versions.model`, `exploration_items.warnings`, `jobs.input`, `jobs.output`, `locators.fingerprint`) carry a schema version, either in a `*_schema` column or inside the object. On read, an **upcaster** chain (`v1 → v2 → v3`) turns old payloads into the current shape and the repository validates the result with zod. Stored data is rewritten only by an explicit migration, never silently on read. The Structured Test Model already has `version` (ARCHITECTURE §10), so a change to it is: bump version, add an upcaster, add a migration only if a query needs the new field as a column.

**Rule for JSON vs columns:** anything that is *filtered, joined, sorted or aggregated* is a column. A payload that is *read whole* and shown is JSON. When a JSON field starts to be queried, it is promoted to a column by an expand migration.

### 6.5 Release discipline

- Every release note lists its migrations and whether a backup is advised manually (large data changes).
- A migration that takes long prints progress and can be resumed.
- `auto-qa db status` shows the version, pending migrations, backups and the database size.

## 7. Cross-cutting rules

### 7.1 Security and secrets
No password, token or secret value in any table in V1 (FR-ENV-05). V2 `secrets` holds ciphertext only; the key comes from an OS-protected file or environment variable (`AUTO_QA_KEY`), with a `key_id` so keys can rotate. `audit_log.detail` and job logs go through the same masking function as reports (FR-EV-03). On Windows the database file inherits the user's folder permissions; on the server a dedicated PostgreSQL role has no superuser rights. Exports (§8.3) exclude `secrets` unless explicitly re-encrypted for the target.

### 7.2 Concurrency and transactions
SQLite: WAL, `busy_timeout=5000`, one writer. Jobs already run one at a time; the API only reads or does short writes. PostgreSQL (V3 workers): short transactions, `SELECT … FOR UPDATE SKIP LOCKED` for the job queue behind `JobQueue` (ARCHITECTURE §14), optimistic `version` for edits. `counters` increments are atomic in both.

### 7.3 Crash safety and restart
On start, jobs left in `running`/`waiting`/`review`/`queued` are marked `failed` ("the server stopped…"), as today. Executions left `running` are closed the same way. The artifact is written before the row (§4.1), so there are orphan files at worst, never dangling rows.

### 7.4 Integrity
Foreign keys on (`PRAGMA foreign_keys=ON` in SQLite). `CHECK` constraints for closed value sets (`status IN (...)`) so a typo cannot be stored; the value lists live in one TypeScript file used for both the `CHECK` text and the types. Deleting a project is an explicit, transactional cascade (rows then files), not `ON DELETE CASCADE` surprises.

### 7.5 Retention (open question Q3)
`evidence.expires_at` plus a project setting (`retention.evidence_days`, default: keep everything in V1). A sweeper deletes expired files then rows. Results and step rows are small and kept; heavy artifacts (video, trace) expire first. Restricted evidence (FR-EV-…) is never exported.

### 7.6 Orphans and verification
`auto-qa db verify` checks: every `storage_ref` exists; every file under the data directory is referenced or reported as an orphan; every locator row matches its project's locator JSON; foreign keys hold; counters are at least the largest id used. It reports; `--fix` removes orphans only after listing them.

### 7.7 Backup, restore, export
`db backup` (online copy), `db restore <file>` (stops if the file's migration version is newer), and a **project export/import** as a portable bundle (NDJSON per table plus the artifact folder, manifest with versions). The bundle format is the same one used for the SQLite → PostgreSQL move.

### 7.8 Search
V2 locator search ("which tests use `#username`?") is plain indexed SQL on `locator_usages`. Free-text search over titles, steps and reasons goes through a `SearchIndex` interface: SQLite FTS5 now, PostgreSQL `tsvector` later. It is a derived index, rebuildable from the tables, so it never needs its own migration of truth.

### 7.9 Reporting and dashboards (V2 reports, V4 dashboards)
Pass-rate trends, flaky tests (same test, both PASS and FAIL in a window) and most-healed locators are SQL over `test_results`, `executions` and `locators.heal_count`. If a query gets slow, add a **rollup table** (`daily_test_stats`) filled after each execution; it is derived and rebuildable. No materialized views (not portable to SQLite).

### 7.10 Observability
Slow-query log above a threshold (default 200 ms) with the repository method name, never the parameters. Migration timings are in `schema_migrations.duration_ms`.

## 8. SQLite to PostgreSQL

### 8.1 Dialect map

| Concern | SQLite | PostgreSQL |
|---|---|---|
| Timestamp | `TEXT` ISO-8601 UTC | `timestamptz` |
| JSON | `TEXT` (validated by zod; `json_extract` only in dialect code) | `jsonb` |
| Boolean | `INTEGER 0/1` | `boolean` |
| Auto id (log tables) | `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint GENERATED ALWAYS AS IDENTITY` |
| Upsert | `INSERT … ON CONFLICT … DO UPDATE` | same |
| Returning | `RETURNING` (3.35+) | same |
| Placeholders | `?` | `$1…` (driver converts) |
| Full text | FTS5 | `tsvector` |
| Binary | `BLOB` | `bytea` |

Every statement uses only the common subset on the left-hand side of this table, so most repository code has no dialect branches.

### 8.2 Driver choice
`node:sqlite` is built in (no native build, good for Windows) but is **experimental in Node 22**. The `Driver` interface hides it: if its API changes, only `SqliteDriver` changes (alternative: `better-sqlite3`). PostgreSQL uses `pg`. Query building stays hand-written SQL in repositories (small, readable, and no ORM to bend around the dialect differences); a query builder (Kysely) is an option if repositories grow (open question Q9).

### 8.3 Moving a laptop to a team server
1. `auto-qa db export` on the laptop: bundle of NDJSON + artifacts + manifest.
2. Start the Docker Compose stack with `AUTO_QA_DB=postgres://…` (the migrations create the schema).
3. `auto-qa db import bundle` loads rows in dependency order inside one transaction, re-creating references against the new `ArtifactStore`.
4. `db verify` on the server. Ids, `EXEC-…` numbers and history are unchanged, so links and sheets that mention them stay valid.

## 9. Testing the database layer

| Test | What it proves |
|---|---|
| **Migrate from empty** on SQLite and PostgreSQL | The full chain applies; the two resulting schemas are equal (table, column, type class, index names, compared from a dump). |
| **Upgrade fixtures** | A committed database file for each released version (`fixtures/db/v0.1.0.db` is the current shape) is migrated to head; data is intact and queries return the same rows. This is how "works with future versions" is enforced: a release that breaks an old database fails CI. |
| **Repository contract suite** | The same test file runs against both drivers (in-memory SQLite, PostgreSQL in CI service container). |
| **Checksum guard** | Editing a released migration fails the build. |
| **Downgrade guard** | A database with an unknown migration stops the app with the right message. |
| **Crash tests** | Kill the process between file write and row write, and mid-run; `db verify` finds only orphan files. |
| **No-secret scan** | After a full demo run with a password, the database file, logs and exports contain no password (FR-ENV-05 acceptance). |
| **Export / import round trip** | SQLite → bundle → PostgreSQL → bundle → SQLite gives identical data. |

## 10. Build plan (M8)

M8 sits between V1 and V2 and unblocks the V2 items that need rows. No screen changes except where listed.

| # | Work | Requirements |
|---|---|---|
| 1 ✅ | `src/db/`: `Driver`, `SqliteDriver`, dialect, migration runner, `schema_migrations`, backup, downgrade guard; adopt the current database as `0001_baseline` | FR-DB-01…05 |
| 2 ✅ | Move `Store` to `src/db/` with the same methods (now async) and a transaction API; tests. *Deviation:* one `Store` class, not one class per aggregate, until it grows; the SQL is already only in `src/db/` | FR-DB-06, FR-DB-07 |
| 3 ◐ | `0002` environments + `page_routes` ✅ (created, `Store.pageRoutes`/`savePageRoute`, a Default environment per project). **Still to do:** `loadPageUrls`/`savePageUrls` use the table instead of `pages.json`, and import `pages.json` | FR-DB-08, FR-ENV-01, D19 |
| 4 | `0003` `test_cases` + `test_model_versions`; the importer and the form write them | FR-DB-09 |
| 5 | `0004` explorations + items; keep `exploration.json` as the artifact | FR-DB-10 |
| 6 | `0005` executions, test results, step and check results; `counters` replaces the folder scan for `EXEC-…`; the batch and job code write them in one transaction; `verdicts` becomes a view | FR-DB-11, FR-DB-12 |
| 7 | `0006` evidence + `ArtifactStore` with storage references; `0008` convert absolute paths | FR-DB-13, FR-DB-14 |
| 8 | Result and history reads come from the database (the result screen, the workbook write-back, review queue); batch progress files are retired in favour of `test_results` | FR-HI-01, FR-HI-06, FR-IN-08 |
| 9 ◐ | `db status`, `db backup`, `db verify` ✅ (`npm run db`). **Still to do:** `restore`, `export`, `import`, a committed upgrade fixture per release, the PostgreSQL schema comparison in CI | FR-DB-15…18 |

Also done in 0003 (not in the original list): job log lines get a real `id` so they order the same way on both databases.

**Done when** a fresh install and the current `.auto-qa/auto-qa.db` both reach the same schema; a demo-app workbook run leaves no state only in JSON files other than the artifacts; deleting `pages.json`, `batches/` and `runs/` metadata changes nothing the UI shows; and a database from the previous release upgrades in CI.

After M8, the V2 schema (§5.3 secrets, §5.4 flows/suites, §5.6 locators, §5.8 API) is **added by migrations**, one per V2 feature.

## 11. Requirements (FR-DB)

| ID | Requirement | Version |
|---|---|---|
| FR-DB-01 | All platform metadata and history is stored in the database; JSON files are only artifacts referenced from rows | V1 (M8) |
| FR-DB-02 | Versioned, checksummed, forward-only migrations applied automatically at start, in one transaction each | V1 (M8) |
| FR-DB-03 | A backup is taken before any migration; the last five are kept | V1 (M8) |
| FR-DB-04 | The app refuses to start on a database created by a newer version | V1 (M8) |
| FR-DB-05 | The existing database is adopted as the baseline migration with no data loss | V1 (M8) |
| FR-DB-06 | All SQL lives in `src/db/` behind repositories; the driver is replaceable | V1 (M8) |
| FR-DB-07 | A finished run is written in one transaction | V1 (M8) |
| FR-DB-08 | An `environments` table exists from V1 with one default environment per project; learned page URLs are stored as `page_routes` | V1 (M8) |
| FR-DB-09 | Test cases are stored with immutable model versions and a content hash | V1 (M8) |
| FR-DB-10 | Exploration results are stored as queryable items, with the full result kept as a file | V1 (M8) |
| FR-DB-11 | Executions, test results, step results and check results are stored; any past result can be reopened with its model version and generated-code snapshot | V1 (M8) |
| FR-DB-12 | `EXEC-YYYY-NNNNN` ids come from a transactional counter | V1 (M8) |
| FR-DB-13 | Files are referenced by storage reference (`scheme:key`), never by absolute path | V1 (M8) |
| FR-DB-14 | Evidence rows record kind, size, hash, and whether masking was applied | V1 (M8) |
| FR-DB-15 | `db status`, `db backup`, `db restore`, `db verify` commands | V1 (M8) |
| FR-DB-16 | `db export` / `db import` portable bundle | V1 (M8) |
| FR-DB-17 | No secret value in any table, log, audit row or export in V1 | V1 (M8) |
| FR-DB-18 | CI upgrades a committed database from every released version and compares SQLite and PostgreSQL schemas | V1 (M8) |
| FR-DB-19 | Locator tables with change history and usage mirror (FR-LR-02…04) | V2 |
| FR-DB-20 | Encrypted `secrets` (AES-256-GCM, key outside the database, rotation by `key_id`) (FR-ENV-04) | V2 |
| FR-DB-21 | Suites, flows, API test definitions and execution history queries | V2 |
| FR-DB-22 | Evidence retention sweeper with a per-project setting | V2 (Q3) |
| FR-DB-23 | PostgreSQL driver, sessions, project members and roles | V3 |
| FR-DB-24 | Failure classification, retry attempts and recovery proposals | V3 |
| FR-DB-25 | Requirements, scenarios, defects, external links and schedules | V4 |
| FR-DB-26 | Rollup tables for dashboards if queries need them | V4 |

## 12. Risks and open questions

| Risk | Mitigation |
|---|---|
| `node:sqlite` is experimental in Node 22 | `Driver` interface; `better-sqlite3` as fallback; CI pins the Node version (`.nvmrc`) |
| Dialect drift (works on SQLite, fails on PostgreSQL) | Common SQL subset only; every repository test runs on both; schema comparison in CI |
| A bad migration corrupts a tester's data | Transaction per migration, backup first, upgrade fixtures, downgrade guard |
| Data and files go out of step | File first, row second; `db verify`; export/import checks hashes |
| M8 touches the code the UI depends on | Same method names on the repositories; `verdicts` kept as a view for one release; M8 is done step by step, each with the test suite green |
| JSON payloads grow without a version | `*_schema` columns and upcasters; a lint test fails a JSON column without one |

| # | Question | Needed by |
|---|---|---|
| Q3 | How long is evidence kept? (also in SPEC §13) | V2 |
| Q8 | Is one SQLite file per project preferable to one for all projects (easier delete/share) or is one file plus export enough? Proposed: one file plus export. | M8 |
| Q9 | Hand-written SQL repositories (proposed) or a query builder such as Kysely? | M8 |
| Q10 | Should the database ever hold generated source code, or only a manifest and snapshots (proposed: manifest, with the code in the project's git repo from V2)? | V2 |
| Q11 | Do result sheets (`.results.xlsx`) count as evidence to keep, or can they be regenerated from `test_results`? Proposed: regenerate. | M8 |
