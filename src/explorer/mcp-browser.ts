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
  /** Optional tool groups to turn on. Defaults to all of them. */
  capabilities?: readonly McpCapability[];
  /** Allow tools that run arbitrary code in the page. Off by default (NFR-02: deterministic). */
  allowUnsafe?: boolean;
}

/**
 * Optional MCP tool groups. `--help` lists only vision, pdf and devtools; the others exist in
 * the server but are undocumented, so the tool list test catches it if a new version drops them.
 */
export const MCP_CAPABILITIES = ['vision', 'pdf', 'devtools', 'network', 'storage', 'testing', 'config'] as const;
export type McpCapability = (typeof MCP_CAPABILITIES)[number];

/** Tools that run any code the caller passes. Their result depends on that code, not on the platform's rules. */
export const UNSAFE_TOOLS = ['browser_run_code_unsafe', 'browser_evaluate'];

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

/** Command-line arguments for the MCP server. The browser only opens on the first browser tool call. */
export function serverArgs(options: McpBrowserOptions = {}): string[] {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');

  const args = [cli, '--isolated', '--output-dir', options.outputDir ?? '.auto-qa/mcp-output'];
  if (options.headless ?? true) args.push('--headless');
  if (options.testIdAttribute) args.push('--test-id-attribute', options.testIdAttribute);
  if (options.cdpEndpoint) args.push('--cdp-endpoint', options.cdpEndpoint);
  const caps = options.capabilities ?? MCP_CAPABILITIES;
  if (caps.length) args.push('--caps', caps.join(','));
  return args;
}

export class McpBrowser {
  private readonly dialogs: string[] = [];

  private constructor(
    private readonly client: Client,
    /** Every tool this MCP server offers, including unsafe ones. */
    readonly tools: ReadonlySet<string>,
    private readonly allowUnsafe: boolean,
  ) {}

  static async start(options: McpBrowserOptions = {}): Promise<McpBrowser> {
    const transport = new StdioClientTransport({ command: process.execPath, args: serverArgs(options), stderr: 'pipe' });
    const client = new Client({ name: 'auto-qa-explorer', version: '0.1.0' });
    await client.connect(transport);

    const available = new Set((await client.listTools()).tools.map((t) => t.name));
    const missing = REQUIRED_TOOLS.filter((t) => !available.has(t));
    if (missing.length) {
      await client.close();
      throw new Error(`This Playwright MCP version is missing tools the platform needs: ${missing.join(', ')}`);
    }
    return new McpBrowser(client, available, options.allowUnsafe ?? false);
  }

  /**
   * Calls any MCP tool by name, e.g. `callTool('browser_generate_locator', { element, target })`.
   * Unsafe tools are refused unless the browser was started with `allowUnsafe`.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
    if (!this.tools.has(name)) throw new Error(`Playwright MCP has no tool "${name}". Check the version or the capabilities option.`);
    if (UNSAFE_TOOLS.includes(name) && !this.allowUnsafe) {
      throw new Error(`"${name}" runs arbitrary code in the page and is off by default. Start McpBrowser with allowUnsafe: true to use it.`);
    }
    return this.call(name, args);
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

  /**
   * Browser pop-ups (alert, confirm, prompt) seen since the last call to this method, e.g.
   * `alert "Invalid credentials"`. They are accepted as they appear, as the generated test does too.
   */
  takeDialogs(): string[] {
    return this.dialogs.splice(0);
  }

  private async call(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    try {
      const reply = await this.callOnce(name, args);
      // An action that opens a pop-up succeeds, but nothing else works until it is closed.
      if (name !== 'browser_handle_dialog' && opensDialog(reply)) await this.closeDialog(reply);
      return reply;
    } catch (e) {
      if (name === 'browser_handle_dialog' || !(e instanceof McpToolError) || !/modal state/i.test(e.message)) throw e;
      // The pop-up blocked this call: close it, then try the call again once. If another connection to the same
      // browser closed it first, there is nothing left to close and the call can simply be tried again.
      await this.closeDialog(e.reply);
      return this.callOnce(name, args);
    }
  }

  private async closeDialog(reply: ToolReply): Promise<boolean> {
    const found = dialogOf(reply.raw);
    try {
      await this.callOnce('browser_handle_dialog', { accept: true });
    } catch {
      return false;
    }
    this.dialogs.push(found ?? 'a browser pop-up');
    return true;
  }

  private async callOnce(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const reply = parseToolReply(
      content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n'),
    );
    if (result.isError || reply.sections['Error'] !== undefined) {
      throw new McpToolError(`MCP tool ${name} failed: ${(reply.sections['Error'] ?? reply.raw).trim()}`, reply);
    }
    return reply;
  }
}

/** A tool call the MCP server answered with an error. The reply is kept: it says what is on the page. */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly reply: ToolReply,
  ) {
    super(message);
  }
}

/** Does this reply say a pop-up is open? */
export function opensDialog(reply: ToolReply): boolean {
  return dialogOf(reply.raw) !== undefined;
}

/**
 * The pop-up described in a reply, e.g. `alert "Invalid credentials"`, from MCP's modal-state line
 * `- ["alert" dialog with message "Invalid credentials"]: can be handled by the "browser_handle_dialog" tool`.
 */
export function dialogOf(raw: string): string | undefined {
  const line = raw.split(/\r?\n/).find((l) => /dialog/i.test(l) && /browser_handle_dialog|can be handled by/i.test(l));
  if (!line) return undefined;
  const kind = /"?(alert|confirm|prompt|beforeunload)"?\s+dialog/i.exec(line)?.[1]?.toLowerCase() ?? 'dialog';
  const message = /dialog with message\s+"([^"]*)"/i.exec(line)?.[1];
  return message === undefined ? kind : `${kind} "${message}"`;
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
