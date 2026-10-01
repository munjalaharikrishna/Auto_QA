import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type LocateResult, locate } from '../locators/engine.js';
import { type Fingerprint, type PageRef, pageOf } from '../locators/ladder.js';
import { parseLocatorCode, spec, toCode, toLocator } from '../locators/locator.js';
import { type Candidate, rolesFor, type TargetQuery } from '../locators/match.js';
import type { Session } from '../locators/session.js';
import type { Action, Assertion, AssertionType, Step, TestModel } from '../model/test-model.js';
import type { ParserConfig } from '../parser/config.js';
import { executionOrder } from '../parser/index.js';
import { type Explanation, explain, plainError, sentence } from './explain.js';
import type { PageState, ToolReply } from './mcp-browser.js';
import { flatten, nearbyText, parseSnapshot, type SnapshotNode } from './snapshot-parser.js';
import { masker, resolveValue } from './values.js';

/**
 * Exploration controller (FR-EX-02…09): a guided dry run of one test case in the real app.
 *
 * Each step goes LOCATE → VALIDATE → ACT → VERIFY_EFFECT → SETTLE → DONE. Anything the rules
 * cannot decide goes to the `Resolver` and waits, with the browser still open (D6). The CLI
 * resolver asks in the terminal; the web UI (M7) will answer with pick-element instead.
 * Checks are not evaluated here, only located, so the generated test can run them (M6).
 */

export interface ExploreOptions {
  config: ParserConfig;
  /** The environment's base URL. The first step's page opens it (D19). */
  baseUrl: string;
  env: Record<string, string | undefined>;
  /** Page name → URL or path, learned earlier or from the environment (D19). */
  pageUrls?: Record<string, string>;
  resolver: Resolver;
  /** Where per-step screenshots go (FR-EX-07). */
  outDir: string;
  /** Exploration really clicks buttons, so production needs a confirmation (D9, FR-EX-08). */
  production?: boolean;
  /** Steps to run first for a "Logged in" precondition, e.g. the login test case (FR-PF-01). */
  login?: TestModel;
  timeouts?: Partial<Timeouts>;
}

interface Timeouts {
  /** How long a click may take to change something (VERIFY_EFFECT). */
  effect: number;
  /** How long the page may take to settle (SETTLE). */
  settle: number;
  /** Snapshots must stay identical for this long to count as settled. */
  quiet: number;
}
const DEFAULT_TIMEOUTS: Timeouts = { effect: 5000, settle: 10000, quiet: 500 };

export interface ReviewRequest {
  item: string;
  raw: string;
  /** The element name the step looked for, for the explanation. */
  target?: string;
  code: string;
  text: string;
  candidates: Candidate[];
  /** The page as it is now, for pick-element on the screenshot (FR-RV-02). */
  view?: PageView;
}

/** A screenshot and, for every element the step's action could use, its box on that screenshot. */
export interface PageView {
  screenshot: string;
  width: number;
  height: number;
  elements: Array<{ ref: string; role: string; name: string; box: { x: number; y: number; width: number; height: number }; candidate?: number }>;
}

/** A candidate by its index, an element picked on the screenshot by its ref, or skip / stop. */
export type ReviewAnswer = number | { ref: string } | 'skip' | 'abort';

/** Answers the questions exploration cannot decide by rule. */
export interface Resolver {
  /** Pick one of `candidates` by index, or skip the step, or stop exploring. */
  choose(request: ReviewRequest): Promise<ReviewAnswer>;
  /** The URL (or path) of a page the tester named, e.g. "Open Profile page" (D19). */
  pageUrl(request: { item: string; page: string }): Promise<string | 'abort'>;
  /** Yes/no, e.g. "Explore on Production?" or "The click changed nothing. Continue?". */
  confirm(request: { item: string; code: string; text: string; raw?: string; page?: string }): Promise<boolean>;
}

export interface ExploredItem {
  id: string;
  kind: 'step' | 'check';
  raw: string;
  action?: Action;
  type?: AssertionType;
  /** `setup` for steps run for a "Logged in" precondition. */
  phase: 'setup' | 'test';
  status: 'done' | 'skipped' | 'failed';
  resolvedBy?: 'rules' | 'tester';
  locator?: { code: string; strategy: string; source: string; validated: boolean };
  /** The element the step acts on or checks: its role and the name it was matched by. Names Page Object members. */
  element?: { role: string; name: string };
  /** Other locators that also validated, including MCP's code after the action (FR-LO-07). */
  alternatives?: string[];
  score?: number;
  candidates?: Array<{ ref?: string; role: string; name: string; score: number }>;
  fingerprint?: Fingerprint;
  page?: PageRef;
  /** What the step changed, e.g. `url /dashboard`, `value set`, `snapshot changed`. */
  effect?: string;
  /** For checks: the page when the check would run. */
  observed?: { url: string; title: string; textFound?: boolean };
  url?: string;
  screenshot?: string;
  warnings: string[];
  error?: string;
  /** Browser pop-ups (alert, confirm) the step caused; each was accepted so the test could go on. */
  dialogs?: string[];
  /** Why the step was set aside or failed, in the tester's words (see explain.ts). */
  review?: Explanation;
  /** For a check that compares two elements: the second one. */
  other?: { locator: NonNullable<ExploredItem['locator']>; element: { role: string; name: string } };
}

export interface ExplorationResult {
  testId: string;
  title: string;
  baseUrl: string;
  /** The attribute `getByTestId` used, so the generated config matches (FR-LO-09). */
  testIdAttribute: string;
  startedAt: string;
  finishedAt: string;
  status: 'complete' | 'incomplete' | 'aborted';
  items: ExploredItem[];
  /** Page Object name → the path it was found on (FR-LO-10). */
  pages: Record<string, { path: string; title: string }>;
  /** Page name → URL learned during this run, to save with the environment (D19). */
  learnedPageUrls: Record<string, string>;
  /** The login test case run for a "Logged in" precondition, so the setup steps can be generated on their own. */
  setup?: { testId: string; steps: Step[]; data: Record<string, string> };
}

/** How often one step may ask the tester before it gives up. */
const MAX_QUESTIONS = 5;

class Aborted extends Error {}

export async function explore(model: TestModel, session: Session, options: ExploreOptions): Promise<ExplorationResult> {
  const { mcp, probe } = session;
  const t = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const pageUrls = { ...options.pageUrls };
  const learned: Record<string, string> = {};
  /** URL path → the page name the tester used for it, so elements found there join that Page Object (FR-LO-10). */
  const pathNames: Record<string, string> = {};
  const namePage = (url: string, title: string, hint?: string) => {
    const page = pageOf(url, title, hint);
    pathNames[page.path] ??= page.name;
    result.pages[pathNames[page.path]] ??= { path: page.path, title };
  };
  const secrets = new Set<string>();
  const mask = (text: string) => masker(secrets)(text);
  const now = new Date();
  const result: ExplorationResult = {
    testId: model.id,
    title: model.title,
    baseUrl: options.baseUrl,
    testIdAttribute: session.testIdAttribute,
    startedAt: now.toISOString(),
    finishedAt: '',
    status: 'complete',
    items: [],
    pages: {},
    learnedPageUrls: learned,
  };
  await mkdir(options.outDir, { recursive: true });

  const browserPage = (url?: string) => probe.page(url);
  const snapshotText = (s: PageState) => s.snapshotYaml.replace(/\s*\[ref=[^\]]+\]/g, '');

  /** SETTLE (FR-EX-04): loaded, network quiet, and the snapshot unchanged for `quiet` ms. */
  async function settle(item: ExploredItem): Promise<PageState> {
    const page = browserPage();
    const deadline = Date.now() + t.settle;
    await page.waitForLoadState('load', { timeout: t.settle }).catch(() => item.warnings.push('SETTLE: the page did not finish loading'));
    await page
      .waitForLoadState('networkidle', { timeout: Math.max(1, deadline - Date.now()) })
      .catch(() => item.warnings.push('SETTLE: network never went quiet'));
    let last = await mcp.snapshot();
    let since = Date.now();
    while (Date.now() - since < t.quiet) {
      if (Date.now() > deadline) {
        item.warnings.push('SETTLE: the page kept changing');
        break;
      }
      await page.waitForTimeout(100);
      const next = await mcp.snapshot();
      if (snapshotText(next) !== snapshotText(last)) since = Date.now();
      last = next;
    }
    return last;
  }

  /** VERIFY_EFFECT for clicks and keys (FR-EX-05): wait until the URL or the page changes. */
  async function waitForChange(before: PageState): Promise<string | undefined> {
    const page = browserPage();
    const deadline = Date.now() + t.effect;
    for (;;) {
      const current = await mcp.snapshot();
      if (current.url !== before.url) return `url ${pathOf(current.url)}`;
      if (snapshotText(current) !== snapshotText(before)) return 'page changed';
      if (Date.now() > deadline) return undefined;
      await page.waitForTimeout(150);
    }
  }

  /** Screenshot + element boxes, taken together so the boxes match the picture (FR-RV-02). */
  async function pageView(query: TargetQuery, candidates: Candidate[], name: string): Promise<PageView | undefined> {
    try {
      const page = browserPage();
      const file = path.join(options.outDir, `${model.id}-${name}.png`);
      await page.screenshot({ path: file });
      const size = page.viewportSize() ?? { width: 1280, height: 720 };
      const roles = rolesFor(query.kind);
      const nodes = flatten(parseSnapshot(await page.ariaSnapshot({ mode: 'ai', boxes: true })));
      const elements = nodes.flatMap((n) => {
        const box = typeof n.attributes.box === 'string' ? n.attributes.box.split(',').map(Number) : [];
        if (!n.ref || box.length !== 4 || box[2] <= 0 || box[3] <= 0) return [];
        if (roles && !roles.includes(n.role)) return [];
        // A part of the page is exactly what a container question is about.
        const skip = query.container
          ? ['generic', 'text', 'paragraph', 'document', 'row', 'cell']
          : ['generic', 'text', 'paragraph', 'main', 'document', 'region', 'form', 'list', 'group', 'navigation', 'banner', 'contentinfo'];
        if (!roles && skip.includes(n.role)) return [];
        const candidate = candidates.findIndex((c) => c.node.ref === n.ref);
        return [
          {
            ref: n.ref,
            role: n.role,
            name: n.name || nearbyText(n) || n.text || '',
            box: { x: box[0], y: box[1], width: box[2], height: box[3] },
            ...(candidate >= 0 ? { candidate } : {}),
          },
        ];
      });
      return { screenshot: file, width: size.width, height: size.height, elements };
    } catch {
      return undefined;
    }
  }

  /** Messages the page shows now, e.g. "Invalid Login", quoted for a question or an error. */
  async function pageMessages(url: string): Promise<string | undefined> {
    try {
      const page = browserPage(url);
      const marked = page
        .locator('[role=alert], [role=status], [aria-live], [class*="error" i], [class*="alert" i], [class*="message" i]')
        .filter({ visible: true });
      const failure = page.getByText(/invalid|incorrect|failed|wrong|denied|not match|error/i).filter({ visible: true });
      const texts = [...(await marked.allInnerTexts()), ...(await failure.allInnerTexts())]
        .map((t) => t.replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length <= 160);
      const unique = [...new Set(texts)].slice(0, 2);
      return unique.length ? unique.map((t) => `"${t}"`).join(' and ') : undefined;
    } catch {
      return undefined;
    }
  }

  async function screenshot(item: ExploredItem): Promise<void> {
    const file = path.join(options.outDir, `${model.id}-${item.phase === 'setup' ? 'setup-' : ''}${item.id}.png`);
    try {
      await browserPage().screenshot({ path: file });
      item.screenshot = file;
    } catch (e) {
      item.warnings.push(`screenshot failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  /** The part of the page the tester picked for a name ("login" → this table), so it is asked once. */
  const partPicks = new Map<string, string>();

  /** Pop-ups seen since the last look are attached to the step that caused them. */
  function collectDialogs(item: ExploredItem): void {
    const seen = mcp.takeDialogs();
    if (!seen.length) return;
    item.dialogs = [...(item.dialogs ?? []), ...seen];
    item.warnings.push(`The page showed a pop-up (${seen.join('; ')}). It was accepted automatically so the test could go on.`);
  }

  const explained = (code: string, text: string, query: TargetQuery, r: { candidates: Candidate[] }, raw: string) =>
    explain({
      code,
      raw,
      label: query.target,
      text,
      candidates: r.candidates.map((c) => ({ role: c.node.role, name: c.matchedName || c.node.name, score: c.score })),
    });

  /**
   * For a position check on a part of the page: do the candidate parts disagree about the result? Measured on the
   * page as it is now. Returns the candidates to choose from, or nothing when they all give the same answer.
   */
  async function holdersDisagree(query: TargetQuery, candidates: Candidate[]): Promise<Candidate[] | undefined> {
    if (query.kind !== 'centered' && query.kind !== 'region') return undefined;
    try {
      const page = browserPage();
      const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
      const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
      for (const n of flatten(parseSnapshot(await page.ariaSnapshot({ mode: 'ai', boxes: true })))) {
        const box = typeof n.attributes.box === 'string' ? n.attributes.box.split(',').map(Number) : [];
        if (n.ref && box.length === 4 && box[2] > 0 && box[3] > 0) boxes.set(n.ref, { x: box[0], y: box[1], width: box[2], height: box[3] });
      }
      const top = candidates.slice(0, 6).filter((c) => c.node.ref && boxes.has(c.node.ref));
      if (top.length < 2) return undefined;
      const tolerance = query.options?.tolerance ?? 0.05;
      const axis = query.options?.axis ?? 'x';
      const answer = (b: { x: number; y: number; width: number; height: number }) => {
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        if (query.kind === 'region') {
          const col = cx < size.width / 3 ? 'left' : cx > (size.width * 2) / 3 ? 'right' : 'center';
          const row = cy < size.height / 3 ? 'top' : cy > (size.height * 2) / 3 ? 'bottom' : 'center';
          return row === 'center' ? col : col === 'center' ? row : `${row}-${col}`;
        }
        const okX = Math.abs(cx - size.width / 2) <= size.width * tolerance;
        const okY = Math.abs(cy - size.height / 2) <= size.height * tolerance;
        return axis === 'x' ? okX : axis === 'y' ? okY : okX && okY;
      };
      const answers = new Set(top.map((c) => answer(boxes.get(c.node.ref as string)!)));
      return answers.size > 1 ? top : undefined;
    } catch {
      return undefined;
    }
  }

  /** LOCATE + VALIDATE, asking the tester when the rules cannot decide. */
  async function find(query: TargetQuery, item: ExploredItem, state: PageState): Promise<Extract<LocateResult, { status: 'resolved' }> | undefined> {
    const locateOptions = { config: options.config, testIdAttribute: session.testIdAttribute, pageHint: pathNames[pathOf(state.url)] };
    // A part of the page the tester already pointed out ("the login section") stays that part for the whole test.
    const partKey = query.container ? `${(query.target ?? '').toLowerCase()}|${pathOf(state.url)}` : undefined;
    const remembered = partKey ? partPicks.get(partKey) : undefined;
    const rememberedNode = remembered ? nodeByRef(state, remembered) : undefined;
    let r = await locate(query, mcp, probe, locateOptions, rememberedNode ? { state, node: rememberedNode } : { state });
    item.resolvedBy = rememberedNode ? 'tester' : 'rules';
    // "The login section" can be the form, or the whole panel around it. If the answer to the check depends on which,
    // the tester says which: guessing would pass or fail the test for the wrong reason (D6).
    if (r.status === 'resolved' && query.container && !rememberedNode) {
      const differ = await holdersDisagree(query, r.candidates);
      if (differ) {
        r = {
          status: 'needs-review',
          page: r.page,
          code: 'AMBIGUOUS_PART',
          text: `Several parts of the page could be "${query.target ?? 'it'}", and they are in different places.`,
          candidates: differ,
          tried: r.tried,
        };
      }
    }
    let asked = 0;
    while (r.status === 'needs-review') {
      item.candidates = r.candidates.slice(0, 5).map(summary);
      if (asked >= MAX_QUESTIONS) {
        // Every answer so far pointed to something this step cannot use; stop asking.
        item.status = 'failed';
        item.review = explained(r.code, r.text, query, r, item.raw);
        item.error = `No usable element after ${asked} answers. ${sentence(item.review)}`;
        return undefined;
      }
      const view = await pageView(query, r.candidates, `${item.id}-q${++asked}`);
      const answer = await options.resolver.choose({
        item: item.id,
        raw: item.raw,
        target: query.target,
        code: r.code,
        text: r.text,
        candidates: r.candidates,
        view,
      });
      if (answer === 'abort') throw new Aborted();
      if (answer === 'skip') {
        item.status = 'skipped';
        item.review = explained(r.code, r.text, query, r, item.raw);
        item.warnings.push(`Skipped by the tester. ${sentence(item.review)}`);
        return undefined;
      }
      // A candidate from the list, or any element picked on the screenshot (FR-RV-02).
      const node = typeof answer === 'number' ? r.candidates[answer]?.node : nodeByRef(state, answer.ref);
      if (!node) {
        item.warnings.push(typeof answer === 'number' ? `No candidate ${answer + 1}.` : `No element ${answer.ref} on the page any more.`);
        continue;
      }
      item.resolvedBy = 'tester';
      const again = await locate(query, mcp, probe, locateOptions, { state, node });
      if (again.status === 'needs-review') {
        // The picked element cannot be used for this step (not unique, not actionable): ask again.
        item.warnings.push(sentence(explained(again.code, again.text, query, again, item.raw)));
        r = { ...again, candidates: r.candidates.filter((c) => c.node.ref !== node.ref) };
        if (!r.candidates.length && typeof answer === 'number') {
          item.status = 'failed';
          item.review = explained(again.code, again.text, query, again, item.raw);
          item.error = sentence(item.review);
          return undefined;
        }
        continue;
      }
      r = again;
      if (partKey && node.ref) partPicks.set(partKey, node.ref);
    }
    item.locator = { code: r.locator.code, strategy: r.locator.spec.strategy, source: r.locator.spec.source, validated: true };
    item.element = { role: r.match.node.role, name: r.match.matchedName || r.match.node.name };
    item.alternatives = r.tried.filter((v) => v.ok && v !== r.locator).map((v) => v.code);
    item.score = r.match.score;
    item.candidates ??= r.candidates.slice(0, 5).map(summary);
    item.fingerprint = r.fingerprint;
    item.page = r.page;
    result.pages[r.page.name] ??= { path: r.page.path, title: r.page.title };
    return r;
  }

  async function navigate(step: Step, item: ExploredItem, first: boolean): Promise<void> {
    // "Open the application", "Enter the URL": the base URL exactly as set, path included.
    let url = step.baseUrl ? options.baseUrl : step.url;
    if (!url && step.page) {
      // D19: the first step's page is the base URL; any other page name is asked for once.
      const known = pageUrls[step.page];
      if (known) url = known;
      else if (first) url = options.baseUrl;
      else {
        const answer = await options.resolver.pageUrl({ item: item.id, page: step.page });
        if (answer === 'abort') throw new Aborted();
        url = answer;
      }
      pageUrls[step.page] = url;
      if (!options.pageUrls?.[step.page]) learned[step.page] = relativeTo(options.baseUrl, url);
    }
    if (!url) throw new Error('The step names no page or URL.');
    const target = new URL(url, options.baseUrl).toString();
    await mcp.navigate(target);
    const state = await settle(item);
    item.effect = `url ${pathOf(state.url)}`;
    if (step.page || step.baseUrl) namePage(state.url, state.title, step.page);
  }

  async function act(step: Step, item: ExploredItem): Promise<void> {
    const action = step.action!;
    if (action === 'back') {
      await mcp.callTool('browser_navigate_back');
      item.effect = `url ${pathOf((await settle(item)).url)}`;
      return;
    }
    if (action === 'forward' || action === 'refresh') {
      const page = browserPage();
      await (action === 'forward' ? page.goForward() : page.reload());
      item.effect = `url ${pathOf((await settle(item)).url)}`;
      return;
    }
    if (action === 'press' && !step.target) {
      const before = await mcp.snapshot();
      await mcp.callTool('browser_press_key', { key: step.key });
      item.effect = (await waitForChange(before)) ?? 'no change';
      await settle(item);
      return;
    }

    // Element actions.
    let value: string | undefined;
    if (step.value) {
      const v = resolveValue(step.value, { env: options.env, data: model.data, now });
      if (!v.ok) {
        item.status = 'failed';
        item.error = v.error;
        return;
      }
      value = v.value;
      if (v.secret) secrets.add(v.value);
    }
    if ((action === 'fill' || action === 'select' || action === 'upload') && value === undefined) {
      item.status = 'failed';
      item.error = `A ${action} step needs a value.`;
      return;
    }

    const before = await mcp.snapshot();
    const query: TargetQuery = { kind: action, target: step.target, alternatives: step.alternatives, exact: step.exact, roleHint: step.roleHint };
    const found = await find(query, item, before);
    if (!found) return;
    const ref = found.match.node.ref!;
    const element = found.match.node.name || found.match.matchedName || found.match.node.role;
    const page = browserPage(before.url);
    const winner = found.locator.spec;
    const live = toLocator(page, winner);

    let reply: ToolReply | undefined;
    switch (action) {
      case 'fill':
        reply = await mcp.type(ref, value!, element);
        break;
      case 'clear':
        reply = await mcp.type(ref, '', element);
        break;
      case 'click':
        reply = await mcp.click(ref, element);
        break;
      case 'check':
      case 'uncheck':
        if ((await live.isChecked()) !== (action === 'check')) reply = await mcp.click(ref, element);
        else item.warnings.push(`already ${action}ed, so nothing was clicked`);
        break;
      case 'select':
        reply = await mcp.callTool('browser_select_option', { target: ref, values: [value!], element });
        break;
      case 'hover':
        reply = await mcp.callTool('browser_hover', { target: ref, element });
        break;
      case 'upload':
        await live.setInputFiles(path.resolve(value!));
        break;
      case 'press':
        reply = await mcp.callTool('browser_press_key', { key: step.key });
        break;
    }

    // FR-LO-07: MCP's code for the action is one more candidate, while the element is still there.
    const reported = reply?.code && parseLocatorCode(firstLine(reply.code));
    if (reported && ['fill', 'clear', 'select', 'check', 'uncheck', 'hover'].includes(action)) {
      const v = await probe.validateAgainst(page, reported, action, winner).catch(() => undefined);
      if (v?.ok && !item.alternatives?.includes(v.code) && v.code !== item.locator?.code) (item.alternatives ??= []).push(`${v.code}  (MCP, after action)`);
    }

    item.effect = await verifyEffect(action, live, value, before);
    collectDialogs(item);
    if (item.effect === undefined && item.dialogs?.length) item.effect = `pop-up ${item.dialogs[0]}`;
    if (item.effect === undefined) {
      const go = await options.resolver.confirm({
        item: item.id,
        code: 'NO_EFFECT',
        raw: mask(step.raw),
        text: `"${mask(step.raw)}" changed nothing on the page. Continue anyway?`,
      });
      if (!go) throw new Aborted();
      item.warnings.push('NO_EFFECT: the action changed nothing; the tester continued');
      item.effect = 'no change';
    }
    const after = await settle(item);
    item.url = after.url;
  }

  async function verifyEffect(action: Action, live: ReturnType<typeof toLocator>, value: string | undefined, before: PageState): Promise<string | undefined> {
    switch (action) {
      case 'fill':
        return (await live.inputValue().catch(() => undefined)) === value ? 'value set' : undefined;
      case 'clear':
        return (await live.inputValue().catch(() => undefined)) === '' ? 'value cleared' : undefined;
      case 'check':
      case 'uncheck':
        return (await live.isChecked()) === (action === 'check') ? `${action}ed` : undefined;
      case 'select': {
        const chosen = await live
          .evaluate((el) => (el instanceof HTMLSelectElement ? [...el.selectedOptions].flatMap((o) => [o.value, o.label]) : []))
          .catch((): string[] => []);
        return chosen.includes(value!) ? 'option selected' : undefined;
      }
      case 'hover':
      case 'upload':
        return action === 'upload' ? 'file set' : 'hovered';
      default:
        return waitForChange(before);
    }
  }

  async function check(assertion: Assertion, item: ExploredItem): Promise<void> {
    const state = await mcp.snapshot();
    item.observed = { url: state.url, title: state.title };
    const type = assertion.type!;
    if (type === 'url' && assertion.match === 'page' && assertion.expected && !assertion.negated) {
      // The page a check expects, e.g. "redirected to Dashboard", names the current page (D19)
      // — but not a page that already has another name: then the expected page was not reached,
      // e.g. the login failed, and learning it would make the test pass without getting there.
      const path = pathOf(state.url);
      const wanted = pageOf(state.url, state.title, assertion.expected).name;
      const known = pageUrls[assertion.expected];
      const current = pathNames[path];
      // Not reached: the path already belongs to another page, or a saved URL for this page is elsewhere.
      const reached = (!current || current === wanted) && (!known || pathOf(new URL(known, options.baseUrl).toString()) === path);
      if (!reached) {
        const shown = await pageMessages(state.url);
        const ok = await options.resolver.confirm({
          item: item.id,
          code: 'NOT_ON_PAGE',
          page: assertion.expected,
          text: `The test expects the ${assertion.expected} page, but the browser is on ${current ?? path} (${path})${shown ? `, which shows ${shown}` : ''}. An earlier step may not have worked. Is this the ${assertion.expected} page?`,
        });
        if (!ok) {
          item.status = 'failed';
          item.error = `Not on the ${assertion.expected} page: still on ${current ?? path}${shown ? `, which shows ${shown}` : ''}.`;
          return;
        }
        // The tester says it is: this path is the expected page from now on.
        pathNames[path] = wanted;
      }
      namePage(state.url, state.title, assertion.expected);
      if (!known) learned[assertion.expected] = pageUrls[assertion.expected] = path;
    }
    if (type === 'text' && assertion.expected) {
      item.observed.textFound = (await browserPage(state.url).getByText(assertion.expected).count()) > 0;
    }
    if (!assertion.target && !assertion.roleHint) return;

    const query: TargetQuery = {
      kind: type,
      target: assertion.target,
      alternatives: assertion.alternatives,
      exact: assertion.exact,
      roleHint: assertion.roleHint,
      container: assertion.container,
      options: assertion.options,
    };
    if (assertion.negated && (type === 'visible' || type === 'attached')) {
      // An element that must not be visible is usually not on the page, so it cannot be validated.
      const r = await locate(query, mcp, probe, { config: options.config, testIdAttribute: session.testIdAttribute }, { state });
      item.page = pageOf(state.url, state.title, pathNames[pathOf(state.url)]);
      if (r.status === 'resolved') {
        item.locator = { code: r.locator.code, strategy: r.locator.spec.strategy, source: r.locator.spec.source, validated: true };
        item.element = { role: r.match.node.role, name: r.match.matchedName || r.match.node.name };
      } else {
        const text = assertion.target ?? '';
        item.locator = { code: toCode(spec('getByText', text, { exact: true })), strategy: 'text', source: 'ladder', validated: false };
        item.element = { role: 'text', name: text };
        item.warnings.push('UNVALIDATED: the element is not on the page now, so this locator could not be checked. Confirm it in review.');
      }
      return;
    }
    const found = await find(query, item, state);
    // A check that compares two elements ("Cancel is to the left of Save") needs both found, the second the same way.
    if (found && assertion.other?.target) {
      const second: ExploredItem = { id: item.id, kind: 'check', raw: assertion.other.target, phase: item.phase, status: 'done', warnings: [] };
      const otherQuery: TargetQuery = {
        kind: type,
        target: assertion.other.target,
        alternatives: assertion.other.alternatives,
        exact: assertion.other.exact,
        roleHint: assertion.other.roleHint,
      };
      await find(otherQuery, second, state);
      if (second.status !== 'done' || !second.locator || !second.element) {
        item.status = second.status === 'done' ? 'failed' : second.status;
        item.review = second.review;
        item.warnings.push(...second.warnings);
        item.error = second.error;
        return;
      }
      item.other = { locator: second.locator, element: second.element };
    }
  }

  try {
    if (options.production) {
      const ok = await options.resolver.confirm({
        item: 'start',
        code: 'PRODUCTION',
        text: 'This is a Production environment. Exploration really clicks buttons and can change data. Explore anyway?',
      });
      if (!ok) throw new Aborted();
    }

    const loggedIn = model.preconditions.find((p) => p.kind === 'logged-in');
    if (loggedIn) {
      if (!options.login) {
        const ok = await options.resolver.confirm({
          item: 'preconditions',
          code: 'NO_LOGIN',
          text: `"${loggedIn.raw}" needs a login test case (--login). Continue without logging in?`,
        });
        if (!ok) throw new Aborted();
      } else {
        result.setup = { testId: options.login.id, steps: options.login.steps, data: options.login.data };
        await run(options.login, 'setup');
      }
    }
    for (const p of model.preconditions.filter((p) => p.kind === 'flow')) {
      const ok = await options.resolver.confirm({
        item: 'preconditions',
        code: 'FLOW_V2',
        text: `Reusable flows ("${p.raw}") arrive in V2. Continue from the test's first step?`,
      });
      if (!ok) throw new Aborted();
    }
    await run(model, 'test');
  } catch (e) {
    if (!(e instanceof Aborted)) throw e;
    result.status = 'aborted';
  }

  async function run(m: TestModel, phase: ExploredItem['phase']): Promise<void> {
    const order = phase === 'setup' ? m.steps : executionOrder(m);
    let firstStep = true;
    for (const x of order) {
      // Checks carry a `source`; steps do not.
      const isStep = !('source' in x);
      const item: ExploredItem = {
        id: x.id,
        kind: isStep ? 'step' : 'check',
        raw: x.raw,
        phase,
        status: 'done',
        warnings: [],
        ...(isStep ? { action: (x as Step).action } : { type: (x as Assertion).type }),
      };
      result.items.push(item);
      if (x.status === 'unparsed') {
        item.status = 'skipped';
        item.review = explain({ code: x.reason?.code ?? 'NO_PATTERN', raw: x.raw, text: x.reason?.text });
        item.warnings.push(`Not understood. ${sentence(item.review)}`);
        continue;
      }
      try {
        if (isStep) {
          const step = x as Step;
          if (step.action === 'navigate') await navigate(step, item, firstStep);
          else await act(step, item);
          firstStep = false;
        } else {
          await check(x as Assertion, item);
        }
      } catch (e) {
        if (e instanceof Aborted) throw e;
        item.status = 'failed';
        item.error = mask(plainError((e as Error).message));
      }
      collectDialogs(item);
      item.warnings = item.warnings.map(mask);
      if (item.error) item.error = mask(item.error);
      await screenshot(item);
      if (item.status === 'failed' && item.kind === 'step') {
        // Later steps depend on this one; stop rather than explore a wrong state.
        result.status = 'incomplete';
        return;
      }
    }
  }

  if (result.status === 'complete' && result.items.some((i) => i.status !== 'done')) result.status = 'incomplete';
  result.finishedAt = new Date().toISOString();
  return result;
}

/** The snapshot node with this ref, from the snapshot the step was matched on. */
function nodeByRef(state: PageState, ref: string): SnapshotNode | undefined {
  return flatten(parseSnapshot(state.snapshotYaml)).find((n) => n.ref === ref);
}

const summary = (c: Candidate) => ({ ref: c.node.ref, role: c.node.role, name: c.matchedName || c.node.name, score: c.score });
const firstLine = (code: string) => code.split('\n').find((l) => l.includes('page.')) ?? code;

/** A URL on the base URL's site as a path (`/profile`), so it works in any environment; other sites stay absolute. */
function relativeTo(baseUrl: string, url: string): string {
  try {
    const u = new URL(url, baseUrl);
    return u.origin === new URL(baseUrl).origin ? `${u.pathname}${u.search}` : u.toString();
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
