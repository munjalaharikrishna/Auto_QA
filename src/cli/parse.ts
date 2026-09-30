/**
 * Milestone 2: parse written test cases into the Structured Test Model and show what was understood.
 *
 *   npm run parse -- examples/test-cases.json
 *   npm run parse -- examples/test-cases.json --json models.json
 *
 * Input: a JSON array (or one object) of test cases with the fields in SPEC §5
 * (id, title, type, preconditions, steps, testData, expected, requirementId, row).
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Assertion, Step, TestModel, ValueRef } from '../model/test-model.js';
import { executionOrder, parseTestCase } from '../parser/index.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--json');
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!file) {
  console.error('Usage: npm run parse -- <test-cases.json> [--json out.json]');
  process.exit(1);
}

const input: unknown = JSON.parse(await readFile(file, 'utf8'));
const cases = Array.isArray(input) ? input : [input];
const models: TestModel[] = [];
let failed = 0;

for (const [i, raw] of cases.entries()) {
  try {
    models.push(parseTestCase(raw));
  } catch (e) {
    failed++;
    console.error(`\n✖ Test case ${i + 1} could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

for (const m of models) {
  const unparsed = [...m.steps, ...m.assertions].filter((x) => x.status === 'unparsed').length;
  console.log(`\n━━ ${m.id}  ${m.title}${m.type ? `  (${m.type})` : ''}`);
  console.log(unparsed ? `   ⚠ ${unparsed} item(s) need the tester` : '   ✔ ready for exploration');

  if (m.preconditions.length) {
    console.log(
      '   Preconditions: ' +
        m.preconditions
          .map((p) => (p.kind === 'flow' ? `flow "${p.name}"` : p.kind === 'logged-in' ? `logged in${p.user ? ` as ${p.user}` : ''}` : p.kind))
          .join(', '),
    );
  }
  if (Object.keys(m.data).length) {
    console.log(
      '   Data: ' +
        Object.entries(m.data)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
    );
  }
  for (const item of executionOrder(m)) console.log('   ' + describe(item));
  for (const w of m.warnings) console.log(`   ${w.code === 'UNPARSED' ? '✖' : '⚠'} ${w.at ? `${w.at} ` : ''}${w.code}: ${w.text}`);
}

const total = models.reduce((n, m) => n + [...m.steps, ...m.assertions].filter((x) => x.status === 'unparsed').length, 0);
console.log(`\n${models.length} test case(s) parsed, ${total} item(s) need the tester${failed ? `, ${failed} could not be read` : ''}.`);

const out = flag('--json');
if (out) {
  await writeFile(out, JSON.stringify(models, null, 2) + '\n');
  console.log(`Saved ${out}`);
}
if (failed) process.exitCode = 1;

function describe(item: Step | Assertion): string {
  const mark = item.status === 'parsed' ? '✔' : '✖';
  if (item.status === 'unparsed') return `${mark} ${item.id.padEnd(4)} ${item.raw}\n          → ${item.reason?.code}: ${item.reason?.text}`;

  if ('action' in item) {
    const s = item as Step;
    const parts = [s.action!.toUpperCase().padEnd(8), s.url ?? (s.page ? `page "${s.page}"` : s.baseUrl ? 'the base URL' : ''), s.key ?? '', element(s)];
    if (s.value) parts.push(`= ${value(s.value)}`);
    return `${mark} ${s.id.padEnd(4)} ${parts.filter(Boolean).join(' ')}`;
  }
  const a = item as Assertion;
  const what =
    a.type === 'url' || a.type === 'url-unchanged'
      ? a.expected
        ? a.match === 'page'
          ? `page "${a.expected}"`
          : a.expected
        : ''
      : [element(a), a.expected !== undefined && a.type !== 'health' ? `"${a.expected}"` : ''].filter(Boolean).join(' ');
  const from = a.step ? ` (step ${a.step.slice(1)})` : '';
  return `${mark} ${a.id.padEnd(4)} EXPECT  ${a.negated ? 'NOT ' : ''}${a.type} ${what}${from}`.trimEnd();
}

function element(x: Step | Assertion): string {
  if (!x.target) return '';
  const alt = x.alternatives.length ? ` (or ${x.alternatives.map((n) => `"${n}"`).join(', ')})` : '';
  return `${x.roleHint ? `${x.roleHint} ` : ''}"${x.target}"${x.exact ? ' exact' : ''}${alt}`;
}

function value(v: ValueRef): string {
  switch (v.kind) {
    case 'literal':
      return `"${v.value}"`;
    case 'env':
      return `env ${v.name}`;
    case 'data':
      return `data ${v.key}`;
    case 'generator':
      return `{{${v.name}}}`;
  }
}
