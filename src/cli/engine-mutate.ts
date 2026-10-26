/**
 * The mutation harness: the new engine against the demo app broken on purpose, one fault at a time.
 *
 *   npm run engine:mutate                  run every case on the untouched app and on every mutant; exit 1 on any wrong PASS

 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { openExecutionSession } from '../engine/execute/index.js';
import { benchmarkText, MUTATIONS, mutationKey, mutationScore, runBenchmark, runMutationMatrix } from '../engine/governance/index.js';

const app = await startDemoApp();
const session = await openExecutionSession();
try {
  const results = await runMutationMatrix(app.url, session, mkdtempSync(path.join(tmpdir(), 'aq-mutate-')));
  const key = mutationKey('mutation harness', new Date().toISOString().slice(0, 10));
  const report = runBenchmark(key, results);
  const score = mutationScore(key, results);
  console.log(benchmarkText(report));
  console.log(
    `Mutation score: ${score.killed} of ${score.total} faults caught (${MUTATIONS.length} mutants)${score.survivors.length ? `; survived: ${score.survivors.join(', ')}` : ''}`,
  );
  if (!report.ok) process.exitCode = 1;
} finally {
  await session.close();
  await app.close();
}
