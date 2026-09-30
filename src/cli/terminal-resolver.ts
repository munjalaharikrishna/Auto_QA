import { createInterface } from 'node:readline/promises';
import type { Resolver } from '../explorer/controller.js';
import { describe } from '../locators/match.js';

/**
 * Asks the tester in the terminal when exploration needs a decision (D6). Without a terminal,
 * or with `unattended`, it never waits: it skips the step and declines, so the case is set aside (D22).
 */
export function terminalResolver(options: { unattended?: boolean } = {}): { resolver: Resolver; close(): void; questions: string[] } {
  const rl = process.stdin.isTTY && !options.unattended ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const questions: string[] = [];
  const resolver: Resolver = {
    async choose(r) {
      questions.push(`${r.item} "${r.raw}": ${r.code}: ${r.text}`);
      console.log(`\n⚠ ${r.item} "${r.raw}"\n  ${r.code}: ${r.text}`);
      for (const [i, c] of r.candidates.slice(0, 9).entries()) console.log(`  ${i + 1}) ${describe(c)}`);
      if (!rl) return 'skip';
      const a = (await rl.question(`  Pick 1-${Math.min(9, r.candidates.length)}, s to skip, q to stop: `)).trim().toLowerCase();
      if (a === 'q') return 'abort';
      const n = Number(a);
      return Number.isInteger(n) && n >= 1 && n <= r.candidates.length ? n - 1 : 'skip';
    },
    async pageUrl(r) {
      questions.push(`${r.item}: the URL of the "${r.page}" page is not known.`);
      if (!rl) {
        console.log(`\n⚠ ${r.item}: the URL of the "${r.page}" page is not known.`);
        return 'abort';
      }
      const a = (await rl.question(`\n? ${r.item}: URL or path of the "${r.page}" page (q to stop): `)).trim();
      return !a || a === 'q' ? 'abort' : a;
    },
    async confirm(r) {
      questions.push(`${r.item} ${r.code}: ${r.text}`);
      console.log(`\n⚠ ${r.item} ${r.code}: ${r.text}`);
      if (!rl) return false;
      return /^y/i.test((await rl.question('  y/n: ')).trim());
    },
  };
  return { resolver, questions, close: () => rl?.close() };
}
