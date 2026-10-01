import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// BASE_URL, TEST_USERNAME, TEST_PASSWORD… come from the environment or a git-ignored .env file.
const envFile = path.join(__dirname, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  testDir: './tests',
  outputDir: './reports/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
    ['./reporters/auto-qa-reporter.ts'],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:4173',
    testIdAttribute: 'data-testid',
    // Evidence for every run (FR-EV-01): a screenshot after each step, a video and a trace.
    screenshot: 'on',
    video: 'on',
    trace: 'on',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
});
