import { createRequire } from 'node:module';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Thin wrapper around the Playwright MCP server.
 *
 * The platform is the MCP client: it decides which tool to call (no AI agent).
 * This class only knows how to start the server, call tools and read their replies.
 */

export interface McpBrowserOptions {
  headless?: boolean;
  /** Attribute the app uses for test ids, e.g. "data-test". Defaults to "data-testid". */
  testIdAttribute?: string;
  /** Where MCP writes its own files (console logs, snapshots). */
  outputDir?: string;
  /** Connect to an already running browser (used later by the Locator Probe). */
  cdpEndpoint?: string;
}

export interface PageState {
  url: string;
  title: string;
  /** Accessibility snapshot in Playwright's YAML format. */
  snapshotYaml: string;
}

export interface ToolReply {
  /** Reply split into its "### Heading" sections, e.g. "Ran Playwright code", "Page", "Snapshot". */
  sections: Record<string, string>;
  /** The Playwright code MCP ran for this action, if any. A free locator suggestion. */
  code?: string;
  raw: string;
}

/** Tools the platform depends on. Checked at start-up because names change between MCP versions. */
const REQUIRED_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_close'];

export class McpBrowser {
  private constructor(private readonly client: Client) {}

  static async start(options: McpBrowserOptions = {}): Promise<McpBrowser> {
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');

    const args = [cli, '--isolated', '--output-dir', options.outputDir ?? '.auto-qa/mcp-output'];
    if (options.headless ?? true) args.push('--headless');
    if (options.testIdAttribute) args.push('--test-id-attribute', options.testIdAttribute);
    if (options.cdpEndpoint) args.push('--cdp-endpoint', options.cdpEndpoint);

    const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
    const client = new Client({ name: 'auto-qa-explorer', version: '0.1.0' });
    await client.connect(transport);

    const available = new Set((await client.listTools()).tools.map((t) => t.name));
    const missing = REQUIRED_TOOLS.filter((t) => !available.has(t));
    if (missing.length) {
      await client.close();
      throw new Error(`This Playwright MCP version is missing tools the platform needs: ${missing.join(', ')}`);
    }
    return new McpBrowser(client);
  }

  async navigate(url: string): Promise<ToolReply> {
    return this.call('browser_navigate', { url });
  }

  async snapshot(): Promise<PageState> {
    return pageState(await this.call('browser_snapshot', {}));
  }

  /** `target` is a snapshot ref such as "e11". `element` is a readable description for logs. */
  async type(target: string, text: string, element?: string): Promise<ToolReply> {
    return this.call('browser_type', { target, text, element });
  }

  async click(target: string, element?: string): Promise<ToolReply> {
    return this.call('browser_click', { target, element });
  }

  async close(): Promise<void> {
    try {
      await this.call('browser_close', {});
    } finally {
      await this.client.close();
    }
  }

  private async call(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const reply = parseToolReply(
      content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n'),
    );
    if (result.isError || reply.sections['Error'] !== undefined) {
      throw new Error(`MCP tool ${name} failed: ${(reply.sections['Error'] ?? reply.raw).trim()}`);
    }
    return reply;
  }
}

/** Splits an MCP text reply into its "### Heading" sections and pulls out the code it ran. */
export function parseToolReply(raw: string): ToolReply {
  const sections = splitSections(raw);
  const ran = sections['Ran Playwright code'];
  return { sections, raw, code: ran ? extractFence(ran, 'js') : undefined };
}

/** Reads the page URL, title and YAML snapshot out of a browser_snapshot reply. */
export function pageState(reply: ToolReply): PageState {
  const page = reply.sections['Page'] ?? '';
  return {
    url: /- Page URL: (.*)/.exec(page)?.[1]?.trim() ?? '',
    title: /- Page Title: (.*)/.exec(page)?.[1]?.trim() ?? '',
    snapshotYaml: extractFence(reply.sections['Snapshot'] ?? '', 'yaml'),
  };
}

function splitSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = text.split(/^### (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) sections[parts[i].trim()] = parts[i + 1] ?? '';
  return sections;
}

function extractFence(text: string, lang: string): string {
  const match = new RegExp('```' + lang + '\\r?\\n([\\s\\S]*?)```').exec(text);
  return (match ? match[1] : text).trimEnd();
}
