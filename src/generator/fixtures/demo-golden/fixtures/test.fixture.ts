import { type Page, test as base, expect } from '@playwright/test';

/**
 * Shared test setup. The health check and evidence hooks are added in M6.
 */
export const test = base;
export { expect };

/** Checks the page's URL path, e.g. `/dashboard`, ignoring the host so every environment works. */
export async function expectPath(page: Page, path: string, options: { not?: boolean } = {}): Promise<void> {
  const current = () => new URL(page.url()).pathname;
  if (options.not) await expect.poll(current).not.toBe(path);
  else await expect.poll(current).toBe(path);
}

/** Values for `{{unique.email}}` and friends (FR-TD-04): new on every run. */
export function generate(name: string): string {
  const stamp = Date.now().toString(36);
  switch (name) {
    case 'unique.email':
      return `auto-qa.${stamp}@example.com`;
    case 'unique.number':
      return String(Date.now() % 1_000_000_000);
    case 'unique.text':
      return `auto-qa-${stamp}`;
    case 'today':
      return new Date().toISOString().slice(0, 10);
    default:
      throw new Error(`Unknown generator ${name}`);
  }
}
