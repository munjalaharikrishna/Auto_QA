import type { BrowserContext, Frame, Page } from 'playwright';
import { CONTAINER_SELECTOR, HEADING_SELECTOR } from '../engine/locate/containers.js';
import { framePath } from '../engine/locate/frames.js';
import { readDom } from '../engine/locate/inspector.js';
import { screenKeyOf } from '../engine/locate/page-identity.js';
import type { DomElement } from '../engine/locate/types.js';
import { PANEL_HOST_ID } from './walk-panel.js';
import type { Recorded } from './walkthrough.js';

/**
 * The walkthrough's recorder (E0.14c): while a walkthrough waits for the person, what they do in the browser window is recorded, on every
 * page and frame they reach, new tabs included. A click, a value typed, an option chosen, a box ticked, Enter or Escape, and an address
 * opened by hand. Each element is read by the engine's own inspector at the moment it is used, so it has the role, name and address the
 * engine gives it, even when the click then leaves the page. What the engine does itself is never recorded: the recorder listens only
 * between `listen` and `stop`.
 */

/** An action as the page reports it, with where it happened. */
export interface RecordedEvent extends Recorded {
  /** The element: as the engine reads it, its address (`frame|xpath`) and the screen it was on. */
  element?: { role: string; name: string; ref: string; screen: string };
}

/** What the page sends: the element as the inspector read it. */
interface PageEvent {
  kind: Recorded['kind'];
  element?: DomElement;
  value?: string;
  secret?: boolean;
  url: string;
}

/** An address typed by hand: a page change this long after the last action in the page is not that action's doing. */
const NAVIGATION_GAP_MS = 4000;
const BINDING = '__autoQaRecord';

/** The name a person sees for an element: the one the walkthrough shows on the screenshot. */
const nameOf = (e: DomElement): string => e.ariaName || e.labels[0] || e.text || e.placeholder || e.nameAttr || '';

/** Runs in the page, with the inspector's `readDom`. Keep it self-contained: it uses nothing outside itself, and no regular expressions. */
function listenInPage(
  read: (opts: { testIdAttribute: string; includeText: boolean; containerSelector: string; headingSelector: string; only?: Element[] }) => DomElement[],
  opts: { testIdAttribute: string; containerSelector: string; headingSelector: string; binding: string; panelId: string },
): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__autoQaRecorder) return;
  w.__autoQaRecorder = true;
  /** The walkthrough's own panel (E0.14c): what is done in it is answering the walkthrough, not testing the application. */
  const inPanel = (t: EventTarget | null): boolean => t instanceof Element && !!t.closest(`#${opts.panelId}`);
  const send = (ev: Record<string, unknown>): void => {
    const fn = w[opts.binding] as ((e: unknown) => Promise<unknown>) | undefined;
    if (typeof fn === 'function') fn({ ...ev, url: location.href }).catch(() => undefined);
  };
  const describe = (el: Element): DomElement | undefined =>
    read({
      testIdAttribute: opts.testIdAttribute,
      includeText: true,
      containerSelector: opts.containerSelector,
      headingSelector: opts.headingSelector,
      only: [el],
    })[0];
  const ACTS = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'treeitem'];
  const FIELDS = ['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox'];
  const TEXT_TYPES = ['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time'];
  const isText = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
    el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_TYPES.includes(((el as HTMLInputElement).getAttribute('type') ?? '').toLowerCase()));

  /** The element a click was meant for: the nearest one a person acts on, or a named one that looks clickable. */
  const target = (start: Element): { el: Element; d: DomElement } | undefined => {
    let pointer: { el: Element; d: DomElement } | undefined;
    for (let el: Element | null = start; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const d = describe(el);
      if (!d) continue;
      if (ACTS.includes(d.role) || FIELDS.includes(d.role)) return { el, d };
      if (!pointer && getComputedStyle(el).cursor === 'pointer' && (d.ariaName || d.text)) pointer = { el, d };
    }
    return pointer;
  };

  // A value is recorded once, when it is final: on change, or on Enter before the form is sent.
  const kept = new WeakMap<Element, string>();
  // When the recorder starts listening, the values in the fields are where the person starts from. What the engine typed before is
  // not theirs: its "change" event comes late, when the field loses focus (the person going to the Auto QA page is enough), and
  // would otherwise be recorded as if they had typed it.
  w.__autoQaRebase = (): void => {
    for (const el of document.querySelectorAll('input, textarea')) if (isText(el)) kept.set(el, el.value);
  };
  const fill = (el: HTMLInputElement | HTMLTextAreaElement): void => {
    if (kept.get(el) === el.value) return;
    kept.set(el, el.value);
    send({ kind: 'fill', element: describe(el), value: el.value, secret: (el.getAttribute('type') ?? '').toLowerCase() === 'password' });
  };
  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (inPanel(el)) return;
      if (el instanceof Element && isText(el) && !kept.has(el)) kept.set(el, el.value);
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const at = e.target;
      if (!(at instanceof Element) || inPanel(at)) return;
      // A click on a label is followed by the click on its control: that one is recorded.
      const label = at.closest('label') as HTMLLabelElement | null;
      if (label?.control && !label.control.contains(at)) return;
      const hit = target(at);
      if (!hit) return;
      const { el, d } = hit;
      if (FIELDS.includes(d.role) || el.tagName === 'SELECT' || el.closest('select')) return;
      const input = el.tagName === 'INPUT' ? (el as HTMLInputElement) : undefined;
      if (input?.type === 'checkbox') send({ kind: input.checked ? 'check' : 'uncheck', element: d });
      else if (input?.type === 'radio') send({ kind: 'choose', element: d });
      else send({ kind: 'click', element: d });
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!(el instanceof Element) || inPanel(el)) return;
      if (el.tagName === 'SELECT') {
        const select = el as HTMLSelectElement;
        send({ kind: 'select', element: describe(select), value: select.selectedOptions[0]?.text.trim() ?? '' });
      } else if (isText(el)) fill(el);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      const el = e.target;
      if (inPanel(el)) return;
      if (e.key === 'Enter' && el instanceof Element && isText(el) && el.tagName !== 'TEXTAREA') {
        fill(el);
        send({ kind: 'press', value: 'Enter' });
      } else if (e.key === 'Escape') send({ kind: 'press', value: 'Escape' });
    },
    true,
  );
}

/** The script every page and frame gets: the inspector, then the listeners. */
function pageScript(testIdAttribute: string): string {
  const opts = { testIdAttribute, containerSelector: CONTAINER_SELECTOR, headingSelector: HEADING_SELECTOR, binding: BINDING, panelId: PANEL_HOST_ID };
  // The tools that compile this file add a helper called `__name` to the functions; the page does not have it.
  return `(() => {
  globalThis.__name = globalThis.__name || ((fn) => fn);
  (${listenInPage.toString()})(${readDom.toString()}, ${JSON.stringify(opts)});
})();`;
}

export class Recorder {
  private into?: (event: RecordedEvent) => Promise<void> | void;
  private lastActionAt = 0;
  private readonly lastUrl = new WeakMap<Page, string>();
  /** The actions still being read, in the order they were done. */
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly onError: (e: unknown) => void,
    private readonly context?: BrowserContext,
  ) {}

  /** Puts the recorder in every page of the browser, now and later. It records nothing until `listen`. */
  static async attach(context: BrowserContext, options: { testIdAttribute?: string; onError?: (e: unknown) => void } = {}): Promise<Recorder> {
    const recorder = new Recorder(options.onError ?? (() => undefined), context);
    const script = pageScript(options.testIdAttribute ?? 'data-testid');
    await context.exposeBinding(BINDING, (source, ev: PageEvent) => recorder.fromPage(source.frame, ev));
    await context.addInitScript(script);
    const watch = (page: Page): void => {
      page.on('framenavigated', (frame) => recorder.navigated(page, frame));
    };
    for (const page of context.pages()) {
      watch(page);
      for (const frame of page.frames()) await frame.evaluate(script).catch(() => undefined);
    }
    context.on('page', watch);
    return recorder;
  }

  /** From now on, what the person does is given to `into`, in the order it was done. */
  async listen(into: (event: RecordedEvent) => Promise<void> | void): Promise<void> {
    // The values the fields hold now are not the person's doing: only what they change from here is recorded.
    const frames = this.context?.pages().flatMap((p) => p.frames()) ?? [];
    await Promise.all(
      frames.map((f) => f.evaluate(() => (globalThis as unknown as { __autoQaRebase?: () => void }).__autoQaRebase?.()).catch(() => undefined)),
    );
    this.into = into;
    this.lastActionAt = Date.now();
  }

  /** Stops listening; what was done before is still given. */
  stop(): void {
    this.into = undefined;
  }

  /** Resolves once every action done so far has been given, and `into` is done with it. */
  idle(): Promise<void> {
    return this.queue;
  }

  private later(work: () => Promise<void> | void): void {
    this.queue = this.queue.then(work).catch(this.onError);
  }

  private fromPage(frame: Frame, ev: PageEvent): void {
    const into = this.into;
    if (!into) return;
    this.lastActionAt = Date.now();
    this.later(async () => {
      let element: RecordedEvent['element'];
      if (ev.element) {
        // A frame nobody can see is not part of the page a person uses; the element keeps no frame address then.
        const frames = (await framePath(frame).catch(() => undefined)) ?? [];
        element = { role: ev.element.role, name: nameOf(ev.element), ref: `${frames.join('>')}|${ev.element.xpath}`, screen: screenKeyOf(ev.url) };
      }
      await into({
        kind: ev.kind,
        ...(element ? { element } : {}),
        ...(ev.value !== undefined ? { value: ev.value } : {}),
        ...(ev.secret ? { secret: true } : {}),
      });
    });
  }

  /** A page that changes long after the last action in it was sent there by hand: the address bar, a bookmark, Back. */
  private navigated(page: Page, frame: Frame): void {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    const before = this.lastUrl.get(page);
    this.lastUrl.set(page, url);
    const into = this.into;
    if (!into || url === before || url === 'about:blank' || Date.now() - this.lastActionAt < NAVIGATION_GAP_MS) return;
    this.lastActionAt = Date.now();
    this.later(() => into({ kind: 'navigate', value: url }));
  }
}
