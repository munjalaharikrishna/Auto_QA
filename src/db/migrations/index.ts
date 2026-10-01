import type { Migration } from '../migrate.js';
import { baseline } from './0001_baseline.js';
import { environments } from './0002_environments.js';
import { jobLogIds } from './0003_job_log_ids.js';
import { testCases } from './0004_test_cases.js';
import { projectRules } from './0005_project_rules.js';

/** In order. A released migration is never edited: its checksum is checked at start (D26). */
export const MIGRATIONS: Migration[] = [baseline, environments, jobLogIds, testCases, projectRules];
