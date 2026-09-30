import type { AssertionType } from '../model/test-model.js';
import type { ParserConfig } from './config.js';
import { cleanName, extractTarget, stripArticles, type Target } from './target.js';
import { clean, containsPhrase, findQuoted, hasProtectedQuote, looksLikeUrl, matchLeading, phraseRegex, protectQuotes, splitOutsideQuotes } from './text.js';

/**
 * Turns a check into an assertion (FR-PA-06, FR-PA-07, FR-PA-08).
 *
 *   redirected to Dashboard        → url (page "Dashboard")
 *   remains on the OTP page        → url-unchanged
 *   Error "Invalid email" is shown → text
 *   Login button is displayed      → visible
 *   Continue is disabled           → disabled
 *   Email field contains "a@b.com" → value
 *   User cannot open Personal      → url, negated
 */

export interface ParsedAssertion {
  type?: AssertionType;
  target?: string;
  alternatives: string[];
  exact?: boolean;
  roleHint?: string;
  expected?: string;
  match?: 'page' | 'url';
  negated: boolean;
  reason?: { code: string; text: string };
  warnings: Target['warnings'];
}

const PREDICATE = '(?:displayed|shown|visible|present|appears?|appeared|seen|rendered|loaded|opened|opens|displays)';

/**
 * Parses one check. A cell or step with several checks joined by "and" gives several assertions,
 * but only when every part is a full check on its own ("Terms and Conditions link is shown" stays one).
 * `bare` means the text came after "Verify"/"Observe", so a plain name is a visibility check.
 */
export function parseAssertions(text: string, config: ParserConfig, bare: boolean): ParsedAssertion[] {
  const parts = splitOutsideQuotes(text, /\s+and\s+/i);
  if (parts.length > 1) {
    const parsed = parts.map((p) => parseAssertion(p, config, false));
    if (parsed.every((p) => p.type)) return parsed;
  }
  return [parseAssertion(text, config, bare)];
}

export function parseAssertion(text: string, config: ParserConfig, bare: boolean): ParsedAssertion {
  const { lexicon } = config;
  const p = protectQuotes(clean(text));
  let s = p.text;

  const verb = matchLeading(
    s,
    lexicon.assertionVerbs.map((v) => [v, v] as [string, string]),
    true,
  );
  if (verb) {
    s = verb.rest;
    bare = true;
  }
  s = s.replace(/^that\s+/i, '');

  // "Error message: Invalid credentials": the text after the colon is taken as written, like a quote,
  // so words such as "do not" inside the message are not read as negation.
  const labelled =
    /^(?:an?\s+|the\s+)?(?:(?:error|success|warning|info|validation)\s+)?(?:message|error|text|alert|toast|notification|banner|title|heading)\s*[:=]\s*(.+)$/i.exec(
      s,
    );
  if (labelled) {
    return { type: 'text', expected: expectedText(p.restore(labelled[1])), alternatives: [], negated: false, warnings: [] };
  }

  // Negation: remove the word and remember it. Quoted text is protected, so "You cannot proceed" stays intact.
  let negated = false;
  const negations = Object.entries(lexicon.negations).sort(([a], [b]) => b.length - a.length);
  for (const [phrase, replacement] of negations) {
    const re = phraseRegex(phrase);
    if (re.test(s)) {
      s = s.replace(re, replacement);
      negated = true;
      break;
    }
  }

  s = s
    .replace(/\b(?:should|must|will|shall|can|could)\s+be\b/gi, 'is')
    .replace(/\b(?:should|must|will|shall|can|could)\s+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const subject = matchLeading(
    s,
    lexicon.subjects.map((w) => [w, w] as [string, string]),
  );
  if (subject?.rest) s = subject.rest;
  // "User able to navigate to PIM page", "User is able to open Reports": what the user can reach.
  s = s.replace(/^(?:is\s+|are\s+|be\s+)?(?:able|allowed)\s+to\s+/i, '');
  // Where on the page something is cannot be checked; the check keeps the element.
  const positionWarnings: ParsedAssertion['warnings'] = [];
  s = s.replace(POSITION, (found) => {
    positionWarnings.push({ code: 'POSITION_IGNORED', text: `"${found.trim()}" ignored: where something is on the page is not checked` });
    return '';
  });

  const result = (r: Omit<ParsedAssertion, 'negated' | 'alternatives' | 'warnings'> & Partial<ParsedAssertion>): ParsedAssertion => ({
    alternatives: [],
    ...r,
    warnings: [...positionWarnings, ...(r.warnings ?? [])],
    negated: r.negated ?? negated,
  });
  const named = (raw: string) => extractTarget(p.restore(raw), config);
  const withTarget = (type: AssertionType, raw: string, extra: Partial<ParsedAssertion> = {}): ParsedAssertion => {
    const t = named(raw);
    if (!t.target) return unparsed('NO_TARGET', 'Say which element to check.');
    return result({ type, target: t.target, alternatives: t.alternatives, exact: t.exact, roleHint: t.roleHint, warnings: t.warnings, ...extra });
  };
  const unparsed = (code: string, reasonText: string) => result({ reason: { code, text: reasonText } });
  const page = (type: AssertionType, raw?: string): ParsedAssertion => {
    if (!raw) return result({ type });
    const r = p.restore(raw).trim();
    if (looksLikeUrl(r)) return result({ type, expected: r.replace(/[.,;]+$/, ''), match: 'url' });
    const name = cleanName(r, config);
    return name.name ? result({ type, expected: name.name, match: 'page', exact: name.exact }) : result({ type });
  };
  let m: RegExpExecArray | null;

  // 1. Stays on a page.
  if ((m = /^(?:is\s+|are\s+)?(?:still\s+)?(?:remains?|remained|stays?|stayed|is kept|kept)\s+(?:still\s+)?(?:on|at|in)\s+(.+)$/i.exec(s))) {
    return /^(?:the\s+)?(?:same|current)\s+(?:page|screen)$/i.test(m[1]) ? page('url-unchanged') : page('url-unchanged', m[1]);
  }

  // 2. Goes to a page.
  if (
    (m =
      /^(?:is\s+|are\s+|gets\s+|was\s+)?(?:redirected|navigated|taken|sent|moved|brought|directed|forwarded|routed)\s+(?:back\s+)?(?:to|towards)\s+(.+)$/i.exec(
        s,
      )) ||
    (m = /^(?:lands?|landed|landing|arrives?)\s+(?:on|at)\s+(.+)$/i.exec(s)) ||
    (m = /^(?:open|opens|access|accesses|reach|reaches|visit|visits|(?:navigate|navigates|go|goes|get|gets)\s+to)\s+(.+)$/i.exec(s))
  ) {
    return page('url', m[1]);
  }
  if ((m = /^(?:the\s+)?(?:page\s+|browser\s+)?url\s+(?:is|equals|contains|matches|has)\s+(.+)$/i.exec(s))) {
    const r = p.restore(m[1]).trim();
    const q = findQuoted(r);
    return result({ type: 'url', expected: q ? q.value : r, match: 'url' });
  }

  // 3. Field value.
  if (
    (m = /^(?:the\s+)?value\s+(?:of|in)\s+(.+?)\s+(?:is|equals)\s+(.+)$/i.exec(s)) ||
    (m = /^(.+?)\s+(?:has|contains|shows|displays)\s+(?:the\s+)?value\s+(.+)$/i.exec(s)) ||
    (m = /^(.+?\b(?:field|textbox|text box|input|box))\s+(?:contains|has|shows|displays)\s+(.+)$/i.exec(s))
  ) {
    return withTarget('value', m[1], { expected: expectedText(p.restore(m[2])) });
  }
  if ((m = /^(.+?)\s+(?:is|are)\s+(?:empty|blank|cleared)$/i.exec(s))) {
    return withTarget('value', m[1], { expected: '' });
  }

  // 4. Element state.
  if (
    (m =
      /^(.+?)\s+(?:is\s+|are\s+|becomes?\s+|gets\s+|remains?\s+|stays?\s+)?(enabled|disabled|checked|unchecked|selected|ticked|unticked|greyed out|grayed out)$/i.exec(
        s,
      ))
  ) {
    const state = m[2].toLowerCase();
    if (state === 'enabled') return withTarget('enabled', m[1]);
    if (state === 'disabled' || state.endsWith('out')) return withTarget('disabled', m[1]);
    const flip = state === 'unchecked' || state === 'unticked';
    return withTarget('checked', m[1], { negated: flip !== negated });
  }

  // 5. Quoted text.
  if (hasProtectedQuote(s)) {
    const restored = p.restore(s);
    const q = findQuoted(restored)!;
    const before = stripArticles(restored.slice(0, q.start).trim());
    const after = restored.slice(q.end).trim();
    const predicate = new RegExp(`^(?:is\\s+|are\\s+)?${PREDICATE}?\\s*`, 'i');
    const afterRest = after.replace(predicate, '');

    // "'Save' button is displayed", "Observe 'Registration' page" → the quote is an element name.
    const roleOnly = afterRest.replace(new RegExp(`\\s*(?:is\\s+|are\\s+)?${PREDICATE}$`, 'i'), '').trim();
    if (!before && roleOnly && isRoleWord(roleOnly, config)) {
      return withTarget('visible', `${restored.slice(q.start, q.end)} ${roleOnly}`);
    }

    let target: string | undefined;
    const where = /^(?:in|under|below|above|near|next to|inside|within|on|beside)\s+(.+?)(?:\s+(?:is\s+|are\s+)?(?:displayed|shown|visible|appears?))?$/i.exec(
      afterRest,
    );
    const owner = /^(.+?)\s+(?:shows|displays|contains|has|reads|says|shows the text|displays the text)$/i.exec(before);
    if (where) target = where[1];
    else if (owner) target = owner[1];
    const t = target ? extractTarget(target, config) : undefined;
    return result({
      type: 'text',
      expected: q.value,
      target: t?.target,
      alternatives: t?.alternatives ?? [],
      roleHint: t?.roleHint,
      warnings: t?.warnings ?? [],
    });
  }

  // 6. Message text without quotes: "A message saying Saved is shown".
  if (
    (m =
      /\b(?:message|error|text|alert|notification|toast|banner)\s+(?:saying|stating|reading|that says|which says|with text|with the text|containing)\s+(.+?)(?:\s+(?:is\s+|are\s+)?(?:displayed|shown|visible|appears?))?$/i.exec(
        s,
      ))
  ) {
    return result({ type: 'text', expected: expectedText(p.restore(m[1])) });
  }

  // 7. Visible.
  if ((m = new RegExp(`^(.+?)\\s+(?:is\\s+|are\\s+|gets\\s+)?${PREDICATE}(?:\\s+(.*))?$`, 'i').exec(s))) {
    const r = withTarget('visible', m[1]);
    if (m[2]) r.warnings.push({ code: 'TEXT_IGNORED', text: `"${p.restore(m[2])}" after the check ignored` });
    return r;
  }
  if ((m = /^(?:see|sees|saw)\s+(.+)$/i.exec(s))) return withTarget('visible', m[1]);

  // 8. A plain name after Verify/Observe.
  const vague = containsPhrase(p.restore(s), lexicon.vagueOutcomes);
  if (bare && s && !vague && !/\b(?:is|are|was|were|has|have|gets|got|can|does|did)\b/i.test(s)) {
    return withTarget('visible', s);
  }

  if (vague) {
    return unparsed('VAGUE_CHECK', `"${vague}" cannot be checked. Say what the user sees, e.g. Error "…" is shown, or User is redirected to Dashboard.`);
  }
  return unparsed(
    'NO_PATTERN',
    'No check pattern matched. Examples: X is displayed; Error "…" is shown; User is redirected to X; User stays on X; X is disabled.',
  );
}

/** "at middle of the page", "on the top right of the screen", "on the page". */
const POSITION =
  /\s+(?:at|in|on|towards)\s+(?:the\s+)?(?:(?:top|bottom|middle|centre|center|left|right|upper|lower)(?:\s+(?:left|right))?(?:\s+(?:side|part|corner|half))?\s+of\s+(?:the\s+)?)?(?:page|screen|window)\b/i;

function isRoleWord(text: string, config: ParserConfig): boolean {
  const t = text.toLowerCase().replace(/^(?:the|a|an)\s+/, '');
  return Object.keys(config.lexicon.roleWords).includes(t);
}

/** Expected text: the quoted part if there is one, else the words as written. */
function expectedText(text: string): string {
  const q = findQuoted(text);
  return q ? q.value : clean(text);
}
