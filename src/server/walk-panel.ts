import type { BrowserContext } from 'playwright';

/**
 * The walkthrough's panel in the browser window itself (E0.14c): the steps on the left, what was recorded, and the buttons for the
 * question the walkthrough is waiting on (Next step, Finish, Yes or No, Save). The person can then do the whole walkthrough in the window
 * they are working in; the Auto QA page shows the same and stays usable.
 *
 * The panel lives in a closed shadow root on the page, so neither the engine's inspector nor the browser tool reads its buttons as part of
 * the application, and the recorder ignores what is done in it. It is shown only while the walkthrough waits for the person: while the
 * engine runs a step it is hidden, so it never covers an element the engine clicks or shows in a screenshot.
 */

export const PANEL_HOST_ID = '__autoqa-walk-panel';
const BINDING = '__autoQaPanel';
const UPDATE = '__autoQaPanelUpdate';

export interface PanelQuestion {
  id: number;
  kind: string;
  code?: string;
  text?: string;
  step?: string;
  original?: string;
  /** Steps of the case that were not run, which recorded steps can take the place of when saving. */
  notRun?: string[];
  recorded?: number;
}

export interface PanelState {
  caseId: string;
  steps: Array<{ step: string; original: string; status: string }>;
  /** What was recorded, with its place in the list of changes and whether the person added it as a step. */
  recorded: Array<{ sentence: string; index: number; added: boolean }>;
  note?: string;
  question?: PanelQuestion;
  /** The last word, once the walkthrough is over: saved or not. */
  ended?: { ok: boolean; message: string };
}

/** Runs in the page. Keep it self-contained: it uses nothing outside itself. */
function panelInPage(opts: { hostId: string; binding: string; update: string }): void {
  const w = window as unknown as Record<string, unknown>;
  if (window.top !== window || w[opts.update]) return;
  let state: PanelState | undefined;
  let collapsed = false;
  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;

  const call = (msg: unknown): Promise<unknown> => {
    const fn = w[opts.binding] as ((m: unknown) => Promise<unknown>) | undefined;
    return typeof fn === 'function' ? fn(msg).catch(() => undefined) : Promise.resolve(undefined);
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const STYLE = `
    :host { all: initial; }
    .panel { position: fixed; top: 0; left: 0; bottom: 0; width: 300px; z-index: 2147483647; box-sizing: border-box;
      background: #ffffff; color: #1d2433; border-right: 1px solid #c9d1de; box-shadow: 2px 0 10px rgba(0,0,0,.15);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; flex-direction: column; }
    .panel.collapsed { width: 34px; }
    .panel.collapsed .body, .panel.collapsed .title { display: none; }
    .head { display: flex; align-items: center; gap: 6px; padding: 8px; background: #1f4e8c; color: #fff; }
    .title { font-weight: 600; flex: 1; }
    .toggle { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.5); border-radius: 4px; cursor: pointer; padding: 0 6px; }
    .body { overflow: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
    h3 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5b6578; }
    ol, ul { margin: 0; padding-left: 20px; }
    li { padding: 2px 0; }
    li.current { font-weight: 600; background: #fff4d6; border-radius: 4px; }
    li.done { color: #5b6578; }
    li.blocked, li.failed { color: #b42318; }
    .mark { display: inline-block; width: 14px; }
    .ask { border: 1px solid #c9d1de; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: #f6f8fb; }
    .note { color: #8a5a00; }
    .ok { color: #067647; font-weight: 600; }
    .bad { color: #b42318; font-weight: 600; }
    button.act { font: inherit; padding: 6px 10px; border-radius: 5px; border: 1px solid #9aa6b8; background: #fff; cursor: pointer; text-align: left; }
    button.act.primary { background: #1f4e8c; color: #fff; border-color: #1f4e8c; }
    button.act.danger { color: #b42318; border-color: #e3a29b; }
    button.act:disabled { opacity: .5; cursor: default; }
    .muted { color: #5b6578; }
    ul.recorded { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    ul.recorded li { border: 1px solid #d8dee8; border-radius: 6px; padding: 6px; }
    ul.recorded li.waiting { border-color: #e8c06a; background: #fffaf0; }
    .row { display: flex; gap: 6px; margin-top: 4px; }
    .small { font-size: 12px; }
    button.act.small { padding: 2px 8px; }
  `;

  /**
   * The page is moved right by the panel's width while it is shown, so the panel covers nothing the person needs. While the engine runs a
   * step the panel is hidden and the page has its own width again, as in a run.
   */
  const makeRoom = (shown: boolean): void => {
    const html = document.documentElement;
    if (!html) return;
    if (shown) html.style.setProperty('margin-left', collapsed ? '34px' : '300px', 'important');
    else html.style.removeProperty('margin-left');
  };
  const answer = (q: PanelQuestion, a: unknown) => () => {
    // Hidden at once: the engine goes on as soon as the answer arrives, and the panel must not be in its way.
    if (host) host.style.display = 'none';
    makeRoom(false);
    void call({ type: 'answer', questionId: q.id, answer: a });
  };
  const button = (label: string, onClick: () => void, cls = ''): HTMLButtonElement => {
    const b = el('button', { type: 'button', class: `act ${cls}`.trim() }, label);
    b.addEventListener('click', onClick);
    return b;
  };
  const range = (ids: string[]): string => (ids.length > 2 ? `${ids[0]}–${ids[ids.length - 1]}` : ids.join(' and '));

  const render = (): void => {
    if (!document.documentElement) return;
    if (!host?.isConnected) {
      host = el('div', { id: opts.hostId });
      root = host.attachShadow({ mode: 'closed' });
      // For tests that act as the person: press a button of the panel by its words.
      (host as unknown as Record<string, unknown>).press = (label: string): boolean => {
        const b = [...(root?.querySelectorAll('button') ?? [])].find((x) => x.textContent?.trim() === label);
        b?.click();
        return !!b;
      };
      (host as unknown as Record<string, unknown>).text = (): string => root?.textContent ?? '';
      document.documentElement.appendChild(host);
    }
    const s = state;
    const shown = !!s && !!(s.question || s.ended);
    host.style.display = shown ? 'block' : 'none';
    makeRoom(shown);
    if (!root || !s) return;
    root.replaceChildren();
    root.appendChild(el('style', {}, STYLE));
    const panel = el('div', { class: `panel${collapsed ? ' collapsed' : ''}` });
    const head = el('div', { class: 'head' });
    head.appendChild(
      button(
        collapsed ? '»' : '«',
        () => {
          collapsed = !collapsed;
          render();
        },
        'toggle',
      ),
    );
    head.appendChild(el('span', { class: 'title' }, `Auto QA walkthrough · ${s.caseId}`));
    panel.appendChild(head);
    const body = el('div', { class: 'body' });

    const q = s.question;
    const current = q?.step;
    body.appendChild(el('h3', {}, 'Steps'));
    const ol = el('ol');
    for (const st of s.steps) {
      const cls = st.step === current ? 'current' : st.status;
      const li = el('li', { class: cls });
      const mark = st.step === current ? '▶' : st.status === 'done' ? '✓' : st.status === 'blocked' || st.status === 'failed' ? '✗' : '';
      li.appendChild(el('span', { class: 'mark' }, mark));
      li.appendChild(document.createTextNode(st.original));
      ol.appendChild(li);
    }
    body.appendChild(ol);

    const waiting = s.recorded.filter((r) => !r.added);
    body.appendChild(el('h3', {}, `Recorded (${s.recorded.length})`));
    if (s.recorded.length) {
      const ul = el('ul', { class: 'recorded' });
      for (const r of s.recorded) {
        const li = el('li', { class: r.added ? 'added' : 'waiting' });
        li.appendChild(el('div', {}, r.sentence));
        li.appendChild(el('div', { class: r.added ? 'ok small' : 'note small' }, r.added ? '\u2713 added as a step' : 'waiting for your OK'));
        const row = el('div', { class: 'row' });
        if (!r.added) row.appendChild(button('Add', () => void call({ type: 'edit', edit: { add: r.index, sentence: r.sentence } }), 'small primary'));
        row.appendChild(button('Remove', () => void call({ type: 'edit', edit: { remove: r.index, sentence: r.sentence } }), 'small danger'));
        li.appendChild(row);
        ul.appendChild(li);
      }
      body.appendChild(ul);
      if (waiting.length > 1) body.appendChild(button(`Add all (${waiting.length})`, () => void call({ type: 'edit', edit: { addAll: true } }), 'primary'));
    } else
      body.appendChild(
        el('div', { class: 'muted' }, 'Nothing yet. What you do in this window while it waits is recorded here, and you add each one as a step.'),
      );
    if (s.note) body.appendChild(el('div', { class: 'note' }, s.note));

    const ask = el('div', { class: 'ask' });
    if (s.ended) {
      ask.appendChild(el('div', { class: s.ended.ok ? 'ok' : 'bad' }, s.ended.message));
    } else if (q) {
      if (q.kind === 'step') {
        ask.appendChild(el('div', {}, `${q.step} done. Do anything more by hand here, then go on.`));
        ask.appendChild(button('Next step', answer(q, 'next'), 'primary'));
        ask.appendChild(button('Finish', answer(q, 'finish')));
      } else if (q.kind === 'choose') {
        ask.appendChild(el('div', {}, `${q.step}: ${q.original ?? ''}`));
        if (q.text) ask.appendChild(el('div', { class: 'note' }, q.text));
        ask.appendChild(el('div', { class: 'muted' }, 'Do this step yourself in the page, then press the button. Or pick the element on the Auto QA page.'));
        ask.appendChild(button('I did this step myself', answer(q, 'manual'), 'primary'));
        ask.appendChild(button('Finish', answer(q, 'finish')));
      } else if (q.kind === 'confirm' && q.code === 'SAVE_WALKTHROUGH') {
        ask.appendChild(el('div', {}, q.text ?? 'Save?'));
        const notRun = q.notRun ?? [];
        if (notRun.length && q.recorded) {
          ask.appendChild(button(`Save: recorded steps replace ${range(notRun)}`, answer(q, 'replace'), 'primary'));
          ask.appendChild(button(`Save: keep ${range(notRun)} too`, answer(q, true)));
        } else ask.appendChild(button('Save', answer(q, true), 'primary'));
        ask.appendChild(button("Don't save", answer(q, false), 'danger'));
      } else if (q.kind === 'confirm') {
        ask.appendChild(el('div', {}, q.text ?? ''));
        ask.appendChild(button('Yes', answer(q, true), 'primary'));
        ask.appendChild(button('No', answer(q, false)));
      } else ask.appendChild(el('div', { class: 'muted' }, 'Answer this on the Auto QA page.'));
    }
    body.appendChild(ask);
    panel.appendChild(body);
    root.appendChild(panel);
  };

  w[opts.update] = (next: PanelState | undefined) => {
    state = next;
    render();
  };
  const start = (): void => {
    void call({ type: 'hello' }).then((s) => {
      if (s) state = s as PanelState;
      render();
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

function panelScript(): string {
  const opts = { hostId: PANEL_HOST_ID, binding: BINDING, update: UPDATE };
  // The tools that compile this file add a helper called `__name` to the functions; the page does not have it.
  return `(() => {
  globalThis.__name = globalThis.__name || ((fn) => fn);
  (${panelInPage.toString()})(${JSON.stringify(opts)});
})();`;
}

export class WalkPanel {
  private state?: PanelState;

  private constructor(private readonly context: BrowserContext) {}

  /** Puts the panel in every page of the walkthrough's browser. `onAnswer` gets what the person pressed. */
  static async attach(
    context: BrowserContext,
    onAnswer: (questionId: number, answer: unknown) => Promise<void> | void,
    onEdit: (edit: { add: number; sentence?: string } | { addAll: true } | { remove: number; sentence?: string }) => Promise<void>,
  ): Promise<WalkPanel> {
    const panel = new WalkPanel(context);
    await context.exposeBinding(BINDING, async (source, msg: { type?: string; questionId?: unknown; answer?: unknown; edit?: unknown }) => {
      if (source.frame !== source.page.mainFrame()) return undefined;
      if (msg?.type === 'hello') return panel.state;
      if (msg?.type === 'answer' && typeof msg.questionId === 'number') await onAnswer(msg.questionId, msg.answer);
      if (msg?.type === 'edit' && msg.edit && typeof msg.edit === 'object') {
        const e = msg.edit as Record<string, unknown>;
        const sentence = typeof e.sentence === 'string' ? { sentence: e.sentence } : {};
        const edit =
          e.addAll === true
            ? ({ addAll: true } as const)
            : typeof e.add === 'number'
              ? { add: e.add, ...sentence }
              : typeof e.remove === 'number'
                ? { remove: e.remove, ...sentence }
                : undefined;
        if (edit) await onEdit(edit).catch(() => undefined);
      }
      return undefined;
    });
    const script = panelScript();
    await context.addInitScript(script);
    for (const page of context.pages()) await page.evaluate(script).catch(() => undefined);
    return panel;
  }

  /** Shows `state` in every tab; without a question or an end it is hidden. Resolves once every tab has it. */
  async show(state: PanelState | undefined): Promise<void> {
    this.state = state;
    await Promise.all(
      this.context
        .pages()
        .map((p) =>
          p.evaluate(([fn, s]) => (globalThis as unknown as Record<string, (x: unknown) => void>)[fn]?.(s), [UPDATE, state] as const).catch(() => undefined),
        ),
    );
  }
}
