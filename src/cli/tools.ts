/**
 * Lists every Playwright MCP tool, grouped by the capability that turns it on.
 * No browser opens: the server only starts one on the first browser tool call.
 *
 *   npm run tools
 *   npm run tools -- --update    rewrite the tool list the tests compare against
 */
import { writeFile } from 'node:fs/promises';
import { MCP_CAPABILITIES, McpBrowser, type McpCapability, UNSAFE_TOOLS } from '../explorer/mcp-browser.js';

const toolsWith = async (capabilities: McpCapability[]) => {
  const browser = await McpBrowser.start({ capabilities });
  const tools = [...browser.tools];
  await browser.close();
  return tools;
};

const core = await toolsWith([]);
const groups: Array<[string, string[]]> = [['core (always on)', core]];
for (const cap of MCP_CAPABILITIES) {
  groups.push([cap, (await toolsWith([cap])).filter((t) => !core.includes(t))]);
}

const all = groups.flatMap(([, tools]) => tools);
for (const [name, tools] of groups) {
  console.log(`\n${name} · ${tools.length}`);
  for (const t of tools) console.log(`  ${t}${UNSAFE_TOOLS.includes(t) ? '   (unsafe: off unless allowUnsafe)' : ''}`);
}
console.log(`\n${all.length} tools in total`);

if (process.argv.includes('--update')) {
  const file = new URL('../explorer/fixtures/mcp-tools.txt', import.meta.url);
  await writeFile(file, `${[...all].sort().join('\n')}\n`);
  console.log('Updated src/explorer/fixtures/mcp-tools.txt');
}
