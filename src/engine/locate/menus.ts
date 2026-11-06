/**
 * E0.17, left from E0.14: a link in a hover menu ("Add Employee" under PIM in OrangeHRM 2.5) is parked off the page until the pointer is
 * on its menu item, so a person moves the pointer there first. When the only candidates of a step are hidden inside such a menu, the run
 * does the same: it hovers the visible item the menu hangs from, reads the page again, and looks once more. It never clicks to open a
 * menu, and it hovers one item at most: a menu that a hover does not open stays a stop with its reason.
 */

/**
 * The visible item a hidden menu entry hangs from: the own link (or label) of the nearest list item around the entry's list item that a
 * person can see. Its address, or undefined when the entry is not in such a menu. Runs in the page, so it is self-contained.
 */
export function menuOpenerOf(args: { xpath: string }): string | undefined {
  const at = (xpath: string): Element | null => {
    try {
      return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
    } catch {
      return null;
    }
  };
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  const pathOf = (el: Element): string => {
    const steps: string[] = [];
    for (let node: Element | null = el; node && node.nodeType === 1; node = node.parentElement) {
      let n = 1;
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === node.tagName) n++;
      steps.unshift(`${node.tagName.toLowerCase()}[${n}]`);
    }
    return `/${steps.join('/')}`;
  };
  const entry = at(args.xpath);
  const own = entry?.closest('li');
  if (!entry || !own) return undefined;
  for (let p = own.parentElement; p; p = p.parentElement) {
    if (p.tagName !== 'LI') continue;
    const label = Array.from(p.children).find((c) => ['A', 'SPAN', 'BUTTON', 'DIV'].includes(c.tagName) && !c.querySelector('li'));
    if (label && shown(label)) return pathOf(label);
  }
  return undefined;
}
