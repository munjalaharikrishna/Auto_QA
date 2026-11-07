import { nameWords } from '../knowledge/labels.js';
import type { Box } from './types.js';

/**
 * E0.17 item 2, nested containers: "the login section" is the part of the page that holds the login controls. A page seldom gives that
 * part a name of its own (OrangeHRM 2.5 lays its login box out as a table inside a table inside a table), so it is found by what it
 * holds: every word the tester used appears in it, and it holds at least two controls. When several such holders sit inside each other,
 * the innermost one is meant: it is the box a person sees around the controls. The ones around it are returned as well, because a
 * check on where "the login section" sits can mean the panel around the box (owner, 6 Nov 2026). Holders that do not sit inside each
 * other are two different parts of the page, and the engine does not choose between them.
 */

/** The elements that can hold a part of the page. A `div` counts: modern pages build their boxes from them. */
export const HOLDER_SELECTOR =
  'form, table, fieldset, section, article, aside, div, [role="form"], [role="region"], [role="group"], [role="dialog"], [role="article"]';

/** The words that say what kind of part it is, not which one: "the login section", "the login box". */
const PART_WORDS: ReadonlySet<string> = new Set([
  'section',
  'form',
  'box',
  'panel',
  'area',
  'block',
  'card',
  'container',
  'widget',
  'region',
  'part',
  'window',
  'screen',
  'page',
  'table',
  'the',
  'a',
  'an',
  'of',
]);

/** One holder of the page, as the page reader saw it. */
export interface PageHolder {
  /** The iframes it is inside, outermost first. Empty for the main page. */
  frame: string[];
  xpath: string;
  tag: string;
  /** Where it is on a picture of the whole page, with the place of its frames added. */
  box: Box;
  /** The visible controls it holds: fields, buttons, links. */
  controls: number;
  /** Of those, the fields a person types in or chooses from. */
  fields: number;
  /** What a person reads in it: its text, and the words on its buttons and fields. */
  text: string;
  /** The first line of its text: the title a section without markup shows ("Job", "Contact Details"). */
  title?: string;
}

/** The parts of the page whose title is a name (E0.17 item 1): the anchor a step "in the Job section" is done inside. */
export type AnchorResult =
  | { status: 'found'; anchor: PageHolder; why: string }
  | { status: 'ambiguous'; anchors: PageHolder[]; why: string }
  | { status: 'not-found'; why: string };

/**
 * The part of the page a section name means, by its title (E0.17 item 1). A page that marks no container still shows each section
 * under a title, and the part that starts with that title holds the section. A title that is the name wins over one that only holds it
 * ("Job" over "Job History" for "the Job section"). Of titled parts inside each other the innermost is the anchor; titled parts that are
 * not inside each other are two sections, and the engine does not choose between them.
 */
export function anchorFor(name: string, holders: readonly PageHolder[]): AnchorResult {
  const wanted = partWords(name);
  if (!wanted.length) return { status: 'not-found', why: `"${name}" does not say which part of the page it is` };
  const titled = holders.filter((h) => h.title && h.box.width > 0 && h.box.height > 0);
  const titleWords = (h: PageHolder): string[] => nameWords(h.title ?? '');
  const exact = titled.filter((h) => titleWords(h).join(' ') === wanted.join(' '));
  const holding = titled.filter((h) => {
    const t = titleWords(h);
    for (let i = 0; i + wanted.length <= t.length; i++) if (wanted.every((w, k) => t[i + k] === w)) return true;
    return false;
  });
  const pool = exact.length ? exact : holding;
  if (!pool.length) return { status: 'not-found', why: `no part of the page is titled "${wanted.join(' ')}"` };
  const innermost = pool.filter((h) => !pool.some((o) => inside(o, h)));
  if (innermost.length > 1)
    return {
      status: 'ambiguous',
      anchors: innermost,
      why: `${innermost.length} parts of the page are titled "${wanted.join(' ')}": ${innermost.map((h) => `${h.tag} at ${h.box.x},${h.box.y}`).join(' and ')}`,
    };
  const anchor = innermost[0] as PageHolder;
  return { status: 'found', anchor, why: `the part of the page titled "${anchor.title}" (${anchor.tag} at ${anchor.box.x},${anchor.box.y})` };
}

/** Which of the given elements are inside the element at an address. Runs in the page, so it is self-contained. */
export function elementsInside(args: { anchor: string; xpaths: string[] }): boolean[] {
  const at = (xpath: string): Node | null => {
    try {
      return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch {
      return null;
    }
  };
  const anchor = at(args.anchor);
  return args.xpaths.map((x) => {
    const el = at(x);
    return !!anchor && !!el && anchor !== el && anchor.contains(el);
  });
}

export type HolderResult =
  | {
      status: 'found';
      holder: PageHolder;
      /** The holders of the same words around it, nearest first: a check on where the part sits measures them too (owner, 6 Nov 2026). */
      around: PageHolder[];
      why: string;
    }
  | { status: 'ambiguous'; holders: PageHolder[]; why: string }
  | { status: 'not-found'; why: string };

/** The words of a part's name that say which part it is: "the Login section" is `login`. */
export function partWords(name: string): string[] {
  return nameWords(name).filter((w) => !PART_WORDS.has(w));
}

const inside = (inner: PageHolder, outer: PageHolder): boolean =>
  inner !== outer && inner.frame.join('>') === outer.frame.join('>') && inner.xpath.startsWith(`${outer.xpath}/`);

/** Finds the part of the page a name means (E0.17 item 2). Pure: the same holders always give the same answer. */
export function findHolder(name: string, holders: readonly PageHolder[]): HolderResult {
  const wanted = partWords(name);
  if (!wanted.length) return { status: 'not-found', why: `"${name}" does not say which part of the page it is` };
  const holds = holders.filter((h) => {
    if (h.controls < 2 || h.box.width === 0 || h.box.height === 0) return false;
    const words = new Set(nameWords(h.text));
    return wanted.every((w) => words.has(w));
  });
  if (!holds.length) return { status: 'not-found', why: `no part of the page with at least two controls holds the words "${wanted.join(' ')}"` };
  // A part with fields is the box around the fields and their buttons together, not a row of buttons inside it ("Login", "Forgot password").
  const whole = holds.filter((h) => h.fields > 0 && h.controls > h.fields);
  return innermostOf(whole.length ? whole : holds, wanted);
}

function innermostOf(holds: readonly PageHolder[], wanted: readonly string[]): HolderResult {
  // The innermost: a holder with no other holder of the words inside it. One of them, with every other around it, is the part meant.
  const innermost = holds.filter((h) => !holds.some((o) => inside(o, h)));
  if (innermost.length > 1)
    return {
      status: 'ambiguous',
      holders: innermost,
      why: `${innermost.length} separate parts of the page hold "${wanted.join(' ')}": ${innermost.map((h) => `${h.tag} at ${h.box.x},${h.box.y}`).join(' and ')}`,
    };
  const holder = innermost[0] as PageHolder;
  // Every other holder is around it; the nearest has the longest address.
  const around = holds.filter((h) => h !== holder).sort((a, b) => b.xpath.length - a.xpath.length);
  return {
    status: 'found',
    holder,
    around,
    why: around.length
      ? `the innermost of ${holds.length} nested parts that hold "${wanted.join(' ')}" (${holder.tag} at ${holder.box.x},${holder.box.y})`
      : `the one part of the page that holds "${wanted.join(' ')}" (${holder.tag} at ${holder.box.x},${holder.box.y})`,
  };
}

/** The holders of a frame that are shown and hold at least two controls. Runs in the page, so it is self-contained. */
export function readHolders(args: { selector: string; limit: number; minControls?: number }): Omit<PageHolder, 'frame'>[] {
  const CONTROLS = 'input, select, textarea, button, a[href], [role="button"], [role="link"], [role="textbox"], [role="combobox"]';
  const shown = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const xpathOf = (el: Element): string => {
    const steps: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1) {
      let n = 1;
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === node.tagName) n++;
      steps.unshift(`${node.tagName.toLowerCase()}[${n}]`);
      node = node.parentElement;
    }
    return `/${steps.join('/')}`;
  };
  const out: Omit<PageHolder, 'frame'>[] = [];
  for (const el of Array.from(document.querySelectorAll(args.selector))) {
    if (!shown(el)) continue;
    const controls = Array.from(el.querySelectorAll(CONTROLS)).filter((c) => {
      if (c.tagName === 'INPUT' && (c as HTMLInputElement).type === 'hidden') return false;
      return shown(c);
    });
    if (controls.length < (args.minControls ?? 2)) continue;
    const fields = controls.filter((c) => {
      if (c.tagName === 'SELECT' || c.tagName === 'TEXTAREA') return true;
      if (c.tagName !== 'INPUT') return ['textbox', 'combobox'].includes(c.getAttribute('role') ?? '');
      return !['submit', 'button', 'reset', 'image'].includes((c as HTMLInputElement).type);
    }).length;
    // A button input shows its value, a field its placeholder or name for assistive tools: innerText reads none of them.
    const extra = controls
      .map((c) => {
        const input = c as HTMLInputElement;
        const isButton = c.tagName === 'INPUT' && ['submit', 'button', 'reset', 'image'].includes(input.type);
        return [isButton ? input.value : '', c.getAttribute('aria-label') ?? '', c.getAttribute('placeholder') ?? '', c.getAttribute('title') ?? ''].join(' ');
      })
      .join(' ');
    const text = `${(el as HTMLElement).innerText ?? ''} ${extra}`;
    const box = el.getBoundingClientRect();
    out.push({
      xpath: xpathOf(el),
      tag: el.tagName.toLowerCase(),
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      controls: controls.length,
      fields,
      text: text.length > 600 ? text.slice(0, 600) : text,
      title: (((el as HTMLElement).innerText ?? '').split(String.fromCharCode(10)).find((l) => l.trim() !== '') ?? '').trim().slice(0, 80),
    });
    if (out.length >= args.limit) break;
  }
  return out;
}
