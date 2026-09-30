import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Loads the parser's vocabulary from lexicon.json and synonyms.json (NFR-10).
 * The files are validated so a typo in an edited file fails with a clear message, not a wrong parse.
 */

const words = z.array(z.string().min(1));
const wordMap = z.record(z.string(), z.string());

const LexiconSchema = z.object({
  actions: z.object({
    navigate: words, fill: words, clear: words, click: words, select: words, check: words,
    uncheck: words, hover: words, upload: words, press: words, refresh: words,
  }),
  browserPhrases: z.object({ back: words, forward: words }),
  assertionVerbs: words,
  assertionMarkers: words,
  negations: wordMap,
  vagueOutcomes: words,
  fillers: words,
  bracketNoise: words,
  vague: words,
  roleWords: wordMap,
  fillQualifiers: z.object({ positive: words, negative: words }),
  keys: wordMap,
  subjects: words,
  leadingNoise: words,
  appWords: words,
  secretWords: words,
  preconditions: z.object({ freshContext: words, note: words }),
});
export type Lexicon = z.infer<typeof LexiconSchema>;

const SynonymsSchema = z.object({ groups: z.array(words) });

export interface ParserConfig {
  lexicon: Lexicon;
  /** Synonym groups, each word already normalised with `normKey`. */
  synonyms: string[][];
}

/** Lower case with everything except letters and digits removed: "E-mail Address" → "emailaddress". */
export function normKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** All words that mean the same as `word`, including itself (normalised). */
export function synonymsOf(config: ParserConfig, word: string): string[] {
  const key = normKey(word);
  const group = config.synonyms.find((g) => g.includes(key));
  return group ?? [key];
}

export function loadParserConfig(
  lexiconFile: string | URL = new URL('./lexicon.json', import.meta.url),
  synonymsFile: string | URL = new URL('./synonyms.json', import.meta.url),
): ParserConfig {
  const lexicon = readJson(lexiconFile, LexiconSchema);
  const synonyms = readJson(synonymsFile, SynonymsSchema).groups.map((g) => g.map(normKey));
  return { lexicon, synonyms };
}

let cached: ParserConfig | undefined;
export function defaultParserConfig(): ParserConfig {
  return (cached ??= loadParserConfig());
}

function readJson<T>(file: string | URL, schema: z.ZodType<T>): T {
  const data = stripComments(JSON.parse(readFileSync(file, 'utf8')));
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid parser file ${String(file)}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Keys starting with `$` (like `$comment`) are notes for people, not data. */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, stripComments(v)]),
    );
  }
  return value;
}
