import type { ParserConfig } from './config.js';
import { clean, findQuoted, looksLikeUrl, matchLeading, removePhrases, splitOutsideQuotes } from './text.js';

/**
 * Target extraction (FR-PA-03, FR-PA-04, FR-PA-05): the words that name the element.
 *
 *   "the Login button"                 → target "Login", roleHint "button"
 *   "Apply to the Network (or Apply) →" → target "Apply to the Network", alternatives ["Apply"]
 *   "'Browse Opportunities' link"      → target "Browse Opportunities", exact, roleHint "link"
 */

export interface Target {
  target?: string;
  alternatives: string[];
  exact?: boolean;
  roleHint?: string;
  /** The name is a part of the page ("login form", "login section"), found as the form or region holding it. */
  container?: boolean;
  /** fill only: "valid" or "invalid" in front of the name, used to pick the value (FR-PA-10). */
  qualifier?: { kind: 'positive' | 'negative'; word: string };
  warnings: Array<{ code: string; text: string }>;
}

export function extractTarget(text: string, config: ParserConfig, options: { qualifiers?: boolean } = {}): Target {
  const { lexicon } = config;
  const warnings: Target['warnings'] = [];
  const alternatives: string[] = [];

  let t = clean(text);
  const fillers = removePhrases(t, lexicon.fillers);
  t = fillers.text;
  for (const f of fillers.removed) warnings.push({ code: 'FILLER_REMOVED', text: `"${f}" ignored` });

  // Brackets hold either another name for the element or a note to ignore.
  t = t.replace(/\(([^()]*)\)/g, (_, inner: string) => {
    const s = inner.trim();
    const or = /^or\s+(.+)$/i.exec(s);
    if (or) alternatives.push(or[1]);
    else if (!s || isBracketNoise(s, config)) warnings.push({ code: 'BRACKET_IGNORED', text: `"(${s})" ignored` });
    else alternatives.push(s);
    return ' ';
  });
  t = clean(t);

  const names = looksLikeUrl(t) ? [t] : splitOutsideQuotes(t, /\s*\/\s*/);
  const [main, ...rest] = [...names, ...alternatives].map((n) => cleanName(n, config));

  let qualifier: Target['qualifier'];
  if (options.qualifiers && main?.name) {
    const pairs: Array<[string, 'positive' | 'negative']> = [
      ...lexicon.fillQualifiers.positive.map((w) => [w, 'positive'] as [string, 'positive']),
      ...lexicon.fillQualifiers.negative.map((w) => [w, 'negative'] as [string, 'negative']),
    ];
    const q = matchLeading(main.name, pairs);
    if (q?.rest) {
      qualifier = { kind: q.value, word: q.phrase };
      main.name = q.rest;
    }
  }

  for (const n of [main, ...rest]) warnings.push(...(n?.warnings ?? []));
  const unique = (list: string[]) => [...new Set(list.filter(Boolean))];
  const target = main?.name || undefined;
  return {
    target,
    alternatives: unique(rest.map((n) => n.name)).filter((n) => n !== target),
    exact: main?.exact || undefined,
    roleHint: main?.roleHint ?? rest.find((n) => n.roleHint)?.roleHint,
    qualifier,
    warnings,
  };
}

interface Name {
  name: string;
  exact?: boolean;
  roleHint?: string;
  warnings: Target['warnings'];
}

/** Words for a part of the page, and the ARIA role each stands for. */
const CONTAINER_WORDS: Record<string, string> = {
  form: 'form',
  section: 'region',
  panel: 'region',
  box: 'region',
  area: 'region',
  block: 'region',
  card: 'region',
  container: 'region',
  widget: 'region',
  dialog: 'dialog',
  modal: 'dialog',
  popup: 'dialog',
  'pop-up': 'dialog',
  menu: 'navigation',
  navigation: 'navigation',
  navbar: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  sidebar: 'complementary',
  table: 'table',
  list: 'list',
  grid: 'table',
};

/**
 * Names a part of the page: "the login form" → target "login", container. A name that has no
 * container word ("Logo", "Cancel button") is an ordinary element name.
 */
export function extractContainer(text: string, config: ParserConfig): Target {
  const t = stripArticles(clean(text));
  const words = t.split(/\s+/);
  const last = words.at(-1)?.toLowerCase() ?? '';
  const role = CONTAINER_WORDS[last];
  if (!role || /^["“‘'`]/.test(t) || words.length === 0) return extractTarget(text, config);
  const name = words.slice(0, -1).join(' ');
  if (!name) return { alternatives: [], roleHint: role, container: true, warnings: [] };
  const base = extractTarget(name, config);
  return { ...base, roleHint: role, container: true };
}

/** Cleans one name: quotes, articles and role words. */
export function cleanName(text: string, config: ParserConfig): Name {
  const warnings: Name['warnings'] = [];
  let t = stripArticles(clean(text));
  let exact = false;

  const q = findQuoted(t);
  let around = '';
  if (q) {
    around = `${t.slice(0, q.start)} ${t.slice(q.end)}`.trim();
    t = q.value;
    exact = true;
  }

  const roles = Object.entries(config.lexicon.roleWords);
  let roleHint: string | undefined;
  // Only a trailing role word is removed ("Login button"). A leading one is usually part of the
  // name ("Page Title", "Option A"), except next to a quoted name ("button 'Save'").
  const takeRole = (s: string, leading: boolean): string => {
    const words = s.split(/\s+/).filter(Boolean);
    for (let k = Math.min(3, words.length); k >= 1; k--) {
      const tail = words.slice(-k).join(' ').toLowerCase();
      const hit = roles.find(([w]) => w === tail);
      if (hit && (words.length > k || exact)) {
        if (hit[1]) roleHint ??= hit[1];
        return words.slice(0, -k).join(' ');
      }
      // The whole name is a role word ("the dropdown list"): keep it as the name, and still give the hint.
      if (hit?.[1]) {
        roleHint ??= hit[1];
        return s;
      }
    }
    const lead = leading ? matchLeading(s, roles) : undefined;
    if (lead) {
      if (lead.value) roleHint ??= lead.value;
      return lead.rest;
    }
    return s;
  };

  if (exact) {
    const leftover = stripArticles(takeRole(around, true));
    if (leftover) warnings.push({ code: 'TEXT_IGNORED', text: `"${leftover}" next to "${t}" ignored` });
  } else {
    t = stripArticles(takeRole(t, false));
  }
  return { name: t.trim(), exact: exact || undefined, roleHint, warnings };
}

export function stripArticles(text: string): string {
  return text.replace(/^(?:(?:the|a|an)(?:\s+|$))+/i, '').trim();
}

function isBracketNoise(text: string, config: ParserConfig): boolean {
  const s = text.toLowerCase();
  if (/^(?:e\.?g\.?|i\.?e\.?|see|note)\b/.test(s)) return true;
  return [...config.lexicon.bracketNoise, ...config.lexicon.fillers].some((w) => s === w || s.startsWith(`${w} `));
}
