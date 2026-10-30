/**
 * What identifies a screen when an application shows its screens in a frame (E8). OrangeHRM keeps the address of the page the same and
 * loads every screen into one frame, so the address of the page says nothing about which screen a person is on; the address of the
 * frame does. Two screens are the same screen when their address and the parameters that choose the screen are the same. A parameter
 * whose value has a digit in it names a record (`id=EMP0007`, `page=2`), not a screen, so it is left out: the list of employees is one
 * screen, whichever employee is open.
 */

/** The address as it identifies a screen: the path, and the sorted parameters that choose it. Not a full URL, and never a secret. */
export function pageIdentityOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://x');
  } catch {
    return url;
  }
  const path = parsed.pathname.length > 1 && parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
  const keep: string[] = [];
  for (const [name, value] of parsed.searchParams) {
    if (!value || ![...value].some((c) => c >= '0' && c <= '9')) keep.push(value ? `${name}=${value}` : name);
  }
  return keep.length ? `${path}?${keep.sort().join('&')}` : path;
}

/**
 * The screen a person is on (E0.14): the identity of the address that shows it (the content frame's on a shell page), and the dialog
 * that is open over it, which is a screen of its own. The same screen gives the same key in every run.
 */
export function screenKeyOf(url: string, dialog?: string): string {
  const page = pageIdentityOf(url);
  return dialog ? `${page} [dialog: ${dialog}]` : page;
}
