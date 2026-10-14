/**
 * The grouped review report: why test cases are set aside, by cause, and who can fix each cause (the engine, the tester or the
 * project's data). It answers whether the review comes from an engine that is not finished or from the way the cases are written.
 *
 *   npm run engine:review                                  compile the two real workbooks (no browser) and group what is left
 *   npm run engine:review -- tests.xlsx other.xlsx         any input workbooks
 *   npm run engine:review -- --results run.results.xlsx    group the reasons of a run instead (the results sheet that auto-qa writes)
 *   npm run engine:review -- --json out.json               also write the report as JSON
 *   npm run engine:review -- --no-examples                 only the groups
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { compileCase } from '../engine/index.js';
import { readWorkbook } from '../importer/workbook.js';
import { buildReport, compileItems, type ReviewItem, reportText, runItems } from '../pipeline/review-report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const values = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1] as string] : []));
const flagValues = new Set([...values('results'), ...values('json')]);
const inputs = args.filter((a) => !a.startsWith('--') && !flagValues.has(a));
const resultFiles = values('results');
const examples = !args.includes('--no-examples');

const items: ReviewItem[] = [];
const cases: Array<{ workbook: string; caseId: string }> = [];

if (resultFiles.length === 0) {
  const targets = inputs.length
    ? inputs
    : ['test/fixtures/OrangeHRM_Login_Test_Cases_Updated.xlsx', 'test/fixtures/Add_Employee.xlsx'].map((f) => path.join(root, f));
  for (const file of targets) {
    const imported = await readWorkbook(file);
    const label = path.basename(file);
    for (const c of imported.cases) {
      const id = c.raw.id ?? '';
      cases.push({ workbook: label, caseId: id });
      items.push(...compileItems(label, id, await compileCase(c.raw, { source: { file: label, sheet: imported.sheet } })));
    }
  }
  console.log('Compile time: what is left after the text is read (no browser).\n');
} else {
  for (const file of resultFiles) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0] as ExcelJS.Worksheet;
    const head = (ws.getRow(1).values as unknown[]).slice(1).map((h) => String(h));
    const col = (name: string): number => head.indexOf(name) + 1;
    const label = path.basename(file);
    if (!col('Testcase ID') || !col('Status') || !col('Actual Result'))
      throw new Error(`${label} is not a results sheet: it needs Testcase ID, Status and Actual Result.`);
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const id = String(row.getCell(col('Testcase ID')).value ?? '');
      if (!id) return;
      cases.push({ workbook: label, caseId: id });
      const status = String(row.getCell(col('Status')).value ?? '');
      if (status === 'NEEDS REVIEW' || status === 'NOT VERIFIED') items.push(...runItems(label, id, String(row.getCell(col('Actual Result')).value ?? '')));
    });
  }
  console.log('Run time: the reasons in the results sheet (NEEDS REVIEW and NOT VERIFIED rows).\n');
}

const report = buildReport(items, cases);
console.log(reportText(report, { examples }));
const json = flag('json') ?? values('json')[0];
if (json) {
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${json}`);
}
