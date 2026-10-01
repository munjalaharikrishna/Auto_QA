/**
 * What the page shows that looks like an error (REAL-WORLD-TEST-CASES.md §5, "How learning works"). Used in two
 * places with the same rules: while exploring, to learn the text of "an appropriate error message", and while the
 * generated test runs, to check that one appears. The function is self-contained because it runs inside the browser.
 */

/** Texts of visible messages that look like errors: alerts, error/invalid classes, red text, a field's own validation message. */
export function errorMessagesInPage(): string[] {
  const found = new Set<string>();
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (t: string | null | undefined) => (t ?? '').replace(/[\s ]+/g, ' ').trim();
  const add = (text: string) => {
    if (text && text.length <= 200) found.add(text);
  };

  const marked = [
    '[role=alert]',
    '[aria-live=assertive]',
    '[class*="error" i]',
    '[class*="invalid" i]',
    '[class*="danger" i]',
    '[class*="alert" i]',
    '[class*="warning" i]',
    '[class*="fail" i]',
    '[data-test*="error" i]',
    '[data-testid*="error" i]',
    '[id*="error" i]',
    '[id*="msg" i]',
  ].join(', ');
  for (const el of document.querySelectorAll(marked)) {
    // A container that holds fields or a whole form is not a message.
    if (el.querySelector('input, select, textarea, form')) continue;
    if (visible(el)) add(clean(el.textContent));
  }

  // Red text, as old applications write their errors: <font color="red">, a red cell, a red paragraph.
  for (const el of document.querySelectorAll('font, span, div, p, td, li, label, small, strong, b, em')) {
    if (!visible(el)) continue;
    const own = clean(
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' '),
    );
    if (!own) continue;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).color);
    if (m && Number(m[1]) >= 150 && Number(m[2]) <= 90 && Number(m[3]) <= 90) add(own);
  }

  // The browser's own message for a field that is not valid.
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const field = el as HTMLInputElement;
    if (visible(el) && field.validity && !field.validity.valid) add(clean(field.validationMessage));
  }
  return [...found];
}
