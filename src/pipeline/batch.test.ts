import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { buildDemoWorkbook } from '../../examples/demo-app/make-workbook.js';
import { DEMO_USER, startDemoApp } from '../../examples/demo-app/server.js';
import type { Resolver } from '../explorer/controller.js';
import { defaultParserConfig } from '../parser/index.js';
import { type BatchResult, runBatch } from './batch.js';

/**
 * M6b end to end: a tester's workbook → every case run unattended → results in a copy (FR-IN-08, FR-HI-06).
 * Needs Google Chrome, no internet. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = path.join(root, '.auto-qa', 'test-batch');
const unattended: Resolver = { choose: async () => 'skip', pageUrl: async () => 'abort', confirm: async () => false };

describe('batch run of a workbook (M6b)', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  const file = path.join(base, 'suite.xlsx');
  let rows: Awaited<ReturnType<typeof buildDemoWorkbook>>;
  let first: BatchResult;
  let originalHash: string;
  const progress: string[] = [];
  const options = () => ({
    config: defaultParserConfig(),
    baseUrl: app.url,
    env: { TEST_USERNAME: DEMO_USER.username, TEST_PASSWORD: DEMO_USER.password, TEST_WRONG_PASSWORD: 'nope' },
    resolver: unattended,
    exploreDir: path.join(base, 'explore'),
    runsDir: path.join(base, 'runs'),
    batchesDir: path.join(base, 'batches'),
    workspace: path.join(base, 'workspace'),
    onProgress: (m: string) => progress.push(m),
  });

  before(async () => {
    app = await startDemoApp();
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    rows = await buildDemoWorkbook(file, 12);
    originalHash = createHash('sha1').update(readFileSync(file)).digest('hex');
    first = await runBatch(file, options());
  });
  after(async () => {
    await app?.close();
  });

  it('gives every row the result its case should get', () => {
    for (const r of rows) {
      const got = first.results.find((x) => x.row === r.row);
      const status = got?.verdict?.status ?? (got?.problem ? 'NEEDS REVIEW' : undefined);
      assert.equal(status, r.expect, `row ${r.row} ${r.id} (${r.kind}): ${got?.verdict?.reason ?? got?.problem}`);
    }
    const expected = { PASS: 0, FAIL: 0, BLOCKED: 0, 'NEEDS REVIEW': 0 };
    for (const r of rows) expected[r.expect as keyof typeof expected]++;
    assert.deepEqual(first.summary.totals, expected);
  });

  it('writes the results into a copy and leaves the workbook alone (D23)', async () => {
    assert.equal(createHash('sha1').update(readFileSync(file)).digest('hex'), originalHash);
    assert.equal(first.out, path.join(base, 'suite.results.xlsx'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(first.out);
    const ws = wb.getWorksheet('Regression')!;
    const header = (ws.getRow(2).values as string[]).slice(1);
    const status = header.indexOf('Status') + 1;
    const actual = header.indexOf('Actual Result') + 1;
    const failing = rows.find((r) => r.kind === 'wrong-expectation')!;
    assert.equal(ws.getRow(failing.row).getCell(status).text, 'FAIL');
    assert.match(
      ws.getRow(failing.row).getCell(actual).text,
      /"Changes saved" was not shown\. The page showed page \/profile; heading "Profile"; message "Profile saved"\./,
    );
    const queue = wb.getWorksheet('Auto QA')!;
    assert.equal(queue.getCell('B7').value, first.summary.totals['NEEDS REVIEW']);
  });

  it('lists what needs the tester in the review queue (FR-HI-07)', () => {
    const ids = first.summary.review.map((q) => q.testId).sort();
    const want = rows
      .filter((r) => r.expect === 'NEEDS REVIEW')
      .map((r) => r.id!)
      .sort();
    assert.deepEqual(ids, want);
    assert.ok(first.summary.review.every((q) => q.question.length > 10));
  });

  it('uses the sheet\'s login case for "Logged in" cases', () => {
    assert.ok(first.loginCase);
    const loggedIn = rows.find((r) => r.kind === 'logged-in')!;
    assert.equal(first.results.find((x) => x.row === loggedIn.row)?.verdict?.status, 'PASS');
  });

  it('resumes without exploring again, and can run only the review queue', async () => {
    progress.length = 0;
    const again = await runBatch(file, options());
    const explored = progress.filter((m) => m.endsWith(': exploring'));
    // Only the cases that never completed are tried again (the missing element); nothing else.
    assert.ok(
      explored.every((m) => rows.some((r) => r.kind === 'missing-element' && m.includes(r.id!))),
      explored.join('\n'),
    );
    assert.deepEqual(again.summary.totals, first.summary.totals);

    progress.length = 0;
    const review = await runBatch(file, { ...options(), onlyReview: true });
    const queued = rows.filter((r) => r.expect === 'NEEDS REVIEW' && r.kind !== 'incomplete').length;
    assert.ok(progress.includes(`${queued} case(s) from the review queue`), progress.join('\n'));
    // The results file still has every row.
    assert.deepEqual(review.summary.totals, first.summary.totals);
  });
});
