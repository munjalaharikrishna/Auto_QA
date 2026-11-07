import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import { inspectPage, locate } from '../locate/index.js';
import { compileCase } from '../pipeline/compile.js';
import { judge } from '../verdict/index.js';
import { type ExecutionSession, executePlan, openExecutionSession } from './index.js';
import { planActions } from './planner.js';

/**
 * E0.17, the two findings left from E0.14 on local OrangeHRM 2.5:
 *  - a <label for="x"> that has the id "x" itself is not tied to its field by the browser; the label still names the field;
 *  - a link of a hover menu is parked off the page until the pointer is on its item; the run hovers that item once, as a person does.
 * Needs Google Chrome and no internet. AUTO_QA_SKIP_BROWSER=1 skips it.
 */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('E0.17: a label with the id of its field still names it (OrangeHRM 2.5 Add Employee)', { skip }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ channel: 'chrome' });
  });
  after(async () => {
    await browser?.close();
  });

  it('First Name is found by its label, as Last Name is, and not only by the text next to it', async () => {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(root, 'test', 'dom', 'orangehrm-add-employee.html')).href);
    const elements = await inspectPage(page);
    for (const name of ['First Name', 'Last Name']) {
      const r = locate({ name, ontology: 'Field' }, elements);
      assert.equal(r.status, 'found', name);
      if (r.status === 'found') {
        assert.equal(r.level, 'label', name);
        assert.equal(r.element.tag, 'input');
      }
    }
    // The label element itself is not a field: it keeps no label of its own.
    assert.ok(elements.filter((e) => e.tag === 'label' && e.id === 'txtEmpFirstName').every((e) => e.labels.length === 0));
    await page.close();
  });
});

describe('E0.17: a link in a hover menu (OrangeHRM 2.5 "Add Employee" under PIM)', { skip }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let session: ExecutionSession;
  before(async () => {
    app = await startDemoApp();
    session = await openExecutionSession();
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  const run = async (step: string, expected: string) => {
    const compile = await compileCase({ id: 'T-MENU', title: 'menu', steps: `1. Open ${app.url}/ui/menu\n2. ${step}`, expected }, { env: {} });
    assert.ok(compile.ir && compile.plan, JSON.stringify(compile.issues.filter((i) => i.severity === 'blocking')));
    const trace = await executePlan(
      { plan: planActions(compile.ir, compile.plan), values: compile.values, pages: compile.pages },
      { mcp: session.port, page: session.page, baseUrl: app.url },
    );
    await session.reset();
    return { trace, verdict: judge({ compile, trace }) };
  };

  it('the item the menu hangs from is hovered once, then the link is clicked', async () => {
    const r = await run('Click the Add person link', 'The text "Opened Add person" is shown');
    assert.equal(r.trace.status, 'completed', JSON.stringify(r.trace.stoppedAt));
    const click = r.trace.steps.at(-1);
    assert.ok(
      click?.notes.some((n) => n.includes('was hovered first')),
      JSON.stringify(click?.notes),
    );
    assert.deepEqual(
      click?.calls.map((c) => c.fn),
      ['hover', 'click'],
    );
    assert.equal(r.verdict.verdict, 'PASS', r.verdict.reason);
  });

  it('a hidden button that is in no menu is not revealed: the step stops with the reason', async () => {
    const r = await run('Click the Secret button', 'The text "Opened Secret" is shown');
    assert.equal(r.trace.stoppedAt?.code, 'LOCATE_INACTIVE', JSON.stringify(r.trace.stoppedAt));
    assert.ok(!r.trace.steps.at(-1)?.calls.some((c) => c.fn === 'hover'), 'nothing was hovered');
  });
});
