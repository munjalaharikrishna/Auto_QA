/** Prints the cases of the two real workbooks as JSON, for reading while the language layer is designed. */
import { readWorkbook } from '../../src/importer/workbook.js';

const out: unknown[] = [];
for (const f of ['OrangeHRM_Login_Test_Cases_Updated.xlsx', 'Add_Employee.xlsx']) {
  const r = await readWorkbook(new URL(`../fixtures/${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (const c of r.cases) out.push({ file: f, ...c.raw });
}
console.log(JSON.stringify(out, null, 1));
