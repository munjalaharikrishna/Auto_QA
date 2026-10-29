import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { OtpError, type OtpSource } from '../auth/index.js';
import { withoutClassWords } from '../data/classes.js';
import type { ResolvedValue } from '../data/resolver.js';
import { isMasked, maskDeep, Secret } from '../data/secret.js';
import type { IrTarget } from '../ir/schema.js';
import { type Application, CORE_LABELS, consolidate } from '../knowledge/index.js';
import {
  type DomElement,
  inspectPage,
  inspectPageDetailed,
  type Level,
  type LocateQuery,
  locate,
  pageIdentityOf,
  sameFrame,
  selectorIn,
  type Tried,
} from '../locate/index.js';
import { refusesOtp } from '../patterns/index.js';
import { blockers, type Capabilities, discover, type FunctionName, type McpPort } from './capabilities.js';
import { type Delta, describe, diff } from './delta.js';
import { type Observation, observe } from './observe.js';
import type { Chain, ExecutionPlan } from './planner.js';
import { findRow, type TableRow } from './tables.js';
import { type SettleOptions, trackNavigations, waitSettled, waitUntilIdle } from './waits.js';

/**
 * Layer 37, execution through Playwright MCP (EX-02). Each step of the plan is done by the engine's own decisions: it
 * finds the element with the candidate engine (E0.6), gives the MCP server a selector that finds exactly that element,
 * and calls the tool for the action. No code is generated and no agent chooses. Before and after every step the page is
 * observed and the difference is kept (EX-04, EX-05). A step that cannot be done safely stops the run with a reason and
 * a code: nothing after it is run on a page that is not as expected.
 */

export type BlockCode =
  | 'TOOL_MISSING'
  | 'LOCATE_NOT_FOUND'
  | 'LOCATE_AMBIGUOUS'
  | 'LOCATE_INACTIVE'
  | 'LOCATOR_NOT_UNIQUE'
  | 'VALUE_UNRESOLVED'
  | 'ROW_NOT_FOUND'
  | 'ROW_AMBIGUOUS'
  | 'PAGE_UNKNOWN'
  | 'FILE_MISSING'
  | 'FILE_NOT_ALLOWED'
  | 'UNSUPPORTED_ACTION'
  | 'ACTION_FAILED'
  /** No mail with the one-time code came within the wait (AU-06): the environment, never a FAIL. */
  | 'OTP_MAIL_NOT_RECEIVED'
  /** The application refused a one-time code that was read correctly (AU-06): test data, never a FAIL. */
  | 'OTP_REJECTED';

class Block extends Error {
  constructor(
    readonly code: BlockCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Located {
  name: string;
  level: Level;
  weight: number;
  /** The selector the tool was given. */
  selector: string;
  /** The page, the component and the name this selector is the answer for (GV-02). */
  contract: LocatorContractRef;
  tried: Tried[];
  element: { tag: string; role: string; id?: string; form?: string };
  /** Other matches that were not used, with why (hidden, covered, …). */
  ignored: string[];
  /** For a target in a table row: where the row was found. */
  row?: { page: string; cells: string[]; pagesVisited: number };
}

export interface Call {
  via: 'mcp' | 'page';
  tool: string;
  args: Record<string, unknown>;
  /** The number of the call in the run, from 1, in the order they were made. A gap in the numbers means a call was lost (GV-02). */
  seq: number;
  /** The function of the action planner this call serves (`type`, `click`, …); for a call made through the page, its own name. */
  fn: string;
  /** When it started (milliseconds since the epoch) and how long it took. */
  at: number;
  ms: number;
  /** A call that failed is recorded too, with what went wrong. */
  outcome: 'ok' | 'failed';
  error?: string;
}

/** Who a locator was found for and how: the contract of GV-02, from the page down to the selector chain. */
export interface LocatorContractRef {
  /** Stable: the same page, name and selector give the same id in every run. */
  id: string;
  /** The page the element is on: its name in the application's knowledge, else the address path. */
  page: string;
  /** The component of the application's knowledge it matched, when there is one. */
  component?: string;
  /** The name the test case used for it. */
  semantic: string;
}

export interface StepRecord {
  step: string;
  action: string;
  original: string;
  status: 'done' | 'blocked' | 'failed' | 'skipped';
  code?: BlockCode;
  reason?: string;
  located?: Located;
  /** Every call of the step, successful or not, in order. */
  calls: Call[];
  before?: Observation;
  after?: Observation;
  delta?: Delta;
  /** What changed, in words (EX-05). */
  changes: string[];
  dialogs: string[];
  /** A tab the step opened, and that the run moved to (UI-02). */
  tab?: { opened: number; url: string; title: string };
  /** The form a submit button belongs to (UI-04). */
  submit?: { form: string };
  /** The checks of the QA-IR judged on the page this step leaves. */
  checksAfter: string[];
  /** Pictures of the page before and after the step, when a folder was given: what a review card shows. */
  screenshots?: { before?: string; after?: string };
  notes: string[];
}

export interface RunTrace {
  testId: string;
  status: 'completed' | 'blocked' | 'failed';
  /** What the MCP server lacks and what is done instead (EX-03). */
  capabilities: string[];
  steps: StepRecord[];
  /** The step the run stopped at, and why. */
  stoppedAt?: { step: string; code: BlockCode | 'START'; reason: string };
}

export interface ExecuteInput {
  plan: ExecutionPlan;
  values?: Record<string, ResolvedValue>;
  /** The addresses the compile found for named pages. */
  pages?: Record<string, string | null>;
}

export interface ExecuteOptions {
  mcp: McpPort;
  page: Page;
  baseUrl?: string;
  knowledge?: Application;
  testIdAttribute?: string;
  settle?: SettleOptions;
  /** A folder to keep a picture of the page before and after every step in (the evidence of a review card). */
  screenshotDir?: string;
  /** Where the one-time code of a login comes from when the test runs (AU-04, AU-05). Without it, a step that needs one is not run. */
  otp?: OtpSource;
  /** Keep the observations before and after each step in the trace. On by default. */
  keepObservations?: boolean;
}

const MASK = '••••';

/** The id of a locator contract: the same page, name and selector give the same id in every run (GV-02). */
const contractId = (page: string, semantic: string, selector: string): string =>
  createHash('sha256').update(`${page}|${semantic}|${selector}`).digest('hex').slice(0, 12);

class Runner {
  private page: Page;
  private readonly caps: Capabilities;
  private readonly values: Record<string, ResolvedValue>;
  private readonly pages: Record<string, string | null>;
  private dismissedDialog = false;
  /** When the step before this one started: only mail that came after it is for this login (AU-04). */
  private lastStart: number | undefined;
  /** The number of the last call of the run (GV-02). */
  private seq = 0;
  private since = 0;
  /** The step that typed a one-time code; the page after it is read for a refusal (AU-06). */
  private otpStep: string | undefined;
  /** The values of the secrets typed so far: they are masked wherever the page reads them back (a code typed into a plain field). */
  private readonly typed = new Set<string>();
  /** Pages the run has been on: a tab it left is not "new" when it comes up again. */
  private readonly known = new Set<Page>();

  constructor(
    private readonly input: ExecuteInput,
    private readonly o: ExecuteOptions,
  ) {
    this.page = o.page;
    this.caps = discover(o.mcp);
    this.values = input.values ?? {};
    this.pages = input.pages ?? {};
  }

  private get testIdAttribute(): string {
    return this.o.testIdAttribute ?? 'data-testid';
  }

  async run(): Promise<RunTrace> {
    const { plan } = this.input;
    const base: RunTrace = { testId: plan.testId, status: 'completed', capabilities: this.caps.report, steps: [] };
    const missing = blockers(this.caps, plan.needs);
    if (missing.length) {
      const reason = `the run needs what the MCP server does not offer: ${missing.join('; ')}`;
      return {
        ...base,
        status: 'blocked',
        steps: plan.chains.map((c) => this.skipped(c)),
        stoppedAt: { step: plan.chains[0]?.step ?? '-', code: 'START', reason },
      };
    }
    let stopped: RunTrace['stoppedAt'];
    for (const chain of plan.chains) {
      if (stopped) {
        base.steps.push(this.skipped(chain));
        continue;
      }
      const rec = await this.step(chain);
      base.steps.push(rec);
      if (rec.status === 'blocked' || rec.status === 'failed') {
        stopped = { step: chain.step, code: rec.code ?? 'ACTION_FAILED', reason: rec.reason ?? '' };
        base.status = rec.status;
      }
    }
    return stopped ? { ...base, stoppedAt: stopped } : base;
  }

  private skipped(c: Chain): StepRecord {
    return {
      step: c.step,
      action: c.action,
      original: c.original,
      status: 'skipped',
      calls: [],
      changes: [],
      dialogs: [],
      checksAfter: c.checksAfter,
      notes: [],
    };
  }

  /** The tabs that have a page in them: the starter tab of the browser is empty and does not count. */
  private realPages(): Page[] {
    return this.page
      .context()
      .pages()
      .filter((p) => !p.isClosed() && p.url() !== 'about:blank');
  }

  private tabCount(): number {
    return Math.max(1, this.realPages().length);
  }

  /**
   * The MCP server works in a page of its own in the shared browser. The engine moves to the page the server says is its
   * current tab, found by its address, the first time it has one, and again when its own page is gone.
   */
  private async adoptPage(rec: StepRecord): Promise<void> {
    if (!this.page.isClosed() && this.page.url() !== 'about:blank') return;
    const current = (await this.mcpTabs(rec)).find((t) => t.current);
    const real = this.realPages();
    const same = current ? real.filter((p) => p.url() === current.url) : [];
    const pick = (same.length ? same : real).at(-1);
    if (pick) this.page = pick;
  }

  private async step(chain: Chain): Promise<StepRecord> {
    const rec: StepRecord = {
      step: chain.step,
      action: chain.action,
      original: chain.original,
      status: 'done',
      calls: [],
      changes: [],
      dialogs: [],
      checksAfter: chain.checksAfter,
      notes: [],
    };
    const keep = this.o.keepObservations ?? true;
    await this.adoptPage(rec);
    trackNavigations(this.page);
    const tabsBefore = this.tabCount();
    const pagesBefore = new Set(this.realPages());
    const before = await observe(this.page, { testIdAttribute: this.testIdAttribute, tabs: tabsBefore });
    const beforeShot = await this.shoot(chain.step, 'before');
    this.o.mcp.setDialogPolicy?.(() => ({ accept: chain.dialog !== 'dismiss' }));
    const startedAt = this.o.otp?.now() ?? Date.now();
    this.since = this.lastStart ?? startedAt;
    this.lastStart = startedAt;
    try {
      await this.fillOtp(chain);
      await this.act(chain, rec);
    } catch (e) {
      if (e instanceof Block) {
        rec.status = 'blocked';
        rec.code = e.code;
      } else {
        rec.status = 'failed';
        rec.code = 'ACTION_FAILED';
      }
      rec.reason = (e as Error).message;
    }
    rec.dialogs = this.o.mcp.takeDialogs();
    this.dismissedDialog = chain.dialog === 'dismiss' && rec.dialogs.length > 0;
    await this.followTabs(tabsBefore, pagesBefore, rec);
    if (chain.action !== 'WAIT') await waitSettled(this.page, this.o.settle);
    const after = await observe(this.page, { testIdAttribute: this.testIdAttribute, tabs: this.tabCount() });
    this.checkOtpRefusal(chain, before, after, rec);
    const delta = diff(before, after, rec.dialogs);
    rec.delta = delta;
    rec.changes = describe(delta);
    const afterShot = await this.shoot(chain.step, 'after');
    if (beforeShot || afterShot) rec.screenshots = { ...(beforeShot ? { before: beforeShot } : {}), ...(afterShot ? { after: afterShot } : {}) };
    if (keep) {
      rec.before = before;
      rec.after = after;
    }
    return this.typed.size ? maskDeep(rec, this.typed) : rec;
  }

  private async shoot(step: string, when: 'before' | 'after'): Promise<string | undefined> {
    const dir = this.o.screenshotDir;
    if (!dir) return undefined;
    const file = path.join(dir, `${this.input.plan.testId}-${step}-${when}.png`);
    try {
      mkdirSync(dir, { recursive: true });
      await this.page.screenshot({ path: file });
      return file;
    } catch {
      return undefined;
    }
  }

  /** The tabs the MCP server lists: `- 1: [Help centre](http://…)`, the one it works in marked `(current)`. */
  private async mcpTabs(rec: StepRecord): Promise<Array<{ index: number; current: boolean; url: string }>> {
    const status = this.caps.functions.tabs;
    if (status.status !== 'ok') return [];
    const reply = await this.timed(rec, 'mcp', status.tool as string, 'tabs', { action: 'list' }, () =>
      this.o.mcp.callTool(status.tool as string, { action: 'list' }),
    );
    const tabs: Array<{ index: number; current: boolean; url: string }> = [];
    for (const raw of reply.raw.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('- ')) continue;
      const colon = line.indexOf(':');
      const index = Number(line.slice(2, colon));
      const open = line.lastIndexOf('](');
      if (!Number.isInteger(index) || open < 0) continue;
      tabs.push({ index, current: line.includes('(current)'), url: line.slice(open + 2, line.lastIndexOf(')')) });
    }
    return tabs;
  }

  /** A step that opens a tab or a window: the run goes to it, and says so (UI-02). */
  private async followTabs(countBefore: number, pagesBefore: Set<Page>, rec: StepRecord): Promise<void> {
    if (this.page.isClosed()) await this.adoptPage(rec);
    const real = this.realPages();
    if (real.length <= countBefore || this.page.url() === 'about:blank') return this.adoptPage(rec);
    const opened = real.find((p) => !pagesBefore.has(p)) ?? (real[real.length - 1] as Page);
    await opened.waitForLoadState('domcontentloaded').catch(() => {});
    const listed = await this.mcpTabs(rec);
    const mine = listed.find((t) => t.url === opened.url());
    const status = this.caps.functions.tabs;
    if (status.status === 'ok' && mine) {
      await this.timed(rec, 'mcp', status.tool as string, 'tabs', { action: 'select', index: mine.index }, () =>
        this.o.mcp.callTool(status.tool as string, { action: 'select', index: mine.index }),
      );
    } else {
      await opened.bringToFront();
      this.note(rec, { via: 'page', tool: 'bringToFront', fn: 'bringToFront', args: { url: opened.url() }, at: Date.now(), ms: 0, outcome: 'ok' });
    }
    this.known.add(this.page);
    this.page = opened;
    rec.tab = { opened: real.length, url: opened.url(), title: await opened.title() };
  }

  // ---- values ----

  /**
   * A step that types the one-time code of the login: the code is asked for now, for this login, and kept only in memory.
   * It is never in the plan or the data table (AU-07). Without a source, or when the mail does not come, the step does not run.
   */
  private async fillOtp(chain: Chain): Promise<void> {
    const key = chain.value?.startsWith('$data.') ? chain.value.slice(6) : undefined;
    const v = key ? this.values[key] : undefined;
    if (!key || !v || v.rule !== 'otp.at-run') return;
    const otp = this.o.otp;
    if (!otp) throw new Block('VALUE_UNRESOLVED', `the one-time code for "${chain.original}" has no source: set the login type of the application`);
    try {
      this.values[key] = { ...v, value: await otp.code({ since: this.since }) };
      this.otpStep = chain.step;
    } catch (e) {
      if (e instanceof OtpError) throw new Block(e.kind === 'NOT_RECEIVED' ? 'OTP_MAIL_NOT_RECEIVED' : 'VALUE_UNRESOLVED', e.message);
      throw e;
    }
  }

  /**
   * After a one-time code was typed, a message that is new on the page and says the code is wrong or expired means the
   * application refused it: a problem of the data, not a failure of what the test checks (AU-06).
   */
  private checkOtpRefusal(chain: Chain, before: Observation, after: Observation, rec: StepRecord): void {
    if (!this.otpStep) return;
    if (chain.step !== this.otpStep) this.otpStep = undefined; // only the typing step and the one after it
    if (rec.status !== 'done') return;
    const shown = (o: Observation): string[] => [...o.messages, ...o.fieldErrors.map((f) => f.message)];
    const known = new Set(shown(before));
    const refused = shown(after).find((m) => !known.has(m) && refusesOtp(m));
    if (refused === undefined) return;
    rec.status = 'blocked';
    rec.code = 'OTP_REJECTED';
    rec.reason = `the application refused the one-time code: "${refused}"`;
  }

  private valueOf(text: string | undefined, what: string): { text: string; secret: boolean } {
    if (text === undefined) throw new Block('VALUE_UNRESOLVED', `${what} has no value`);
    if (text.startsWith('$ref.')) throw new Block('VALUE_UNRESOLVED', `${what} refers to "${text}", which was not resolved`);
    if (!text.startsWith('$data.')) return { text, secret: false };
    const resolved = this.values[text.slice(6)];
    if (!resolved)
      throw new Block(
        'VALUE_UNRESOLVED',
        `the value "${text.slice(6)}" for ${what} was not resolved: give it in Test Data, an environment variable or the credential store`,
      );
    const shown = resolved.value instanceof Secret ? resolved.value.reveal() : resolved.value;
    // What is left of a secret that was hidden on the way is not the secret: it is never typed (E0.12, S4).
    if (isMasked(shown))
      throw new Block('VALUE_UNRESOLVED', `the value for ${what} is a mask (••••), not a value: the real one was hidden before it reached the engine`);
    if (!(resolved.value instanceof Secret)) return { text: resolved.value, secret: false };
    const clear = resolved.value.reveal();
    this.typed.add(clear);
    return { text: clear, secret: true };
  }

  // ---- calls ----

  /** Calls the MCP tool of a function; for a function with a way round, `undefined` says the caller does it through the page. */
  private async tool(fn: FunctionName, args: Record<string, unknown>, rec: StepRecord, shown: Record<string, unknown> = args): Promise<'used' | 'fallback'> {
    const status = this.caps.functions[fn];
    if (status.status === 'missing')
      throw new Block('TOOL_MISSING', `${fn}: ${status.wanted.map((t) => `"${t}"`).join(' or ')} is not offered by the MCP server and there is no way round`);
    if (status.status === 'fallback') return 'fallback';
    const name = status.tool as string;
    // A tool that was renamed takes its arguments the new way.
    const sent =
      fn === 'type' && name === 'browser_fill_form'
        ? { fields: [{ name: args.element ?? 'field', type: 'textbox', target: args.target, value: args.text }] }
        : args;
    await this.timed(rec, 'mcp', name, fn, shown, () => this.o.mcp.callTool(name, sent));
    return 'used';
  }

  /** Makes a call and records it whether it works or not: what was asked, when, for how long, and what came of it (GV-02). */
  private async timed<T>(rec: StepRecord, via: Call['via'], tool: string, fn: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    const at = Date.now();
    try {
      const result = await run();
      this.note(rec, { via, tool, fn, args, at, ms: Date.now() - at, outcome: 'ok' });
      return result;
    } catch (e) {
      this.note(rec, { via, tool, fn, args, at, ms: Date.now() - at, outcome: 'failed', error: (e as Error).message });
      throw e;
    }
  }

  private note(rec: StepRecord, call: Omit<Call, 'seq'>): void {
    rec.calls.push({ seq: ++this.seq, ...call });
  }

  private viaPage(tool: string, args: Record<string, unknown>, rec: StepRecord): void {
    this.note(rec, { via: 'page', tool, fn: tool, args, at: Date.now(), ms: 0, outcome: 'ok' });
  }

  // ---- finding ----

  private query(target: IrTarget | undefined, purpose: 'act' | 'inspect' = 'act'): LocateQuery {
    const written = target?.name ?? target?.label ?? '';
    // "Enter valid username": the field is `username`; "valid" says what is typed in.
    const name = withoutClassWords(written);
    const found = consolidate(this.o.knowledge, name, { page: target?.page });
    const one = found.status === 'one' ? found.components[0]?.component : undefined;
    const aliases = [
      ...(name !== written ? [written] : []),
      ...(one?.aliases ?? []),
      ...(one ? [one.name] : []),
      ...(found.core ? [found.core, ...(CORE_LABELS[found.core] ?? [])] : []),
    ];
    const ontology = target?.ontology && target.ontology !== 'Element' ? target.ontology : (one?.ontology ?? target?.ontology);
    return {
      name,
      aliases,
      ...(ontology ? { ontology } : {}),
      ...(one?.testId ? { testId: one.testId } : {}),
      ...(one?.xpath ? { xpath: one.xpath } : {}),
      ...(target?.within ? { within: target.within } : {}),
      purpose,
    };
  }

  private async clickXpath(xpath: string, frame: readonly string[], rec: StepRecord, label: string): Promise<void> {
    await this.tool('click', { target: selectorIn(frame, xpath), element: label }, rec);
  }

  /** Finds the one element a target means, or blocks with the reason (LC-01, LA-01). */
  private async find(target: IrTarget | undefined, rec: StepRecord, purpose: 'act' | 'inspect' = 'act'): Promise<{ element: DomElement; selector: string }> {
    let row: { row: TableRow; label: string; visited: number; frame: readonly string[] } | undefined;
    if (target?.row?.length) {
      const wanted = target.row.map((r) => {
        const v = this.valueOf(r, 'a row');
        if (v.secret) throw new Block('VALUE_UNRESOLVED', 'a secret cannot name a table row');
        return v.text;
      });
      const search = await findRow(this.page, wanted, { go: (xpath, frame) => this.clickXpath(xpath, frame, rec, 'page of the table') });
      if (search.status === 'not-found') throw new Block('ROW_NOT_FOUND', search.reason);
      if (search.status === 'ambiguous') {
        throw new Block(
          'ROW_AMBIGUOUS',
          `${search.rows.length} rows hold ${wanted.map((w) => `"${w}"`).join(' and ')} on page ${search.pageLabel}: ${search.rows.map((r) => `"${r.cells.join(' | ')}"`).join(' and ')}`,
        );
      }
      row = { row: search.row, label: search.pageLabel, visited: search.pagesVisited, frame: search.table.frame };
    }
    const seen = await inspectPageDetailed(this.page, { testIdAttribute: this.testIdAttribute, includeText: true });
    let elements = seen.elements;
    if (row) elements = elements.filter((e) => sameFrame(e.frame, row.frame) && e.xpath.startsWith(`${row.row.xpath}/`));
    const query = this.query(target, purpose);
    const result = locate(query, elements);
    const tried = result.tried;
    // A frame that could not be read is not a frame without the element: the run says so, and the case is set aside, not failed.
    const unreadNote = seen.unread.length
      ? `; a frame could not be read after the page changed (${seen.unread.map((p) => p.join(' > ')).join(', ')}), so it may be there`
      : '';
    if (result.status === 'not-found')
      throw new Block(
        'LOCATE_NOT_FOUND',
        `${result.reason}${row ? ` in the row "${row.row.cells.join(' | ')}"` : ''} (${tried.length} levels tried)${unreadNote}`,
      );
    if (result.status === 'ambiguous') throw new Block('LOCATE_AMBIGUOUS', result.reason);
    if (result.status === 'inactive') throw new Block('LOCATE_INACTIVE', result.reason);
    const selector = selectorIn(result.element.frame, result.element.xpath);
    const count = await this.page.locator(selector).count();
    if (count !== 1) throw new Block('LOCATOR_NOT_UNIQUE', `the locator for "${query.name}" finds ${count} elements, not one`);
    const home = consolidate(this.o.knowledge, query.name, { page: target?.page });
    const known = home.status === 'one' ? home.components[0] : undefined;
    // The screen an element is on: the address of its frame when the page is only a shell around it (E8), else the page's.
    const pageName = known?.page ?? target?.page ?? pageIdentityOf(result.element.frameUrl ?? this.page.url());
    rec.located = {
      name: query.name,
      level: result.level,
      weight: result.weight,
      selector,
      contract: {
        id: contractId(pageName, query.name, selector),
        page: pageName,
        ...(known ? { component: known.component.name } : {}),
        semantic: query.name,
      },
      tried,
      element: {
        tag: result.element.tag,
        role: result.element.role,
        ...(result.element.id ? { id: result.element.id } : {}),
        ...(result.element.form ? { form: result.element.form } : {}),
      },
      ignored: result.ignored.map((i) => i.reason),
      ...(row ? { row: { page: row.label, cells: row.row.cells, pagesVisited: row.visited } } : {}),
    };
    return { element: result.element, selector };
  }

  // ---- doing ----

  private async act(chain: Chain, rec: StepRecord): Promise<void> {
    const { action, target } = chain;
    switch (action) {
      case 'NAVIGATE':
        return this.navigate(chain, rec);
      case 'WAIT': {
        const ms = chain.value ? Number(chain.value) : 5000;
        const settled = await waitUntilIdle(this.page, Number.isFinite(ms) ? ms : 5000);
        if (!settled.settled) rec.notes.push(`the page was still ${settled.waitingFor.join(' and ')} after ${ms} ms`);
        return;
      }
      case 'BACK': {
        if ((await this.tool('back', {}, rec)) === 'fallback') {
          await this.page.goBack();
          this.viaPage('goBack', {}, rec);
        }
        return;
      }
      case 'FORWARD':
        await this.page.goForward();
        return this.viaPage('goForward', {}, rec);
      case 'REFRESH':
        await this.page.reload();
        return this.viaPage('reload', {}, rec);
      case 'SCROLL': {
        // "Scroll down to the Save button": the element is brought into view; without one the page is scrolled.
        if (target?.name) {
          const { selector } = await this.find(target, rec, 'inspect');
          await this.page.locator(selector).scrollIntoViewIfNeeded();
          this.viaPage('scrollIntoViewIfNeeded', { target: selector }, rec);
          return;
        }
        if ((await this.tool('wheel', { deltaX: 0, deltaY: 400 }, rec)) === 'fallback') {
          await this.page.mouse.wheel(0, 400);
          this.viaPage('mouse.wheel', { deltaY: 400 }, rec);
        }
        return;
      }
      case 'PRESS': {
        const key = this.valueOf(chain.value, 'the key').text;
        if (target) {
          const { selector } = await this.find(target, rec);
          await this.tool('click', { target: selector, element: target.name }, rec);
        }
        if ((await this.tool('pressKey', { key }, rec)) === 'fallback') {
          await this.page.keyboard.press(key);
          this.viaPage('keyboard.press', { key }, rec);
        }
        return;
      }
      case 'ENTER_VALUE':
      case 'CLEAR':
      case 'SEARCH': {
        const value = action === 'CLEAR' ? { text: '', secret: false } : this.valueOf(chain.value, `"${target?.name}"`);
        // "Leave Username blank": the test case means an empty field, and the field is emptied. A value that is empty because a secret
        // written in a step was not kept is a different thing, and stops the run.
        const key = chain.value?.startsWith('$data.') ? chain.value.slice(6) : undefined;
        const meansBlank = key !== undefined && (this.values[key]?.class === 'BLANK' || this.values[key]?.class === 'EMPTY');
        if (action === 'ENTER_VALUE' && value.text === '' && !meansBlank)
          throw new Block(
            'VALUE_UNRESOLVED',
            `the value for "${target?.name}" is empty: a password or secret written inside a step is not kept, so give it in Test Data, an environment variable or the credential store`,
          );
        const { selector } = await this.find(target ?? { ontology: 'Field', name: 'Search' }, rec);
        await this.tool('type', { target: selector, text: value.text, element: target?.name, ...(action === 'SEARCH' ? { submit: true } : {}) }, rec, {
          target: selector,
          text: value.secret ? MASK : value.text,
          element: target?.name,
        });
        // An empty field is checked, not assumed: a tool that ignores an empty text would leave what was there.
        if (value.text === '' && action !== 'SEARCH') {
          const left = await this.page
            .locator(selector)
            .inputValue({ timeout: 2000 })
            .catch(() => '');
          if (left !== '') {
            await this.page.locator(selector).fill('');
            this.viaPage('fill', { target: selector, text: '' }, rec);
            rec.notes.push('the field still held text after the empty entry, so it was emptied directly');
          }
        }
        return;
      }
      case 'SELECT':
        return this.select(chain, rec);
      case 'CHECK':
      case 'UNCHECK': {
        const { element, selector } = await this.find(target, rec);
        const want = action === 'CHECK';
        if (element.checked === want) {
          rec.notes.push(`already ${want ? 'ticked' : 'unticked'}: nothing to do`);
          return;
        }
        await this.tool('click', { target: selector, element: target?.name }, rec);
        return;
      }
      case 'UPLOAD':
        return this.upload(chain, rec);
      case 'HOVER': {
        const { selector } = await this.find(target, rec);
        if ((await this.tool('hover', { target: selector, element: target?.name }, rec)) === 'fallback') {
          await this.page.locator(selector).hover();
          this.viaPage('hover', { target: selector }, rec);
        }
        return;
      }
      case 'DRAG':
      case 'DROP':
      case 'LOGIN':
        throw new Block(
          'UNSUPPORTED_ACTION',
          `${action} is not run in this version${action === 'LOGIN' ? ': write the login as steps (enter the username, enter the password, click Login)' : ''}`,
        );
      default:
        return this.click(chain, rec);
    }
  }

  private async click(chain: Chain, rec: StepRecord): Promise<void> {
    let found: { element: DomElement; selector: string };
    try {
      found = await this.find(chain.target, rec);
    } catch (e) {
      // "Cancel the dialog": a pop-up the step before opened and dismissed is not on the page any more.
      if (this.dismissedDialog && e instanceof Block && e.code === 'LOCATE_NOT_FOUND' && (chain.action === 'CANCEL' || chain.action === 'CLOSE')) {
        rec.notes.push('the pop-up was already dismissed with the step before');
        return;
      }
      throw e;
    }
    const { element, selector } = found;
    await this.tool('click', { target: selector, element: chain.target?.name }, rec);
    // A submit button belongs to a form: the form it submits is recorded (UI-04).
    if (element.form && (element.type === 'submit' || (element.tag === 'button' && element.type === undefined))) rec.submit = { form: element.form };
  }

  private async select(chain: Chain, rec: StepRecord): Promise<void> {
    const option = this.valueOf(chain.value, `the option of "${chain.target?.name}"`).text;
    const { element, selector } = await this.find(chain.target, rec);
    if (element.tag === 'select') {
      if ((await this.tool('selectOption', { target: selector, values: [option], element: chain.target?.name }, rec)) === 'fallback') {
        await this.page.locator(selector).selectOption({ label: option });
        this.viaPage('selectOption', { target: selector, values: [option] }, rec);
      }
      return;
    }
    // A dropdown that is not a native one: open it, then choose the option by its name.
    await this.tool('click', { target: selector, element: chain.target?.name }, rec);
    await waitSettled(this.page, this.o.settle);
    const elements = await inspectPage(this.page, { testIdAttribute: this.testIdAttribute, includeText: true });
    const choice = locate({ name: option, ontology: 'Element' }, elements);
    if (choice.status !== 'found') throw new Block('LOCATE_NOT_FOUND', `the option "${option}" is not in the list that opened`);
    await this.tool('click', { target: selectorIn(choice.element.frame, choice.element.xpath), element: option }, rec);
  }

  private async upload(chain: Chain, rec: StepRecord): Promise<void> {
    const file = this.valueOf(chain.value, 'the file').text;
    if (!existsSync(file)) throw new Block('FILE_MISSING', `the file "${file}" does not exist`);
    const { element, selector } = await this.find(chain.target, rec);
    const status = this.caps.functions.fileUpload;
    if (status.status === 'fallback') {
      const input = element.tag === 'input' && element.type === 'file' ? this.page.locator(selector) : this.page.locator('input[type="file"]');
      await input.setInputFiles(file);
      this.viaPage('setInputFiles', { target: selector, file }, rec);
      return;
    }
    // The click opens the file chooser; the tool then gives it the file.
    await this.tool('click', { target: selector, element: chain.target?.name }, rec);
    try {
      await this.tool('fileUpload', { paths: [file] }, rec);
    } catch (e) {
      // The server reads only files under its allowed roots, on purpose: that is said, not worked round.
      if ((e as Error).message.includes('File access denied'))
        throw new Block(
          'FILE_NOT_ALLOWED',
          `the MCP server does not read "${file}": ${(e as Error).message.split('File access denied:')[1]?.trim() ?? 'it is outside its allowed roots'}`,
        );
      throw e;
    }
  }

  private async navigate(chain: Chain, rec: StepRecord): Promise<void> {
    const name = chain.target?.name ?? 'Application';
    const literal = chain.value && !chain.value.startsWith('$') ? chain.value : undefined;
    let url = literal ?? (name === 'Application' ? this.o.baseUrl : (this.pages[name] ?? undefined));
    if (!url && this.o.knowledge) {
      const page = this.o.knowledge.pages.find((p) => p.name === name || p.aliases.includes(name));
      if (page?.route !== undefined) url = `${this.o.knowledge.baseUrl ?? this.o.baseUrl ?? ''}${page.route}`;
    }
    if (!url) throw new Block('PAGE_UNKNOWN', `no address is known for the page "${name}": give it in the application knowledge, or open it by its address`);
    if (!url.startsWith('http')) {
      if (!this.o.baseUrl) throw new Block('PAGE_UNKNOWN', `"${url}" is a path and no base address is given`);
      url = `${this.o.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
    }
    await this.tool('navigate', { url }, rec);
  }
}

/** Runs a plan on a page through the MCP server (EX-02). */
export function executePlan(input: ExecuteInput, options: ExecuteOptions): Promise<RunTrace> {
  return new Runner(input, options).run();
}

/** The trace as text: each step, how it was found, and what it changed. */
export function renderTrace(trace: RunTrace): string {
  const lines = [`Run of ${trace.testId}: ${trace.status}${trace.stoppedAt ? ` at ${trace.stoppedAt.step}: ${trace.stoppedAt.reason}` : ''}`];
  for (const c of trace.capabilities) lines.push(`  ! ${c}`);
  for (const s of trace.steps) {
    lines.push(`  ${s.step} ${s.action} ${s.status}${s.code ? ` (${s.code})` : ''}  "${s.original}"`);
    if (s.located)
      lines.push(
        `      found by ${s.located.level} (weight ${s.located.weight}): ${s.located.selector}${s.located.row ? ` in the row "${s.located.row.cells.join(' | ')}" on page ${s.located.row.page}` : ''}`,
      );
    for (const c of s.calls) lines.push(`      ${c.via} ${c.tool} ${JSON.stringify(c.args)}`);
    for (const n of s.notes) lines.push(`      note: ${n}`);
    for (const c of s.changes) lines.push(`      ${c}`);
    if (s.reason) lines.push(`      ${s.reason}`);
  }
  return lines.join('\n');
}
