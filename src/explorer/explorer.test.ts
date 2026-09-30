import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import { McpBrowser, pageState, parseToolReply, serverArgs } from './mcp-browser.js';
import { contextOf, flatten, listElements, nearbyText, parseSnapshot } from './snapshot-parser.js';

// Real snapshots captured from the practice sites with Playwright MCP.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.yaml`, import.meta.url), 'utf8');
const saucedemo = parseSnapshot(fixture('saucedemo-login'));
const checkboxes = parseSnapshot(fixture('the-internet-checkboxes'));
const byRef = (nodes: ReturnType<typeof parseSnapshot>, ref: string) => flatten(nodes).find((n) => n.ref === ref)!;

describe('snapshot parsing (FR-LO-01)', () => {
  it('reads role, name, ref and attributes', () => {
    const login = byRef(saucedemo, 'e15');
    assert.equal(login.role, 'button');
    assert.equal(login.name, 'Login');
    assert.deepEqual(login.attributes, { cursor: 'pointer' });

    const heading = byRef(saucedemo, 'e19');
    assert.equal(heading.attributes.level, '4');
    assert.equal(byRef(checkboxes, 'f1e11').attributes.checked, true);
  });

  it('builds the tree from indentation', () => {
    const form = byRef(saucedemo, 'e9');
    assert.equal(form.role, 'form');
    assert.deepEqual(
      form.children.map((c) => c.ref),
      ['e11', 'e13', 'e15'],
    );
    assert.equal(byRef(saucedemo, 'e11').parent, form);
  });

  it('reads inline text and /url properties', () => {
    assert.equal(byRef(saucedemo, 'e4').text, 'Swag Labs');
    assert.equal(byRef(checkboxes, 'f1e16').props.url, 'http://elementalselenium.com/');
  });

  it('keeps nodes without a ref but does not list them', () => {
    const link = flatten(checkboxes).find((n) => n.role === 'link' && n.name === 'Fork me on GitHub');
    assert.ok(link);
    assert.equal(link.ref, undefined);
    assert.ok(!listElements(checkboxes).includes(link));
  });

  it('unescapes quotes in names', () => {
    const [node] = parseSnapshot('- button "Say \\"hi\\"" [ref=e1]');
    assert.equal(node.name, 'Say "hi"');
  });

  it('lists only element kinds a tester can use', () => {
    assert.deepEqual(
      listElements(saucedemo).map((n) => `${n.role}:${n.name}`),
      ['textbox:Username', 'textbox:Password', 'button:Login', 'heading:Accepted usernames are:', 'heading:Password for all users:'],
    );
  });
});

describe('nearby text and context (FR-LO-02)', () => {
  it('names an unlabeled checkbox from the text after it', () => {
    assert.equal(nearbyText(byRef(checkboxes, 'f1e10')), 'checkbox 1');
    assert.equal(nearbyText(byRef(checkboxes, 'f1e11')), 'checkbox 2');
  });

  it('names an unlabeled field from the text before it', () => {
    const [root] = parseSnapshot('- generic:\n  - text: Email\n  - textbox [ref=e2]\n  - text: We never share it');
    assert.equal(nearbyText(root.children[1]), 'Email');
  });

  it('does not use nearby text when the element has a name', () => {
    assert.equal(nearbyText(byRef(saucedemo, 'e11')), undefined);
  });

  it('reports the named form an element is inside', () => {
    assert.equal(contextOf(byRef(saucedemo, 'e15')), 'form "Login"');
    assert.equal(contextOf(byRef(saucedemo, 'e19')), '');
  });
});

describe('MCP tools', () => {
  it('turns on every capability group by default', () => {
    const args = serverArgs();
    assert.equal(args[args.indexOf('--caps') + 1], 'vision,pdf,devtools,network,storage,testing,config');
  });

  it('can start with only the core tools', () => {
    assert.ok(!serverArgs({ capabilities: [] }).includes('--caps'));
  });

  // Starts the real MCP server. No browser opens because no browser tool is called.
  describe('with a running server', () => {
    let browser: McpBrowser;
    before(async () => {
      browser = await McpBrowser.start();
    });
    after(async () => {
      await browser.close();
    });

    it('offers exactly the tools in fixtures/mcp-tools.txt (run `npm run tools -- --update` after an upgrade)', () => {
      const expected = readFileSync(new URL('./fixtures/mcp-tools.txt', import.meta.url), 'utf8')
        .trim()
        .split(/\r?\n/);
      assert.deepEqual([...browser.tools].sort(), expected);
    });

    it('refuses unsafe tools unless allowed', async () => {
      await assert.rejects(browser.callTool('browser_run_code_unsafe', { code: '1' }), /allowUnsafe/);
      await assert.rejects(browser.callTool('browser_evaluate', { function: '() => 1' }), /allowUnsafe/);
    });

    it('refuses a tool the server does not have', async () => {
      await assert.rejects(browser.callTool('browser_teleport'), /no tool "browser_teleport"/);
    });
  });
});

describe('dependencies (D7)', () => {
  it('uses the same Playwright version as Playwright MCP', () => {
    const require = createRequire(import.meta.url);
    const ours = require('playwright/package.json').version;
    const mcp = require('@playwright/mcp/package.json').dependencies.playwright;
    assert.equal(ours, mcp, 'Upgrade playwright and @playwright/mcp together so the Locator Probe runs the same engine as MCP.');
  });
});

describe('MCP replies (FR-EX-01)', () => {
  const navigateReply = [
    '### Ran Playwright code',
    '```js',
    "await page.goto('https://the-internet.herokuapp.com/checkboxes');",
    '```',
    '### Page',
    '- Page URL: https://the-internet.herokuapp.com/checkboxes',
    '- Page Title: The Internet',
    '### Snapshot',
    '```yaml',
    '- checkbox [ref=e10]',
    '```',
  ].join('\n');

  it('splits a reply into sections and extracts the code it ran', () => {
    const reply = parseToolReply(navigateReply);
    assert.deepEqual(Object.keys(reply.sections), ['Ran Playwright code', 'Page', 'Snapshot']);
    assert.equal(reply.code, "await page.goto('https://the-internet.herokuapp.com/checkboxes');");
  });

  it('reads the page URL, title and snapshot', () => {
    assert.deepEqual(pageState(parseToolReply(navigateReply)), {
      url: 'https://the-internet.herokuapp.com/checkboxes',
      title: 'The Internet',
      snapshotYaml: '- checkbox [ref=e10]',
    });
  });

  it('has no code when the reply ran none', () => {
    assert.equal(parseToolReply('### Page\n- Page URL: about:blank').code, undefined);
  });

  it('handles Windows line endings', () => {
    assert.equal(pageState(parseToolReply(navigateReply.replace(/\n/g, '\r\n'))).snapshotYaml, '- checkbox [ref=e10]');
  });
});
