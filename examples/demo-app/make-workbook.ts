/**
 * Builds a realistic test case workbook for the demo app (PLAN.md M6b "done when"):
 *
 *   npm run demo:workbook                    → examples/demo-app/demo-tests.xlsx, 100 rows
 *   npm run demo:workbook -- out.xlsx 20     → 20 rows
 *
 * It looks like a tester's sheet: a title row above the headers, headers that differ from the
 * spec's names, an extra "Priority" column, and a mix of passing, failing, broken, vague and
 * incomplete rows, plus a duplicated ID.
 */
import ExcelJS from 'exceljs';

const LOGIN = '1. Open Login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login';

type Row = { id?: string; title: string; pre?: string; steps: string; data?: string; expected: string; priority: string };

/** Case kinds, and what each should give: the batch test checks these. */
export const KINDS: Array<{ kind: string; expect: string; make: (n: number) => Row }> = [
  {
    kind: 'login',
    expect: 'PASS',
    make: () => ({
      title: 'Valid user can log in',
      steps: LOGIN,
      expected: 'User is redirected to Dashboard page. Dashboard heading is displayed.',
      priority: 'High',
    }),
  },
  {
    kind: 'wrong-password',
    expect: 'PASS',
    make: () => ({
      title: 'Wrong password is rejected',
      steps: '1. Open Login page\n2. Enter valid username\n3. Enter wrong password\n4. Click Login',
      data: 'Wrong Password=nope',
      expected: 'Error "Invalid username or password" is shown. User stays on the Login page.',
      priority: 'High',
    }),
  },
  {
    kind: 'profile',
    expect: 'PASS',
    make: (n) => ({
      title: `Profile can be saved (${['Asha Rao', 'Ravi Kumar', 'Meena Iyer'][n % 3]})`,
      steps: `${LOGIN}\n5. Click Profile\n6. Enter Full name\n7. Select India from Country\n8. Click Save changes`,
      data: `Full name=${['Asha Rao', 'Ravi Kumar', 'Meena Iyer'][n % 3]}`,
      expected: 'Message "Profile saved" is shown.',
      priority: 'Medium',
    }),
  },
  {
    kind: 'logged-in',
    expect: 'PASS',
    make: () => ({
      title: 'Profile page opens for a logged in user',
      pre: 'Logged in',
      steps: '1. Click Profile',
      expected: 'Profile heading is displayed.',
      priority: 'Medium',
    }),
  },
  {
    kind: 'wrong-expectation',
    expect: 'FAIL',
    make: () => ({
      title: 'Saving shows a confirmation',
      steps: `${LOGIN}\n5. Click Profile\n6. Click Save changes`,
      expected: 'Message "Changes saved" is shown.',
      priority: 'Low',
    }),
  },
  {
    kind: 'broken-page',
    expect: 'FAIL',
    make: () => ({ title: 'Reports page opens', steps: `${LOGIN}\n5. Click Reports`, expected: 'Reports heading is displayed.', priority: 'Low' }),
  },
  {
    kind: 'vague',
    expect: 'NEEDS REVIEW',
    make: () => ({ title: 'Everything works', steps: '1. Open Login page\n2. Do the needful', expected: 'System works correctly', priority: 'Low' }),
  },
  {
    kind: 'missing-element',
    expect: 'NEEDS REVIEW',
    make: () => ({
      title: 'Password can be reset',
      steps: '1. Open Login page\n2. Click Forgot password',
      expected: 'User stays on the Login page',
      priority: 'Low',
    }),
  },
];

/** How many of each kind in a 100-row sheet (the rest of a smaller sheet is cut from the end). */
const MIX: Record<string, number> = {
  login: 34,
  'wrong-password': 18,
  profile: 12,
  'logged-in': 8,
  'wrong-expectation': 10,
  'broken-page': 8,
  vague: 5,
  'missing-element': 4,
};

export function demoRows(count: number): Array<Row & { kind: string; expect: string }> {
  const rows: Array<Row & { kind: string; expect: string }> = [];
  const scale = count / 100;
  for (const k of KINDS) {
    const n = Math.max(1, Math.round(MIX[k.kind] * scale));
    for (let i = 0; i < n; i++) rows.push({ ...k.make(i), kind: k.kind, expect: k.expect });
  }
  // Interleave kinds like a real sheet, deterministically.
  const mixed = rows.map((r, i) => ({ r, key: (i * 37) % rows.length })).sort((a, b) => a.key - b.key);
  return mixed.slice(0, count).map(({ r }, i) => ({ ...r, id: `TC-DEMO-${String(i + 1).padStart(3, '0')}` }));
}

export async function buildDemoWorkbook(file: string, count = 100): Promise<Array<Row & { kind: string; expect: string; row: number }>> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Regression');
  ws.addRow(['Demo app regression suite']).font = { bold: true, size: 14 };
  const header = ws.addRow(['S.No', 'Test Case ID', 'Test Case Name', 'Pre-Conditions', 'Test Steps', 'Test Data', 'Expected Result', 'Priority']);
  header.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
  });
  ws.columns.forEach((c, i) => {
    c.width = [6, 14, 40, 16, 60, 24, 50, 10][i];
  });

  const rows = demoRows(count);
  const written: Array<Row & { kind: string; expect: string; row: number }> = [];
  let serial = 0;
  for (const [i, r] of rows.entries()) {
    // A duplicated ID and an incomplete row, as real sheets have.
    const id = i === 5 ? rows[4].id : r.id;
    const added = ws.addRow([++serial, id, r.title, r.pre ?? '', r.steps, r.data ?? '', r.expected, r.priority]);
    added.alignment = { wrapText: true, vertical: 'top' };
    written.push({ ...r, id, row: added.number });
    if (i === 10) {
      const blank = ws.addRow([++serial, 'TC-DEMO-INCOMPLETE', 'Steps not written yet', '', '', '', 'Something happens', 'Low']);
      written.push({
        id: 'TC-DEMO-INCOMPLETE',
        title: 'Steps not written yet',
        steps: '',
        expected: 'Something happens',
        priority: 'Low',
        kind: 'incomplete',
        expect: 'NEEDS REVIEW',
        row: blank.number,
      });
    }
  }
  await wb.xlsx.writeFile(file);
  return written;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const file = process.argv[2] ?? 'examples/demo-app/demo-tests.xlsx';
  const rows = await buildDemoWorkbook(file, Number(process.argv[3] ?? 100));
  console.log(`Wrote ${file}: ${rows.length} rows.`);
}
