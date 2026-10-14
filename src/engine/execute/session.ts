import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { McpBrowser } from '../../explorer/mcp-browser.js';
import type { McpPort } from './capabilities.js';

/**
 * The browser a run is made in: one Chrome that the engine and the Playwright MCP server both use. The engine reads
 * and waits through its own connection; every action goes through the MCP server. Pop-ups are answered here, by the
 * policy of the step that opened them (UI-03): accept, or dismiss, or answer a prompt; their text is kept so that a check
 * can ask what a pop-up said.
 */

export interface ExecutionSession {
  /** What the executor calls: the MCP server, and the pop-up policy. */
  port: McpPort;
  /** The page the run starts on. */
  page: Page;
  context: BrowserContext;
  /**
   * Gives the next test case a clean browser (VD-03): extra tabs closed, cookies, permissions, local and session storage,
   * IndexedDB and caches cleared, and the page back on a blank one. Two test cases run in any order then give the same verdicts.
   */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionOptions {
  headless?: boolean;
  testIdAttribute?: string;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

export async function openExecutionSession(options: SessionOptions = {}): Promise<ExecutionSession> {
  const port = await freePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'auto-qa-run-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: options.headless ?? true,
    args: [`--remote-debugging-port=${port}`],
  });
  const seen: string[] = [];
  const origins = new Set<string>();
  let policy: Parameters<NonNullable<McpPort['setDialogPolicy']>>[0] = () => ({ accept: true });
  const watch = (page: Page): void => {
    page.on('framenavigated', (frame) => {
      try {
        const { origin } = new URL(frame.url());
        if (origin !== 'null') origins.add(origin);
      } catch {
        // an address that is not a URL has no origin to clear
      }
    });
    page.on('dialog', (dialog) => {
      const text = `${dialog.type()} "${dialog.message()}"`;
      seen.push(text);
      const answer = policy(text);
      void (answer.accept ? dialog.accept(answer.promptText) : dialog.dismiss()).catch(() => undefined);
    });
  };
  for (const page of context.pages()) watch(page);
  context.on('page', watch);
  let mcp: McpBrowser;
  try {
    mcp = await McpBrowser.start({ cdpEndpoint: `http://127.0.0.1:${port}`, testIdAttribute: options.testIdAttribute, allowUnsafe: false });
  } catch (e) {
    await context.close();
    throw e;
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const reset = async (): Promise<void> => {
    for (const p of context.pages()) if (p !== page) await p.close().catch(() => undefined);
    seen.length = 0;
    policy = () => ({ accept: true });
    // Storage belongs to an origin: every origin the run visited is cleared, then the cache and the cookies of the browser.
    const cdp = await context.newCDPSession(page);
    try {
      for (const origin of origins) await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => undefined);
      origins.clear();
      await cdp.send('Network.clearBrowserCache').catch(() => undefined);
      await cdp.send('Network.clearBrowserCookies').catch(() => undefined);
    } finally {
      await cdp.detach().catch(() => undefined);
    }
    await context.clearCookies();
    await context.clearPermissions();
    await page
      .evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {
          // a page without storage (about:blank) has nothing to clear
        }
      })
      .catch(() => undefined);
    await page.goto('about:blank');
  };
  return {
    page,
    reset,
    context,
    port: {
      tools: mcp.tools,
      callTool: (name, args) => mcp.callTool(name, args),
      takeDialogs: () => seen.splice(0),
      setDialogPolicy: (p) => {
        policy = p;
      },
    },
    async close() {
      await mcp.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
