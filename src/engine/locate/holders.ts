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
export function readHolders(args: { selector: string; limit: number }): Omit<PageHolder, 'frame'>[] {
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
    if (controls.length < 2) continue;
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
    });
    if (out.length >= args.limit) break;
  }
  return out;
}
