import { McpBrowser } from '../explorer/mcp-browser.js';
import { LocatorProbe } from './probe.js';

/** Chrome shared by the Locator Probe and Playwright MCP (D7). Close it to stop both. */
export interface Session {
  mcp: McpBrowser;
  probe: LocatorProbe;
  testIdAttribute: string;
  close(): Promise<void>;
}

export async function openSession(options: { headless?: boolean; testIdAttribute?: string } = {}): Promise<Session> {
  const testIdAttribute = options.testIdAttribute ?? 'data-testid';
  const probe = await LocatorProbe.launch({ headless: options.headless, testIdAttribute });
  try {
    const mcp = await McpBrowser.start({ cdpEndpoint: probe.cdpEndpoint, testIdAttribute });
    return {
      mcp,
      probe,
      testIdAttribute,
      async close() {
        await mcp.close().catch(() => {});
        await probe.close();
      },
    };
  } catch (e) {
    await probe.close();
    throw e;
  }
}
