import type { ToolReply } from '../../explorer/mcp-browser.js';

/**
 * Layer 38, the MCP capability manager (EX-03). The engine is a client of the Playwright MCP server and calls its tools
 * by name; the names change between versions. At start-up the engine asks the server what it offers, maps every function
 * it needs to the tool that does it (accepting the other names a tool has had), and says what is missing, with the way
 * round it where there is one. A run that needs a function that is missing and has no way round is BLOCKED, and the
 * reason names the tool: it is never run on a guess.
 */

/** The part of an MCP client the engine uses. The real browser client fits it; a test can stand in for it. */
export interface McpPort {
  /** Every tool the server offers. */
  readonly tools: ReadonlySet<string>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolReply>;
  /** Browser pop-ups (alert, confirm, prompt) seen since the last call, as `confirm "Delete item?"`. */
  takeDialogs(): string[];
  /** What to do with the next pop-up. Without it, pop-ups are accepted. */
  setDialogPolicy?(policy: (dialog: string) => { accept: boolean; promptText?: string }): void;
}

export const FUNCTIONS = [
  'navigate',
  'snapshot',
  'click',
  'type',
  'selectOption',
  'hover',
  'pressKey',
  'fileUpload',
  'handleDialog',
  'tabs',
  'back',
  'wheel',
] as const;
export type FunctionName = (typeof FUNCTIONS)[number];

export interface FunctionSpec {
  /** The tools that do it, preferred first: the names this function has had. */
  tools: readonly string[];
  /** What the engine does when no tool does it, when there is a way. It is the browser's own interface, not generated code. */
  fallback?: string;
}

export const SPEC: Readonly<Record<FunctionName, FunctionSpec>> = {
  navigate: { tools: ['browser_navigate'] },
  snapshot: { tools: ['browser_snapshot'] },
  click: { tools: ['browser_click'] },
  type: { tools: ['browser_type', 'browser_fill_form'] },
  selectOption: { tools: ['browser_select_option'], fallback: 'choose the option through the page (selectOption)' },
  hover: { tools: ['browser_hover'], fallback: 'move the pointer over the element through the page' },
  pressKey: { tools: ['browser_press_key'], fallback: 'press the key through the page keyboard' },
  fileUpload: { tools: ['browser_file_upload'], fallback: 'set the file of the file field through the page (setInputFiles)' },
  handleDialog: { tools: ['browser_handle_dialog'] },
  tabs: { tools: ['browser_tabs'], fallback: 'read and change tabs through the browser context' },
  back: { tools: ['browser_navigate_back'], fallback: 'go back through the page history' },
  wheel: { tools: ['browser_mouse_wheel'], fallback: 'scroll through the page' },
};

export interface FunctionStatus {
  /** `ok`: a tool does it. `fallback`: no tool does, the way round is used. `missing`: no tool and no way round. */
  status: 'ok' | 'fallback' | 'missing';
  /** The tool that will be called. */
  tool?: string;
  /** The tools that were looked for, for the message that says what is missing. */
  wanted: readonly string[];
  fallback?: string;
}

export interface Capabilities {
  functions: Record<FunctionName, FunctionStatus>;
  /** One line for each function that is not simply available: what is missing and what happens instead. */
  report: string[];
}

/** Reads what the server offers and maps every function to a tool (EX-03). */
export function discover(port: Pick<McpPort, 'tools'>): Capabilities {
  const functions = {} as Record<FunctionName, FunctionStatus>;
  const report: string[] = [];
  for (const name of FUNCTIONS) {
    const spec = SPEC[name];
    const tool = spec.tools.find((t) => port.tools.has(t));
    if (tool) {
      functions[name] = { status: 'ok', tool, wanted: spec.tools };
      if (tool !== spec.tools[0]) report.push(`${name}: "${spec.tools[0]}" is not offered; "${tool}" is used instead`);
    } else if (spec.fallback) {
      functions[name] = { status: 'fallback', wanted: spec.tools, fallback: spec.fallback };
      report.push(`${name}: ${spec.tools.map((t) => `"${t}"`).join(' or ')} is not offered; instead: ${spec.fallback}`);
    } else {
      functions[name] = { status: 'missing', wanted: spec.tools };
      report.push(`${name}: ${spec.tools.map((t) => `"${t}"`).join(' or ')} is not offered and there is no way round it`);
    }
  }
  return { functions, report };
}

/** The functions a run cannot do, named by their tools: empty when the run can go on. */
export function blockers(caps: Capabilities, needs: readonly FunctionName[]): string[] {
  return needs
    .filter((n) => caps.functions[n].status === 'missing')
    .map((n) => `${n} (tool ${caps.functions[n].wanted.map((t) => `"${t}"`).join(' or ')} is not offered)`);
}
