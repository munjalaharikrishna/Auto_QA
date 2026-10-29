import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../../examples/demo-app/server.js';
import type { RawTestCase } from '../../model/test-model.js';
import {
  compileCase,
  discover,
  type ExecutionSession,
  executePlan,
  type McpPort,
  openExecutionSession,
  planActions,
  type RunTrace,
  renderPlan,
  renderTrace,
} from '../index.js';

/**
 * E0.7 exit tests: test cases run end to end through Playwright MCP on the extended demo app, one page for each kind of
 * interaction (UI-02 to UI-09), with the page observed before and after every step. Needs Google Chrome and no internet.
 * AUTO_QA_SKIP_BROWSER=1 skips them.
 */

const skip = !!process.env.AUTO_QA_SKIP_BROWSER;

describe('execution through Playwright MCP on the demo app', { skip }, () => {
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

  /** Compiles a test case and runs it. `lines` are the steps; the expected result only has to be understood. */
  async function run(
    lines: string[],
    extra: Partial<RawTestCase> = {},
    port: McpPort = session.port,
  ): Promise<{ trace: RunTrace; steps: Record<string, RunTrace['steps'][number]> }> {
    const raw: RawTestCase = {
      id: 'T-E07',
      title: 'A run',
      steps: lines.map((l, i) => `${i + 1}. ${l}`).join('\n'),
      expected: 'The Controls heading is displayed',
      ...extra,
    };
    const c = await compileCase(raw, { env: {} });
    assert.ok(c.ir && c.plan, `it compiles: ${JSON.stringify(c.issues.filter((i) => i.severity === 'blocking'))}`);
    const trace = await executePlan({ plan: planActions(c.ir, c.plan), values: c.values, pages: c.pages }, { mcp: port, page: session.page, baseUrl: app.url });
    return { trace, steps: Object.fromEntries(trace.steps.map((s) => [s.step, s])) };
  }
  const allDone = (t: RunTrace): void =>
    assert.deepEqual(
      t.steps.map((s) => s.status),
      t.steps.map(() => 'done'),
      renderTrace(t),
    );

  describe('UI-05: the control types', () => {
    it('fills a textbox and a password, chooses from a dropdown, ticks a box, gives a file, and submits', async () => {
      // The MCP server reads files under its allowed roots only: the project folder.
      const dir = path.join(process.cwd(), '.auto-qa', 'test-upload');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'photo.txt');
      writeFileSync(file, 'hello');
      const { trace, steps } = await run(
        [
          'Open the Application',
          `Open ${app.url}/ui/controls`,
          "Enter 'Asha Rao' in the Full name field",
          'Enter secret in the Secret field',
          "Select 'Green' from the Favourite colour dropdown",
          'Check the I agree checkbox',
          'Upload the Photo',
          'Click the Show button',
        ],
        { testData: `Secret: pw-12345\nPhoto: ${file}` },
      );
      allDone(trace);
      const text = (steps.S8?.after?.lines ?? []).join('\n');
      for (const line of ['name=Asha Rao', 'secret=8 characters', 'colour=green', 'agree=true', 'photo=photo.txt'])
        assert.ok(text.includes(line), `${line} in ${text}`);
      assert.ok(steps.S8?.changes.includes('text appeared: "name=Asha Rao"'), steps.S8?.changes.join(' | '));
      // Each control was found at the level that names it, and the password is never in the trace.
      assert.equal(steps.S3?.located?.level, 'label');
      assert.ok(steps.S4?.calls.some((c) => c.via === 'mcp' && c.tool === 'browser_type' && c.args.text === '••••'));
      assert.ok(!JSON.stringify(trace).includes('pw-12345'), 'a secret is not written in the trace');
      assert.ok(steps.S5?.calls.some((c) => c.tool === 'browser_select_option'));
      assert.deepEqual(
        steps.S7?.calls.map((c) => c.tool),
        ['browser_click', 'browser_file_upload'],
      );
    });
    it('does not tick a box that is ticked already', async () => {
      const { steps, trace } = await run(['Open the Application', `Open ${app.url}/ui/controls`, 'Check the I agree checkbox', 'Check the I agree checkbox']);
      allDone(trace);
      assert.ok(steps.S3?.calls.some((c) => c.tool === 'browser_click'));
      assert.deepEqual(steps.S4?.calls, []);
      assert.ok(steps.S4?.notes.some((n) => n.includes('already ticked')));
    });
  });

  describe('E0.12: "leave it blank" means an empty field', () => {
    it('empties a field that holds text, and says nothing is wrong with an empty value', async () => {
      const { trace, steps } = await run([
        'Open the Application',
        `Open ${app.url}/ui/controls`,
        "Enter 'Asha Rao' in the Full name field",
        'Leave the Full name field blank',
      ]);
      allDone(trace);
      const field = (s?: { after?: { elements: Array<{ name: string; value?: string }> } }) => s?.after?.elements.find((e) => e.name === 'Full name');
      assert.equal(field(steps.S3)?.value, 'Asha Rao', 'it held the name');
      assert.equal(field(steps.S4)?.value, '', 'and is empty after the step');
    });
  });

  describe('UI-04: forms', () => {
    it('ties a field error to its field, recognises the submit of each form, and sees the dependent field open', async () => {
      const { trace, steps } = await run([
        `Open ${app.url}/ui/forms`,
        'Click the Register button',
        "Enter 'a@b.com' in the Email field",
        "Enter '21' in the Age field",
        'Select India from the Country dropdown',
        'Click the Register button',
        "Enter 'x@y.io' in the Newsletter email field",
        'Click the Subscribe button',
      ]);
      allDone(trace);
      assert.deepEqual(steps.S2?.delta?.newFieldErrors, [
        { field: 'Email', message: 'Enter a valid email address' },
        { field: 'Age', message: 'Age must be 18 or more' },
      ]);
      assert.deepEqual(steps.S2?.submit, { form: 'register' });
      assert.ok(
        steps.S5?.delta?.changed.some((c) => c.element.includes('State') && c.property === 'disabled' && c.to === 'false'),
        'choosing a country opens the State field',
      );
      assert.ok(steps.S6?.changes.includes('text appeared: "Registered a@b.com"'), steps.S6?.changes.join(' | '));
      assert.equal(steps.S6?.delta?.newFieldErrors.length, 0);
      assert.ok(steps.S6?.delta?.textRemoved.includes('Enter a valid email address'), 'the errors are gone');
      assert.deepEqual(steps.S8?.submit, { form: 'newsletter' }, 'a submit belongs to its own form');
    });
  });

  describe('UI-03: pop-ups and dialogs', () => {
    it('accepts an alert and a confirm by default, and records what each said', async () => {
      const { trace, steps } = await run([`Open ${app.url}/ui/dialogs`, 'Click the Show alert button', 'Click the Ask me button']);
      allDone(trace);
      assert.deepEqual(steps.S2?.dialogs, ['alert "Saved!"']);
      assert.ok(steps.S2?.changes.includes('pop-up: alert "Saved!"'));
      assert.ok(steps.S2?.after?.lines.includes('alert closed'));
      assert.deepEqual(steps.S3?.dialogs, ['confirm "Delete item?"']);
      assert.ok(steps.S3?.after?.lines.includes('deleted'));
    });
    it('dismisses a confirm when the next step cancels it', async () => {
      const { trace, steps } = await run([`Open ${app.url}/ui/dialogs`, 'Click the Ask me button', 'Cancel the confirm dialog']);
      allDone(trace);
      assert.ok(steps.S2?.after?.lines.includes('kept'), 'the pop-up was dismissed, not accepted');
      assert.ok(steps.S3?.notes.some((n) => n.includes('already dismissed')));
    });
    it('sees a prompt, and works an HTML modal like any other element', async () => {
      const { trace, steps } = await run([`Open ${app.url}/ui/dialogs`, 'Click the Prompt me button', 'Click the Open modal button', 'Click the OK button']);
      allDone(trace);
      assert.deepEqual(steps.S2?.dialogs, ['prompt "Your name?"']);
      assert.equal(steps.S4?.located?.element.tag, 'button');
      assert.ok(steps.S4?.after?.lines.includes('removed'));
    });
  });

  describe('UI-02: tabs and windows', () => {
    it('goes to a tab a link opens, and to the window a button opens', async () => {
      const { trace, steps } = await run([`Open ${app.url}/ui/tabs`, 'Click the Help link', 'Wait 1 seconds']);
      allDone(trace);
      assert.equal(steps.S2?.tab?.title, 'Help centre');
      assert.ok(steps.S2?.tab?.url.endsWith('/ui/tab-target'));
      assert.deepEqual(steps.S2?.delta?.tabs, { from: 1, to: 2 });
      assert.equal(steps.S3?.after?.title, 'Help centre', 'the next step is on the new tab');
      const again = await run([`Open ${app.url}/ui/tabs`, 'Click the Open pop-up button']);
      allDone(again.trace);
      assert.ok(again.steps.S2?.tab?.url.includes('popup=1'));
    });
  });

  describe('UI-06: tables', () => {
    it('"Click Edit for John Smith": the row on page 2 of the table, found across pages', async () => {
      const { trace, steps } = await run([`Open ${app.url}/ui/table`, 'Click Edit for John Smith']);
      allDone(trace);
      assert.equal(steps.S2?.located?.row?.page, '2');
      assert.deepEqual(steps.S2?.located?.row?.cells.slice(1, 3), ['John Smith', 'IT']);
      assert.ok(steps.S2?.changes.includes('text appeared: "Editing John Smith"'), steps.S2?.changes.join(' | '));
    });
    it('finds the row of a sorted table too, wherever the sort put it', async () => {
      const { trace, steps } = await run([`Open ${app.url}/ui/table`, 'Click the Sort by Name button', 'Click Edit for John Smith']);
      allDone(trace);
      assert.equal(steps.S3?.located?.row?.page, '1');
      assert.ok(steps.S3?.after?.lines.includes('Editing John Smith'));
    });
    it('a first name that two rows share is ambiguous: no row is picked', async () => {
      const { trace, steps } = await run([`Open ${app.url}/ui/table`, 'Click Edit for John']);
      assert.equal(trace.status, 'blocked');
      assert.equal(steps.S2?.code, 'ROW_AMBIGUOUS');
      assert.ok(steps.S2?.reason?.includes('John Doe') && steps.S2.reason.includes('John Smith'), steps.S2?.reason ?? '');
    });
    it('a row that is nowhere in the table is not found, after every page was looked at', async () => {
      const { steps } = await run([`Open ${app.url}/ui/table`, 'Click Edit for Nobody Here']);
      assert.equal(steps.S2?.code, 'ROW_NOT_FOUND');
      assert.ok(steps.S2?.reason?.includes('3 page'), steps.S2?.reason ?? '');
    });
    it('deletes a row, and "the employee added in this test" is found at the end of the table', async () => {
      const { trace, steps } = await run([
        `Open ${app.url}/ui/table`,
        "Enter 'Mary' in the First name field",
        "Enter 'Test' in the Last name field",
        'Click the Add button',
        "Click Delete for 'Mary Test'",
        'Click Delete for John Doe',
      ]);
      allDone(trace);
      assert.ok(steps.S4?.changes.includes('text appeared: "Added Mary Test"'), steps.S4?.changes.join(' | '));
      assert.equal(steps.S5?.located?.row?.page, '2', 'the new row is found on the page the sort puts it');
      assert.ok(steps.S5?.changes.includes('text appeared: "Deleted Mary Test"'));
      assert.ok(steps.S6?.after?.lines.includes('Deleted John Doe'));
      assert.ok(!(steps.S6?.after?.lines ?? []).some((l) => l.includes('John Doe') && l.includes('IT')), 'the row is gone');
    });
  });

  describe('UI-09: waits that never sleep', () => {
    it('waits for a spinner to go and a slow call to finish: the step ends when the page has settled', async () => {
      const { trace, steps } = await run([
        `Open ${app.url}/ui/waits`,
        'Click the Load data button',
        'Click the Slow call button',
        'Click the Many changes button',
      ]);
      allDone(trace);
      assert.ok(steps.S2?.after?.lines.includes('Data loaded'));
      assert.ok(!steps.S2?.after?.lines.includes('Loading…'), 'the spinner is gone when the step ends');
      assert.ok(steps.S3?.after?.lines.includes('Call finished'), 'the slow call is finished when the step ends');
      assert.equal((steps.S4?.after?.lines ?? []).filter((l) => l.startsWith('item ')).length, 6, 'every one of the changes has happened');
    });
    it('"Wait 5 seconds" is "until the page is idle, at most 5 seconds": it ends at once on a page that is idle', async () => {
      const started = Date.now();
      const { trace, steps } = await run([`Open ${app.url}/ui/waits`, 'Wait 5 seconds']);
      allDone(trace);
      assert.equal(steps.S2?.action, 'WAIT');
      assert.ok(Date.now() - started < 4000, 'no 5 second pause');
    });
  });

  describe('UI-08: keyboard, mouse and hover', () => {
    it('presses Enter, Shift+Tab and Ctrl+A in a field, and hovers an element that shows a tooltip', async () => {
      const { trace, steps } = await run([
        `Open ${app.url}/ui/keys`,
        'Click the Type here field',
        'Press Enter',
        'Press Ctrl+A',
        'Press Shift+Tab',
        'Hover over the Hover target button',
      ]);
      allDone(trace);
      assert.ok(steps.S3?.changes.includes('text appeared: "Enter"'), steps.S3?.changes.join(' | '));
      assert.ok(steps.S4?.after?.lines.includes('Control+A'));
      assert.ok(steps.S5?.after?.lines.includes('Shift+Tab'));
      assert.ok(steps.S6?.delta?.textAdded.some((t) => t.includes('Tooltip shown')));
      assert.ok(steps.S6?.delta?.appeared.includes('tooltip "Tooltip shown"'));
    });
  });

  describe('EX-04, EX-05: before and after, exactly', () => {
    it('lists exactly what a failed login changed, and nothing else', async () => {
      const { trace, steps } = await run(
        [`Open ${app.url}/`, "Enter 'nobody' in the Username field", 'Enter password in the Password field', 'Click the Login button'],
        { testData: 'Password: wrong-pass' },
      );
      allDone(trace);
      const d = steps.S4?.delta;
      assert.deepEqual(d?.textAdded, ['Invalid username or password']);
      assert.deepEqual(d?.appeared, ['alert "Invalid username or password"']);
      assert.deepEqual(d?.newMessages, ['Invalid username or password']);
      assert.deepEqual([d?.url, d?.textRemoved, d?.disappeared, d?.changed, d?.dialogs], [undefined, [], [], [], []]);
      assert.deepEqual(steps.S4?.changes, [
        'new message: "Invalid username or password"',
        'text appeared: "Invalid username or password"',
        'appeared: alert "Invalid username or password"',
      ]);
      // The values typed show in the steps that typed them, a password never.
      assert.ok(
        steps.S2?.changes.some((c) => c.includes('value "" → "nobody"')),
        steps.S2?.changes.join(' | '),
      );
      assert.ok(
        steps.S3?.changes.some((c) => c.includes('value "" → "••••"')),
        steps.S3?.changes.join(' | '),
      );
      assert.ok(!JSON.stringify(trace).includes('wrong-pass'));
    });
    it('stores an observation before and after every step', async () => {
      const { trace } = await run([`Open ${app.url}/ui/controls`, "Enter 'x' in the Full name field"]);
      for (const s of trace.steps) {
        assert.ok(s.before && s.after, s.step);
        assert.ok(s.before.url && s.after.url);
      }
    });
  });

  describe('EX-03: a tool that is missing', () => {
    const without = (...names: string[]): McpPort => ({ ...session.port, tools: new Set([...session.port.tools].filter((t) => !names.includes(t))) });

    it('uses the way round when there is one, and says so at start-up', async () => {
      const port = without('browser_select_option');
      assert.equal(discover(port).functions.selectOption.status, 'fallback');
      const { trace, steps } = await run(
        [`Open ${app.url}/ui/controls`, "Select 'Blue' from the Favourite colour dropdown", 'Click the Show button'],
        {},
        port,
      );
      allDone(trace);
      assert.ok(trace.capabilities.some((c) => c.includes('browser_select_option') && c.includes('instead')));
      assert.deepEqual(
        steps.S2?.calls.map((c) => [c.via, c.tool]),
        [['page', 'selectOption']],
      );
      assert.ok(steps.S3?.after?.lines.includes('colour=blue'), 'and it worked');
    });
    it('is BLOCKED, naming the tool, when it is needed and has no way round: nothing is run', async () => {
      const port = without('browser_click');
      const { trace, steps } = await run([`Open ${app.url}/ui/controls`, 'Click the Show button'], {}, port);
      assert.equal(trace.status, 'blocked');
      assert.equal(trace.stoppedAt?.code, 'START');
      assert.ok(trace.stoppedAt?.reason.includes('"browser_click"'), trace.stoppedAt?.reason);
      assert.deepEqual(
        trace.steps.map((s) => s.status),
        ['skipped', 'skipped'],
      );
      assert.equal(steps.S1?.calls.length, 0, 'no browser action was made');
    });
    it('reports a renamed tool: the other name is used', () => {
      const caps = discover(without('browser_type'));
      assert.equal(caps.functions.type.tool, 'browser_fill_form');
      assert.ok(caps.report.some((r) => r.includes('"browser_type" is not offered; "browser_fill_form" is used instead')));
    });
  });

  describe('EX-01: the action plan', () => {
    it('shows each step as a chain of operations before anything runs, with the functions it needs', async () => {
      const raw: RawTestCase = {
        id: 'T-PLAN',
        title: 'Plan',
        steps:
          "1. Open the Login page\n2. Enter username in the Login Name text box\n3. Enter password in the Password text box\n4. Click the 'Login' button\n5. Wait 5 seconds",
        testData: 'Username: cypress\nPassword: selenium',
        expected: 'User is logged in',
      };
      const c = await compileCase(raw);
      assert.ok(c.ir && c.plan);
      const plan = planActions(c.ir, c.plan);
      assert.deepEqual(
        plan.chains.map((x) => [x.step, x.action]),
        [
          ['S1', 'NAVIGATE'],
          ['S2', 'ENTER_VALUE'],
          ['S3', 'ENTER_VALUE'],
          ['S4', 'CLICK'],
          ['S5', 'WAIT'],
        ],
      );
      assert.deepEqual(
        plan.chains[1]?.ops.map((o) => o.op),
        ['resolve-value', 'find', 'resolve-locator', 'validate-locator', 'act', 'wait', 'observe'],
      );
      assert.deepEqual(plan.needs, ['click', 'navigate', 'type']);
      assert.deepEqual([plan.chains[2]?.value, plan.chains[2]?.secret], ['$data.Password', true], 'a secret is shown by its name only');
      assert.ok(plan.chains[4]?.ops[0]?.detail.includes('never a fixed sleep'));
      assert.deepEqual(plan.chains[4]?.checksAfter, ['E1']);
      const text = renderPlan(plan);
      assert.ok(text.includes('S2 ENTER_VALUE') && text.includes('find "Login Name"'));
      assert.ok(!text.includes('selenium'));
      assert.equal(JSON.stringify(planActions(c.ir, c.plan)), JSON.stringify(plan), 'the same plan every time');
    });
  });

  describe('a step that cannot be done safely stops the run, with a code', () => {
    it('blocks instead of typing nothing when a password written inside a step was not kept', async () => {
      const { trace, steps } = await run([`Open ${app.url}/`, "Enter 'demo123' in the Password field", "Click the 'Login' button"]);
      assert.equal(trace.status, 'blocked');
      assert.equal(steps.S2?.code, 'VALUE_UNRESOLVED');
      assert.ok(steps.S2?.reason?.includes('is empty'), steps.S2?.reason ?? '');
      assert.equal(steps.S3?.status, 'skipped');
    });
    it('blocks on an element that is not there, and skips what comes after', async () => {
      const { trace, steps } = await run([`Open ${app.url}/ui/controls`, 'Click the Nothing Here button', 'Click the Show button']);
      assert.equal(trace.status, 'blocked');
      assert.equal(steps.S2?.code, 'LOCATE_NOT_FOUND');
      assert.equal(steps.S3?.status, 'skipped');
      assert.equal(trace.stoppedAt?.step, 'S2');
    });
    it('blocks on a value that was not resolved, instead of typing a made-up one', async () => {
      const { steps } = await run([`Open ${app.url}/ui/controls`, 'Enter valid username in the Full name field']);
      assert.equal(steps.S2?.code, 'VALUE_UNRESOLVED');
    });
  });
  describe('VD-03: isolation between test cases', () => {
    it('a reset leaves no cookie, storage or extra tab for the next test case', async () => {
      await session.page.goto(`${app.url}/lab`);
      const before = await session.page.evaluate(() => ({ cookie: document.cookie, theme: localStorage.getItem('theme') }));
      assert.deepEqual(before, { cookie: 'session=abc123', theme: 'dark' }, 'the lab page leaves state behind');
      await session.context.newPage();
      await session.reset();
      assert.equal(session.context.pages().length, 1, 'only the run page is left');
      assert.equal(session.page.url(), 'about:blank');
      await session.page.goto(`${app.url}/ui/controls`);
      const after = await session.page.evaluate(() => ({ cookie: document.cookie, theme: localStorage.getItem('theme') }));
      assert.deepEqual(after, { cookie: '', theme: null }, 'nothing from the earlier case is seen');
    });
    it('gives the same verdict in either order', async () => {
      const login = [`Open ${app.url}/lab`, 'Click the Show toast button'];
      const first = await run(login);
      await session.reset();
      const second = await run(login);
      assert.deepEqual(
        first.trace.steps.map((s) => s.status),
        second.trace.steps.map((s) => s.status),
      );
    });
  });
});
