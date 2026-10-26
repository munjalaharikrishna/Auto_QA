/**
 * Scores what the new engine understood of each test case against a gold interpretation set (no browser is opened).
 *
 *   npm run engine:gold -- test/gold/bookmarket.gold.json [--draft]    exit 1 on any confident mistake
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CaseReading, GoldSetSchema, goldText, labelAgreement, readingOfLanguage, scoreGold } from '../engine/governance/index.js';
import { understandCase } from '../engine/language/index.js';
import { readWorkbook } from '../importer/workbook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) throw new Error('usage: npm run engine:gold -- <gold file> [--draft]');
const set = GoldSetSchema.parse(JSON.parse(await readFile(file, 'utf8')));

const books = new Map<string, Awaited<ReturnType<typeof readWorkbook>>>();
const readings = new Map<string, CaseReading | undefined>();
for (const c of set.cases) {
  const source = path.join(root, c.source.file);
  if (!books.has(source)) books.set(source, await readWorkbook(source));
  const raw = books.get(source)?.cases.find((x) => x.raw.id === c.id)?.raw;
  readings.set(`${c.module}/${c.id}`, raw ? readingOfLanguage(understandCase(raw)) : undefined);
}
const report = scoreGold(set, readings, { allowDraft: process.argv.includes('--draft') });
console.log(goldText(report));
if (set.cases.some((c) => c.labels)) console.log(`Agreement between labellers: ${JSON.stringify(labelAgreement(set).kappa)}`);
if (report.confidentMistakes > 0) process.exitCode = 1;
