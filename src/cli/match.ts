/**
 * Milestone 3: find the element a written step means on a live page, and validate its locator.
 * The steps are matched against the same page; nothing is clicked or typed (that is M4).
 *
 *   npm run match -- https://www.saucedemo.com "Enter username" "Enter password" "Click the Login button"
 *   npm run match -- https://www.saucedemo.com "Click Login" --test-id-attribute data-test --all --json out.json
 *
 * --all validates every rung of the ladder instead of stopping at the first valid one.
 */
import { writeFile } from 'node:fs/promises';
import { contextOf } from '../explorer/snapshot-parser.js';
import { type LocateResult, locate } from '../locators/engine.js';
import { type Candidate, describe, type TargetQuery } from '../locators/match.js';
import { openSession } from '../locators/session.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';

const args = process.argv.slice(2);
const valueFlags = ['--test-id-attribute', '--json', '--page'];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
const [url, ...texts] = positional;

if (!url || !/^https?:\/\//.test(url) || !texts.length) {
  console.error('Usage: npm run match -- <url> "<step>" ["<step>" …] [--headed] [--test-id-attribute data-test] [--page Login] [--all] [--json file]');
  process.exit(1);
}

const config = defaultParserConfig();

/** Parses one written step with the M2 parser and keeps what the matcher needs. */
function toQuery(text: string): TargetQuery | string {
  const model = parseTestCase({ title: 'match', steps: `1. ${text}`, expected: 'Page is displayed' }, config);
  const step = model.steps[0];
  const check = model.assertions.find((a) => a.source === 'step');
  const item = step ?? check;
  if (!item || item.status === 'unparsed') return `not understood: ${item?.reason?.text ?? 'no step found'}`;
  const kind = step ? step.action : check?.type;
  if (!kind) return 'not understood';
  if (!item.target && !item.roleHint) return `a ${kind} step has no element to find`;
  return { kind, target: item.target, alternatives: item.alternatives, exact: item.exact, roleHint: item.roleHint };
}

const session = await openSession({ headless: !args.includes('--headed'), testIdAttribute: flag('--test-id-attribute') });
const results: Array<{ step: string; query?: TargetQuery; result?: LocateResult; error?: string }> = [];

try {
  await session.mcp.navigate(url);
  for (const text of texts) {
    const query = toQuery(text);
    if (typeof query === 'string') {
      results.push({ step: text, error: query });
      continue;
    }
    const result = await locate(query, session.mcp, session.probe, {
      config,
      testIdAttribute: session.testIdAttribute,
      pageHint: flag('--page'),
      allRungs: args.includes('--all'),
    });
    results.push({ step: text, query, result });
  }
} finally {
  await session.close();
}

for (const { step, query, result, error } of results) {
  console.log(`\n━━ ${step}`);
  if (error || !query || !result) {
    console.log(`   ✖ ${error}`);
    continue;
  }
  console.log(
    `   ${query.kind} ${query.roleHint ? `${query.roleHint} ` : ''}"${query.target ?? ''}"${query.alternatives.length ? ` (or ${query.alternatives.join(', ')})` : ''} on ${result.page.name}`,
  );
  for (const c of result.candidates.slice(0, 5)) console.log(`   ${candidateLine(c, result)}`);
  for (const v of result.tried)
    console.log(
      `     ${v.ok ? '✔' : '✖'} ${v.spec.strategy.padEnd(11)} ${v.code}${v.spec.source === 'mcp' ? '  (MCP)' : ''}${v.reason ? `  → ${v.reason}` : ''}`,
    );
  if (result.status === 'resolved') console.log(`   ✔ ${result.locator.code}`);
  else console.log(`   ⚠ NEEDS_REVIEW ${result.code}: ${result.text}`);
}

function candidateLine(c: Candidate, result: LocateResult): string {
  const chosen = result.status === 'resolved' && result.match === c;
  const notes = [c.how, ...c.notes].join(', ');
  return `${chosen ? '→' : ' '} ${describe(c)}  (${notes})`;
}

const jsonFile = flag('--json');
if (jsonFile) {
  const plain = results.map(({ step, query, result, error }) => ({
    step,
    query,
    error,
    result: result && {
      ...result,
      candidates: result.candidates.map(({ node, ...c }) => ({ ...c, role: node.role, name: node.name, ref: node.ref, context: contextOf(node) })),
      ...(result.status === 'resolved' ? { match: undefined } : {}),
    },
  }));
  await writeFile(jsonFile, JSON.stringify(plain, null, 2));
  console.log(`\nSaved ${jsonFile}`);
}

const unresolved = results.filter((r) => r.result?.status !== 'resolved').length;
console.log(`\n${results.length - unresolved} of ${results.length} step(s) resolved.`);
