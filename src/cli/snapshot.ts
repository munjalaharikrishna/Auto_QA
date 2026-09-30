/**
 * Milestone 1: open any page through Playwright MCP and print the elements it sees.
 *
 *   npm run snapshot -- https://www.saucedemo.com
 *   npm run snapshot -- https://www.saucedemo.com --headed --test-id-attribute data-test --json out.json
 */
import { writeFile } from 'node:fs/promises';
import { McpBrowser } from '../explorer/mcp-browser.js';
import { ELEMENT_KINDS, contextOf, listElements, nearbyText, parseSnapshot } from '../explorer/snapshot-parser.js';

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!url) {
  console.error('Usage: npm run snapshot -- <url> [--headed] [--test-id-attribute data-test] [--json file]');
  process.exit(1);
}

const browser = await McpBrowser.start({
  headless: !args.includes('--headed'),
  testIdAttribute: flag('--test-id-attribute'),
});

try {
  await browser.navigate(url);
  const page = await browser.snapshot();
  const elements = listElements(parseSnapshot(page.snapshotYaml));

  console.log(`\nPage:  ${page.title}\nURL:   ${page.url}\nFound: ${elements.length} elements\n`);
  const rows = elements.map((n) => ({
    Type: ELEMENT_KINDS[n.role],
    Name: n.name || n.text || (nearbyText(n) ? `(no name) next to "${nearbyText(n)}"` : '(no name)'),
    Ref: n.ref,
    'Inside': contextOf(n),
    Extra: [
      n.attributes.level ? `level ${n.attributes.level}` : '',
      n.attributes.checked ? 'checked' : '',
      n.attributes.disabled ? 'disabled' : '',
      n.props.url ? `→ ${n.props.url}` : '',
    ].filter(Boolean).join(', '),
  }));
  console.table(rows);

  const unnamed = elements.filter((n) => !n.name && !n.text && !nearbyText(n) && n.role !== 'img');
  if (unnamed.length) {
    console.log(`⚠ ${unnamed.length} element(s) have no name. Steps cannot refer to them by text; the tester will be asked to pick them.`);
  }

  const jsonFile = flag('--json');
  if (jsonFile) {
    const plain = elements.map((n) => {
      const { parent, children, ...rest } = n;
      return { ...rest, nearbyText: nearbyText(n), context: contextOf(n) };
    });
    await writeFile(jsonFile, JSON.stringify({ url: page.url, title: page.title, elements: plain }, null, 2));
    console.log(`Saved ${jsonFile}`);
  }
} finally {
  await browser.close();
}
