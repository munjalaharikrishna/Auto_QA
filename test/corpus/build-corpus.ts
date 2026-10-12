/**
 * Collects the real step and expected-result sentences of the project's workbooks and examples into
 * `sentences.json`, the input of the E0.3 tokenizer golden set. Run once; the list is then fixed and reviewed:
 *   npx tsx test/corpus/build-corpus.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readWorkbook } from '../../src/importer/workbook.js';

const here = (p: string): string => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const strip = (line: string): string => {
  const m = line.match(/^\s*(?:step\s*)?\d+\s*[.):-]\s*(.*)$/i);
  return (m ? (m[1] as string) : line).trim();
};

const sentences: string[] = [];
const add = (text: string | undefined): void => {
  for (const line of (text ?? '').split(/\r?\n/)) {
    const s = strip(line);
    if (s && !sentences.includes(s)) sentences.push(s);
  }
};

for (const file of ['Add_Employee.xlsx', 'OrangeHRM_Login_Test_Cases_Updated.xlsx']) {
  const r = await readWorkbook(here(`../fixtures/${file}`));
  for (const c of r.cases) {
    add(c.raw.preconditions);
    add(c.raw.steps);
    add(c.raw.expected);
    add(c.raw.testData);
  }
}
for (const file of ['examples/test-cases.json', 'examples/demo-app/test-cases.json', 'examples/real-world/login-cases.json']) {
  for (const c of JSON.parse(readFileSync(here(`../../${file}`), 'utf8')) as Array<{ preconditions?: string; steps: string; expected?: string; testData?: string }>) {
    add(c.preconditions);
    add(c.steps);
    add(c.expected);
    add(c.testData);
  }
}
// The old parser's own test sentences: every single-line string literal that reads as a sentence.
const LITERAL = /(["'])((?:(?!\1)[^\\\n])+)\1/g;
for (const file of ['parser.test.ts', 'rules.test.ts', 'repair.test.ts']) {
  const source = readFileSync(here(`../../src/parser/${file}`), 'utf8');
  for (const m of source.matchAll(LITERAL)) {
    const s = m[2] as string;
    if (s.length >= 12 && s.includes(' ') && /^[A-Z]/.test(s) && !s.includes('${') && !s.startsWith('TC')) add(s);
  }
}
console.log(`${sentences.length} sentences`);
writeFileSync(here('sentences.json'), `${JSON.stringify(sentences, null, 2)}\n`);
