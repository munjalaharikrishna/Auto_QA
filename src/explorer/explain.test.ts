import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { explain, plainError, sentence } from './explain.js';
import { dialogOf, McpBrowser } from './mcp-browser.js';

describe('plain-language reasons (item 5)', () => {
  it('says what was not found, what was closest and what to do', () => {
    const e = explain({ code: 'NO_MATCH', raw: 'enter username', label: 'username', candidates: [{ role: 'textbox', name: 'Login Name', score: 0.42 }] });
    assert.match(e.headline, /could not find "username"/);
    assert.match(e.why, /textbox "Login Name".*42%/);
    assert.ok(e.todo.some((t) => /click it on the screenshot/i.test(t)));
    assert.ok(e.todo.some((t) => /Enter username in "Login Name" field/.test(t)));
    assert.doesNotMatch(sentence(e), /NO_MATCH|MCP|ref=/);
  });

  it('says a failed step could not be done, that later steps were not tried, and what to do', () => {
    const e = explain({ code: 'STEP_FAILED', raw: 'click Save', text: 'The page or element did not appear in time.' });
    assert.match(e.headline, /"click Save" could not be done/);
    assert.match(e.why, /did not appear in time.*not tried/);
    assert.ok(e.todo.some((t) => /press Edit/i.test(t)));
  });

  it('explains an ambiguous match with the choices', () => {
    const e = explain({
      code: 'AMBIGUOUS',
      label: 'Details',
      candidates: [
        { role: 'button', name: 'Details', score: 0.9 },
        { role: 'button', name: 'Details', score: 0.9 },
      ],
    });
    assert.match(e.headline, /More than one element matches "Details"/);
    assert.match(e.why, /button "Details", button "Details"/);
  });

  it('explains steps that could not be read, with examples of what works', () => {
    const noAction = explain({ code: 'NO_ACTION', raw: 'the login box in the middle' });
    assert.match(noAction.headline, /cannot tell what to do/);
    assert.ok(noAction.todo.some((t) => /Verify or Validate/.test(t)));
    assert.match(explain({ code: 'VAGUE_CHECK', raw: 'it works' }).headline, /too general/);
  });

  it('never leaks a code or tool name for the codes we know', () => {
    for (const code of [
      'NO_MATCH',
      'AMBIGUOUS',
      'CANNOT_PIN',
      'NO_VALID_LOCATOR',
      'NO_EFFECT',
      'NOT_ON_PAGE',
      'PRODUCTION',
      'NO_LOGIN',
      'FLOW_V2',
      'PAGE_URL',
      'NO_ACTION',
      'NO_TARGET',
      'MULTIPLE_ACTIONS',
      'UNKNOWN_KEY',
      'VAGUE_CHECK',
      'NO_PATTERN',
      'MODAL',
    ]) {
      const e = explain({ code, raw: 'x', label: 'x', page: 'Home' });
      assert.ok(e.headline.length > 10 && e.why.length > 10 && e.todo.length, code);
      assert.doesNotMatch(`${e.headline} ${e.why} ${e.todo.join(' ')}`, /\b[A-Z]+_[A-Z_]+\b|MCP|browser_/, code);
    }
  });

  it('turns tool errors into readable sentences', () => {
    assert.match(plainError('MCP tool browser_snapshot failed: Error: Tool "browser_snapshot" does not handle the modal state.'), /pop-up message/);
    assert.match(plainError('page.goto: net::ERR_CONNECTION_REFUSED at http://x'), /did not answer/);
  });
});

describe('pop-ups (alert, confirm) do not stop the test', () => {
  it('reads the dialog from the MCP modal-state line', () => {
    assert.equal(
      dialogOf('### Modal state\n- ["alert" dialog with message "Invalid credentials"]: can be handled by the "browser_handle_dialog" tool'),
      'alert "Invalid credentials"',
    );
    assert.equal(dialogOf('### Page\n- Page URL: http://x'), undefined);
  });

  describe('in a real browser', () => {
    let demo: Awaited<ReturnType<typeof startDemoApp>>;
    let browser: McpBrowser;
    before(async () => {
      demo = await startDemoApp();
      browser = await McpBrowser.start({ headless: true });
    });
    after(async () => {
      await browser.close();
      await demo.close();
    });

    it('accepts an alert, remembers it, and the next call still works', async () => {
      await browser.navigate(`${demo.url}/alerts`);
      const before = await browser.snapshot();
      const ref = /button "Show alert" \[ref=(\w+)\]/.exec(before.snapshotYaml)?.[1];
      assert.ok(ref, before.snapshotYaml);
      await browser.click(ref, 'Show alert');
      const after = await browser.snapshot(); // used to fail: "does not handle the modal state"
      assert.deepEqual(browser.takeDialogs(), ['alert "Saved!"']);
      assert.match(after.snapshotYaml, /alert closed/);
      assert.deepEqual(browser.takeDialogs(), [], 'each pop-up is reported once');
    });

    it('accepts a confirm too', async () => {
      await browser.navigate(`${demo.url}/alerts`);
      const ref = /button "Ask me" \[ref=(\w+)\]/.exec((await browser.snapshot()).snapshotYaml)?.[1];
      assert.ok(ref);
      await browser.click(ref, 'Ask me');
      const state = await browser.snapshot();
      assert.deepEqual(browser.takeDialogs(), ['confirm "Delete item?"']);
      assert.match(state.snapshotYaml, /deleted/);
    });
  });
});
