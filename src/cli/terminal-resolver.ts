import { createInterface } from 'node:readline/promises';
import type { Resolver } from '../explorer/controller.js';
import { type Explanation, explain, sentence } from '../explorer/explain.js';
import { describe } from '../locators/match.js';

const show = (e: Explanation) => `  ${e.headline}\n  ${e.why}\n${e.todo.map((t) => `  - ${t}`).join('\n')}`;

/**
 * Asks the tester in the terminal when exploration needs a decision (D6). Without a terminal,
 * or with `unattended`, it never waits: it skips the step and declines, so the case is set aside (D22).
 */
export function terminalResolver(options: { unattended?: boolean } = {}): { resolver: Resolver; close(): void; questions: string[] } {
  const rl = process.stdin.isTTY && !options.unattended ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const questions: string[] = [];
  const resolver: Resolver = {
    async choose(r) {
      const why = explain({
        code: r.code,
        raw: r.raw,
        label: r.target,
        text: r.text,
        candidates: r.candidates.map((c) => ({ role: c.node.role, name: c.matchedName || c.node.name, score: c.score })),
      });
      questions.push(`${r.item} "${r.raw}": ${sentence(why)}`);
      console.log(`\n⚠ ${r.item} "${r.raw}"\n${show(why)}`);
      for (const [i, c] of r.candidates.slice(0, 9).entries()) console.log(`  ${i + 1}) ${describe(c)}`);
      if (!rl) return 'skip';
      const a = (await rl.question(`  Pick 1-${Math.min(9, r.candidates.length)}, s to skip, q to stop: `)).trim().toLowerCase();
      if (a === 'q') return 'abort';
      const n = Number(a);
      return Number.isInteger(n) && n >= 1 && n <= r.candidates.length ? n - 1 : 'skip';
    },
    async pageUrl(r) {
      const why = explain({ code: 'PAGE_URL', page: r.page });
      questions.push(`${r.item}: ${sentence(why)}`);
      if (!rl) {
        console.log(`\n⚠ ${r.item}\n${show(why)}`);
        return 'abort';
      }
      const a = (await rl.question(`\n? ${r.item}: URL or path of the "${r.page}" page (q to stop): `)).trim();
      return !a || a === 'q' ? 'abort' : a;
    },
    async confirm(r) {
      const why = explain({ code: r.code, text: r.text, raw: r.raw, page: r.page });
      questions.push(`${r.item}: ${sentence(why)}`);
      console.log(`\n⚠ ${r.item}\n${show(why)}`);
      if (!rl) return false;
      return /^y/i.test((await rl.question('  y/n: ')).trim());
    },
  };
  return { resolver, questions, close: () => rl?.close() };
}
