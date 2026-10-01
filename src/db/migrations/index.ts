import type { Migration } from '../migrate.js';
import { baseline } from './0001_baseline.js';
import { environments } from './0002_environments.js';
import { jobLogIds } from './0003_job_log_ids.js';

/** In order. A released migration is never edited: its checksum is checked at start (D26). */
export const MIGRATIONS: Migration[] = [baseline, environments, jobLogIds];
