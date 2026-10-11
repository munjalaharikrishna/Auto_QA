/**
 * Milestone 6: run a generated project and report PASS / FAIL / BLOCKED / NEEDS REVIEW with expected vs actual.
 *
 *   npm run execute -- workspaces/saucedemo
 *   npm run execute -- workspaces/saucedemo --id TC-LOGIN-001 --env-file .env
 *
 * Credentials come from the environment, --env-file, or the workspace's own .env (FR-ENV-05).
 * The run and its evidence are kept in .auto-qa/runs/<EXEC-ID>/.
 */
import { existsSync } from 'node:fs';
import { runWorkspace } from '../executor/runner.js';
import { formatRun } from '../results/report.js';

const args = process.argv.slice(2);
const valueFlags = ['--id', '--env-file'];
const all = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const [workspace] = args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
if (!workspace) {
  console.error('Usage: npm run execute -- <workspace> [--id TC-1 …] [--env-file .env]');
  process.exit(1);
}
const envFile = all('--env-file')[0];
if (envFile && existsSync(envFile)) process.loadEnvFile(envFile);

const run = await runWorkspace(workspace, {
  testIds: all('--id'),
  onEvent: (e) => {
    if (e.event === 'test-begin') process.stdout.write(`▶ ${e.testId}\n`);
    if (e.event === 'step-end') process.stdout.write(`   ${e.status === 'passed' ? '✔' : '✖'} ${e.step}\n`);
  },
});
console.log(`\n${formatRun(run)}`);
process.exitCode = run.verdicts.every((v) => v.status === 'PASS') ? 0 : 1;
