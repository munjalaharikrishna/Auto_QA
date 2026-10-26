import type { Page, Request } from 'playwright';
import { prepareFrame, visibleFrames } from '../locate/frames.js';

/**
 * Layer 35, the wait and synchronization engine (UI-09). Nothing here sleeps. Every wait is for something to happen: the
 * page to load, the network to go quiet, the page to stop changing, a spinner to go, an address to change, an element to
 * be seen. Each has a limit so that a page that never settles does not hold a run forever; that limit is a bound on the
 * wait for the event, never a pause. "Wait 5 seconds" in a test case becomes "wait until the page is idle, for at most
 * 5 seconds" (RX-17).
 */

export interface SettleOptions {
  /** The longest the page may take to settle. */
  maxMs?: number;
  /** How long the page must not change to count as quiet. This is the length of the quiet that is looked for. */
  quietMs?: number;
}

export interface Settled {
  /** `true` when every condition held before the limit. */
  settled: boolean;
  /** What was still going on at the limit, for the report. */
  waitingFor: string[];
}

/**
 * The navigations a page has started and not yet received: a form that is saved, a link that is followed. While one is
 * pending the old document stays quiet, so "the page stopped changing" would be true of a page that is about to be
 * replaced (E3). It is started before a step acts, so the click that begins a navigation is seen.
 */
const pendingNavigations = new WeakMap<Page, Set<Request>>();
export function trackNavigations(page: Page): void {
  if (pendingNavigations.has(page)) return;
  const pending = new Set<Request>();
  pendingNavigations.set(page, pending);
  page.on('request', (r) => {
    if (r.isNavigationRequest()) pending.add(r);
  });
  const done = (r: Request): void => {
    pending.delete(r);
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
}
const navigating = (page: Page): boolean => (pendingNavigations.get(page)?.size ?? 0) > 0;

/** Until every navigation that was started has been answered, or the deadline; it waits for the answers, it does not poll. */
async function untilAnswered(page: Page, deadline: number): Promise<void> {
  while (navigating(page)) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    await Promise.race([page.waitForEvent('requestfinished', { timeout: left }), page.waitForEvent('requestfailed', { timeout: left })]).catch(() => undefined);
  }
}

export const DEFAULT_MAX_MS = 5000;
export const DEFAULT_QUIET_MS = 250;

/**
 * Runs in the page: true when nothing is loading and nothing has changed for `quiet` milliseconds. The page is watched by
 * one observer that stays on the document; the call is repeated by Playwright on every animation frame until it is true.
 */
function pageIsQuiet(quiet: number): boolean {
  const w = window as unknown as { __aqQuiet?: { last: number } };
  if (!w.__aqQuiet) {
    const state = { last: performance.now() };
    w.__aqQuiet = state;
    new MutationObserver(() => {
      state.last = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    return false;
  }
  if (document.readyState !== 'complete') return false;
  const busy = document.querySelector('[aria-busy="true"], [role="progressbar"]');
  if (busy) {
    const style = getComputedStyle(busy);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      w.__aqQuiet.last = performance.now();
      return false;
    }
  }
  return performance.now() - w.__aqQuiet.last >= quiet;
}

/** Waits until the page has loaded, the network is quiet, no spinner is showing and the page has stopped changing. */
export async function waitSettled(page: Page, options: SettleOptions = {}): Promise<Settled> {
  const timeout = options.maxMs ?? DEFAULT_MAX_MS;
  const waitingFor: string[] = [];
  const attempt = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch {
      waitingFor.push(what);
    }
  };
  await attempt('the page to load', () => page.waitForLoadState('domcontentloaded', { timeout }));
  await attempt('the network to go quiet', () => page.waitForLoadState('networkidle', { timeout }));
  // The page and every frame in it: a screen shown in an iframe reloads on its own, after the page itself is quiet (E3).
  await attempt('the page to stop changing', async () => {
    const deadline = Date.now() + timeout;
    for (let round = 0; round < 5; round++) {
      await untilAnswered(page, deadline);
      if (navigating(page)) throw new Error('a navigation is still pending');
      const frames = await visibleFrames(page);
      for (const { frame } of frames) {
        if (frame.isDetached()) continue;
        await prepareFrame(frame);
        const left = Math.max(1, deadline - Date.now());
        await frame.waitForLoadState('domcontentloaded', { timeout: left });
        await frame.waitForFunction(pageIsQuiet, options.quietMs ?? DEFAULT_QUIET_MS, { timeout: Math.max(1, deadline - Date.now()) });
      }
      // A frame that appeared while waiting is waited for too.
      if (!navigating(page) && (await visibleFrames(page)).length === frames.length) return;
    }
  });
  return { settled: waitingFor.length === 0, waitingFor };
}

/** "Wait 5 seconds": until the page is idle, for at most that long. Returns when it is idle, which is usually sooner. */
export const waitUntilIdle = (page: Page, maxMs: number): Promise<Settled> => waitSettled(page, { maxMs });

/** Until the address contains the text, or at most `maxMs`. */
export async function waitForUrl(page: Page, fragment: string, maxMs = DEFAULT_MAX_MS): Promise<boolean> {
  try {
    await page.waitForURL((url) => url.href.includes(fragment), { timeout: maxMs });
    return true;
  } catch {
    return false;
  }
}

/** Until the text is shown on the page or in any frame of it, or at most `maxMs`. */
export async function waitForText(page: Page, text: string, maxMs = DEFAULT_MAX_MS): Promise<boolean> {
  try {
    const frames = await visibleFrames(page);
    await Promise.any(frames.map(({ frame }) => frame.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: maxMs })));
    return true;
  } catch {
    return false;
  }
}
