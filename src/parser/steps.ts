import { type Action, ENV, type ValueRef } from '../model/test-model.js';
import { type ParsedAssertion, parseAssertions } from './assertions.js';
import { normKey, type ParserConfig, synonymsOf } from './config.js';
import { extractTarget, type Target } from './target.js';
import { type DataBinding, isSecret, lookupData, parseValue } from './test-data.js';
import { clean, containsPhrase, findQuoted, looksLikeUrl, matchLeading, protectQuotes, removePhrases, splitOutsideQuotes, unquote } from './text.js';

/**
 * One tester step → an action (FR-PA-02, FR-PA-09, FR-PA-10) or, for "Observe…"/"Verify…", checks (FR-PA-06).
 * Anything no rule matches is returned unparsed with a reason (FR-PA-11). Nothing is guessed.
 */

export interface ParsedAction {
  action?: Action;
  target?: string;
  alternatives: string[];
  exact?: boolean;
  roleHint?: string;
  value?: ValueRef;
  url?: string;
  /** navigate: the environment's BASE_URL exactly as set. */
  baseUrl?: boolean;
  page?: string;
  key?: string;
  reason?: { code: string; text: string };
  /** A secret the tester typed into the step; the caller masks it in the raw text. */
  secret?: string;
  warnings: Target['warnings'];
}

/** `note`: a line that needs no step, e.g. "Open Browser" (the browser opens by itself). */
type LineResult =
  | { kind: 'action'; action: ParsedAction }
  /** One line that holds several actions ("Enter username and password and click Login"): one step each (FR-PA-15). */
  | { kind: 'actions'; actions: ParsedAction[] }
  | { kind: 'checks'; checks: ParsedAssertion[] }
  | { kind: 'note'; text: string };

export type ParsedLine = LineResult & {
  /** Warnings about the whole line, e.g. filler words removed. */
  warnings: Target['warnings'];
};

export interface StepContext {
  config: ParserConfig;
  data: Map<string, DataBinding>;
}

type Verb = Exclude<Action, 'back' | 'forward'>;

export function parseStepLine(text: string, ctx: StepContext): ParsedLine {
  const line = removeFillers(text, ctx);
  const parsed = parseCleanLine(line.text, ctx);
  return { ...parsed, warnings: line.warnings };
}

/** "as applicable", "successfully"… are removed before anything else, but never from quoted text (FR-PA-05). */
function removeFillers(text: string, ctx: StepContext): { text: string; warnings: Target['warnings'] } {
  const p = protectQuotes(clean(text));
  const r = removePhrases(p.text, ctx.config.lexicon.fillers);
  return { text: p.restore(r.text), warnings: r.removed.map((f) => ({ code: 'FILLER_REMOVED', text: `"${f}" ignored` })) };
}

function parseCleanLine(text: string, ctx: StepContext): LineResult {
  const { lexicon } = ctx.config;
  let t = clean(text);
  // A whole step in quotes ("Checking the login section") is read without them.
  const wrapped = /^["“]([^"“”]+)["”]\.?$/.exec(t);
  if (wrapped) t = clean(wrapped[1]);
  for (let lead = leadingNoise(t, ctx); lead !== undefined; lead = leadingNoise(t, ctx)) t = lead;
  if (lexicon.browserStart.phrases.some((b) => new RegExp(`^${b.replace(/\s+/g, '\\s+')}\\b`, 'i').test(t) && !/https?:\/\//i.test(t))) {
    return { kind: 'note', text: `"${text}" needs no step: the browser opens by itself.` };
  }

  const checkVerb = matchLeading(
    t,
    lexicon.assertionVerbs.map((v) => [v, v] as [string, string]),
    true,
  );
  if (checkVerb) return { kind: 'checks', checks: parseAssertions(t, ctx.config, true) };

  const subject = matchLeading(
    t,
    lexicon.subjects.map((w) => [w, w] as [string, string]),
  );
  let body = subject?.rest || t;
  // "User should click Login", "will click", "needs to enter": the modal word is not part of the step (RW-S12).
  const modal = /^(?:should|must|will|shall|can|could|needs?\s+to|has\s+to|have\s+to)\s+(?:be\s+able\s+to\s+)?/i.exec(body);
  if (modal && matchLeading(body.slice(modal[0].length), verbPhrases(ctx), true)) body = body.slice(modal[0].length);

  // "Leave the Login Name text box blank", "Keep password empty", "Do not enter username" (RW-S02).
  const blank = leaveBlank(body, ctx);
  if (blank) return blank;

  // "The Login button is clicked", "Username is entered" (RW-S11).
  const active = passiveToActive(body);
  if (active) return parseCleanLine(active, ctx);

  const browser = (['back', 'forward'] as const).find((a) => containsPhrase(body, lexicon.browserPhrases[a]));
  if (browser) return action({ action: browser });

  const verb = matchLeading(body, verbPhrases(ctx), true);
  if (!verb) {
    const markers = [...lexicon.assertionMarkers, ...Object.keys(lexicon.negations)];
    if (containsPhrase(protectQuotes(body).text, markers)) {
      return { kind: 'checks', checks: parseAssertions(t, ctx.config, false) };
    }
    return action(unparsed('NO_ACTION', noActionAdvice(body)));
  }

  const second = secondAction(verb.rest, ctx);
  if (second && !ctx.config.lexicon.assertionVerbs.some((v) => v.toLowerCase() === second.toLowerCase())) {
    // "Enter username and click Login": two actions in one line are two steps (RW-S03).
    const clauses = splitClauses(body, ctx);
    if (clauses.length > 1) {
      const parts = clauses.map((c) => parseCleanLine(c, ctx));
      const actions = parts.flatMap((r) => (r.kind === 'action' ? [r.action] : r.kind === 'actions' ? r.actions : []));
      if (actions.length === parts.length || parts.every((r) => r.kind === 'action' || r.kind === 'actions' || r.kind === 'note'))
        return { kind: 'actions', actions };
    }
  }
  if (second) {
    const isCheck = ctx.config.lexicon.assertionVerbs.some((v) => v.toLowerCase() === second.toLowerCase());
    return action(
      unparsed(
        'MULTIPLE_ACTIONS',
        isCheck
          ? `"${second}" starts a check inside an action. Keep the action in this step and write the check on its own, saying what should be seen, e.g. Page title is "…" in the Expected Result.`
          : `"${second}" starts a second action. Write one action per step.`,
      ),
    );
  }
  const parsedVerb = parseVerb(verb.value, verb.phrase, verb.rest, ctx);
  return Array.isArray(parsedVerb) ? { kind: 'actions', actions: parsedVerb } : action(parsedVerb);
}

const SPACES = /^(?:only\s+|just\s+)?(?:some\s+|a few\s+)?(?:blank\s+|white\s*)?spaces?$|^whitespace$/i;

/** "Leave X blank", "Keep X empty", "Do not enter X", "Skip X": the field is cleared. "Both A and B" is two fields. */
function leaveBlank(body: string, ctx: StepContext): LineResult | undefined {
  const p = protectQuotes(body);
  const m =
    /^(?:leave|keep|let|make)\s+(?:both\s+|all\s+)?(?:the\s+)?(.+?)\s+(?:as\s+)?(?:blank|empty|unfilled)(?:\s+.*)?$/i.exec(p.text) ??
    /^(?:do\s+not|don't|dont|without)\s+(?:enter|entering|type|typing|fill|filling|input|provide|providing)\s+(?:in\s+)?(?:any\s+)?(?:both\s+|all\s+)?(?:the\s+)?(.+)$/i.exec(
      p.text,
    ) ??
    /^(?:skip|omit)\s+(?:both\s+|all\s+)?(?:the\s+)?(.+)$/i.exec(p.text);
  if (!m) return undefined;
  const actions = splitOutsideQuotes(p.restore(m[1]), /\s+(?:and|&)\s+|\s*,\s*/i).map((name): ParsedAction => {
    const named = name.replace(/\s+(?:fields?|text\s*boxes?|boxes|inputs?)$/i, (w) => ` ${w.trim()}`);
    const t = extractTarget(named, ctx.config);
    if (!t.target) return unparsed('NO_TARGET', 'Say which field to leave blank.');
    return { action: 'clear', target: t.target, alternatives: t.alternatives, exact: t.exact, roleHint: t.roleHint ?? 'textbox', warnings: t.warnings };
  });
  return actions.length ? { kind: 'actions', actions } : undefined;
}

const PASSIVE_VERBS: Record<string, string> = {
  clicked: 'Click',
  pressed: 'Click',
  tapped: 'Click',
  entered: 'Enter',
  typed: 'Enter',
  filled: 'Enter',
  submitted: 'Submit',
  hovered: 'Hover over',
  cleared: 'Clear',
  uploaded: 'Upload',
};

/** "The Login button is clicked" → "Click the Login button". Only for words that are clearly actions. */
function passiveToActive(body: string): string | undefined {
  const m =
    /^(.+?)\s+(?:is|are|gets|got|has been|have been)\s+(?:then\s+)?(clicked|pressed|tapped|entered|typed|filled|submitted|hovered|cleared|uploaded)(?:\s+(?:in|on|into))?$/i.exec(
      body,
    );
  return m ? `${PASSIVE_VERBS[m[2].toLowerCase()]} ${m[1]}` : undefined;
}

/** The clauses of "Enter username and click Login": each starts with an action word. */
function splitClauses(body: string, ctx: StepContext): string[] {
  const p = protectQuotes(body);
  const verbs = verbPhrases(ctx).map(([w]) => [w, w] as [string, string]);
  const cuts: number[] = [];
  for (const m of p.text.matchAll(/(?:\s+(?:and|then)\s+|\s*,\s*(?:and\s+|then\s+)?)(?:then\s+)?/gi)) {
    if (matchLeading(p.text.slice(m.index + m[0].length), verbs, true)) cuts.push(m.index, m.index + m[0].length);
  }
  if (!cuts.length) return [body];
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < cuts.length; i += 2) {
    out.push(p.restore(p.text.slice(from, cuts[i])));
    from = cuts[i + 1];
  }
  out.push(p.restore(p.text.slice(from)));
  return out.map((c) => c.trim()).filter(Boolean);
}

function parseVerb(verb: Verb, phrase: string, rest: string, ctx: StepContext): ParsedAction | ParsedAction[] {
  switch (verb) {
    case 'navigate':
      return navigate(rest, ctx);
    case 'fill':
      // "Enter url for Orange Hrm server", "Type the application URL": that is opening the application.
      if (URL_PHRASE.test(clean(rest))) return navigate(rest, ctx);
      return fill(rest, ctx);
    case 'select':
      return select(rest, ctx);
    case 'upload':
      return upload(rest, ctx);
    case 'refresh':
      return { action: 'refresh', alternatives: [], warnings: [] };
    case 'press': {
      const key = parseKey(rest, ctx);
      return key
        ? { action: 'press', key, alternatives: [], warnings: [] }
        : unparsed('UNKNOWN_KEY', `"${rest}" is not a key name, e.g. Enter, Tab, Escape, Control+A.`);
    }
    case 'click': {
      if (/^(?:press|hit)$/i.test(phrase)) {
        const key = parseKey(rest, ctx);
        if (key) return { action: 'press', key, alternatives: [], warnings: [] };
      }
      if (/^submit$/i.test(phrase) && /^(?:(?:the\s+)?form)?$/i.test(rest)) {
        return { action: 'click', target: 'Submit', roleHint: 'button', alternatives: [], warnings: [] };
      }
      return withTarget('click', rest, ctx);
    }
    default:
      return withTarget(verb, rest, ctx);
  }
}

function withTarget(verb: Action, rest: string, ctx: StepContext, extra: Partial<ParsedAction> = {}): ParsedAction {
  const t = extractTarget(rest, ctx.config);
  if (!t.target) return unparsed('NO_TARGET', `Say which element to ${verb}, using the text on the screen.`);
  return { action: verb, target: t.target, alternatives: t.alternatives, exact: t.exact, roleHint: t.roleHint, warnings: t.warnings, ...extra };
}

function navigate(rest: string, ctx: StepContext): ParsedAction {
  const r = clean(rest);
  const url = /(?:^|\s)((?:https?:\/\/|www\.)\S+)/i.exec(r)?.[1] ?? (looksLikeUrl(r) ? r.split(/\s+/)[0] : undefined);
  if (url) return { action: 'navigate', url: url.replace(/[.,;)]+$/, ''), alternatives: [], warnings: [] };

  const t = extractTarget(r, ctx.config);
  if (!t.target) return unparsed('NO_TARGET', 'Say which page or URL to open, e.g. Open Login page or Open https://….');
  // "Open the application", "Enter the URL for the HR server": the environment's BASE_URL, path included.
  if (!removePhrases(t.target, ctx.config.lexicon.appWords).text || URL_PHRASE.test(r)) {
    return { action: 'navigate', baseUrl: true, alternatives: [], warnings: t.warnings };
  }
  return { action: 'navigate', page: t.target, alternatives: t.alternatives, warnings: t.warnings };
}

/**
 *   Enter "a@b.com" in Email      Enter Email as a@b.com      Enter a@b.com into Email field
 *   Enter Email                   → Test Data key "Email" (or a synonym)
 *   Enter valid username          → env TEST_USERNAME
 */
function fill(rest: string, ctx: StepContext): ParsedAction | ParsedAction[] {
  const p = protectQuotes(rest);
  let m: RegExpExecArray | null;
  let valueText: string | undefined;
  let targetText = rest;

  if ((m = /^(\d+|\{\{[^}]+\}\})\s+(?:in|into|in to|on|for|to)\s+(.+)$/i.exec(p.text))) {
    valueText = p.restore(m[1]);
    targetText = p.restore(m[2]);
  } else if ((m = /^(.+?)\s+(?:as|with|=|:)\s*(.+)$/i.exec(p.text))) {
    targetText = p.restore(m[1]);
    valueText = p.restore(m[2]);
  } else if ((m = /^(\S*[@\d.]\S*)\s+(?:in|into)\s+(.+)$/i.exec(p.text))) {
    valueText = m[1];
    targetText = p.restore(m[2]);
  } else if ((m = /^(.+?)\s+(?:in|into|in to|inside)\s+(?:the\s+)?(.+)$/i.exec(p.text))) {
    // "Enter user name in Login Name text box": the value is named first, the field after "in".
    const field = extractTarget(p.restore(m[2]), ctx.config);
    // "Enter spaces in the Login Name text box": spaces are the value.
    if (SPACES.test(unquote(p.restore(m[1])).trim()) && field.target) {
      return {
        action: 'fill',
        target: field.target,
        alternatives: field.alternatives,
        exact: field.exact,
        roleHint: field.roleHint,
        value: { kind: 'literal', value: '   ' },
        warnings: [...field.warnings, { code: 'ASSUMED_VALUE', text: 'Spaces were entered as three spaces.' }],
      };
    }
    const named = extractTarget(p.restore(m[1]), ctx.config, { qualifiers: true });
    const bound = named.target ? bindValue(named, ctx) : undefined;
    if (bound?.value && field.target) {
      return {
        action: 'fill',
        target: field.target,
        alternatives: field.alternatives,
        exact: field.exact,
        roleHint: field.roleHint,
        value: bound.value,
        warnings: [...named.warnings, ...field.warnings, ...bound.warnings],
      };
    }
  }

  const t = extractTarget(targetText, ctx.config, { qualifiers: true });
  if (!t.target) return unparsed('NO_TARGET', 'Say which field to fill, using its label on the screen.');
  if (/\s(?:and|&)\s/.test(protectQuotes(t.target).text) && !valueText) {
    // "Enter username and password": one field after the other, each with its own value.
    const each = splitOutsideQuotes(t.target, /\s+(?:and|&)\s+|\s*,\s*/i).map((n) => fill(n, ctx));
    if (each.length > 1 && each.every((a) => !Array.isArray(a) && a.action)) return each as ParsedAction[];
    return unparsed('MULTIPLE_FIELDS', `"${t.target}" names more than one field. Write one field per step.`);
  }
  const base = { action: 'fill' as const, target: t.target, alternatives: t.alternatives, exact: t.exact, roleHint: t.roleHint, warnings: t.warnings };

  if (valueText !== undefined) {
    const vague = /^(?:(?:valid|invalid|correct|required|appropriate|proper|some|any|all)\s+)*(?:data|details|values?|info|information|credentials|input)$/i;
    if (vague.test(unquote(valueText))) {
      return unparsed('VAGUE_VALUE', `"${valueText}" is not a value. Put the value in quotes or in the Test Data column.`);
    }
    const value = parseValue(unquote(valueText));
    if (value.kind === 'literal' && isSecret(t.target, ctx.config)) {
      // Mapping it to TEST_PASSWORD could type the real password in a negative test, so ask instead.
      return {
        ...unparsed(
          'SECRET_LITERAL',
          `Don't write a ${t.target} in the step. Use "Enter ${t.target}" for the test user's value, or add a key such as "Wrong ${t.target}=…" to Test Data and write "Enter wrong ${t.target}".`,
        ),
        secret: value.value,
      };
    }
    return { ...base, value };
  }

  const bound = bindValue(t, ctx);
  return bound.value ? { ...base, value: bound.value, warnings: [...t.warnings, ...bound.warnings] } : { ...base, action: undefined, reason: bound.reason };
}

function bindValue(t: Target, ctx: StepContext): { value?: ValueRef; reason?: ParsedAction['reason']; warnings: Target['warnings'] } {
  const names = [t.target!, ...t.alternatives];
  // Order: a Test Data key with this exact name, then the test user's credentials, then a synonym key.
  const exact = lookupData(ctx.data, names, ctx.config, t.qualifier, { synonyms: false });
  if (exact) return { value: exact.ref, warnings: [] };

  const label = [t.qualifier?.word, t.target].filter(Boolean).join(' ');
  if (t.qualifier?.kind === 'negative') {
    // "Enter invalid username": any value that is not valid will do, so one is made up and the report says so (RW-S05, P2).
    return {
      value: { kind: 'generator', name: 'invalid.text' },
      warnings: [
        {
          code: 'ASSUMED_VALUE',
          text: `"${label}" was entered as a made-up value that is not valid. Add ${titleCase(label)}=… to Test Data to use a particular one.`,
        },
      ],
    };
  }
  const isGroup = (word: string) => synonymsOf(ctx.config, word).includes(normKey(t.target!));
  if (isGroup('password')) return { value: { kind: 'env', name: ENV.password }, warnings: [] };
  // "valid email" means the test user; a bare "Email" could be any address, so it needs a value.
  if (isGroup('username') && (t.qualifier || ['username', 'user name', 'userid', 'user id', 'login id'].includes(t.target!.toLowerCase()))) {
    return { value: { kind: 'env', name: ENV.username }, warnings: [] };
  }
  const synonym = lookupData(ctx.data, names, ctx.config, t.qualifier);
  if (synonym) return { value: synonym.ref, warnings: [] };
  return {
    reason: { code: 'NO_VALUE', text: `No value for "${t.target}". Add ${t.target}=… to Test Data, or write Enter "…" in ${t.target}.` },
    warnings: [],
  };
}

/** Select "India" from Country · Select Country (value from Test Data) · Select Remember me → check. */
function select(rest: string, ctx: StepContext): ParsedAction {
  const p = protectQuotes(rest);
  const m = /^(.+?)\s+(?:from|in|on|under)\s+(.+)$/i.exec(p.text);
  if (m) {
    const value = unquote(p.restore(m[1]).replace(/^(?:the\s+)?(?:option|value)\s+/i, ''));
    return withTarget('select', p.restore(m[2]), ctx, { value: parseValue(value) });
  }
  const t = extractTarget(rest, ctx.config);
  if (!t.target) return unparsed('NO_TARGET', 'Say which option to select and from which dropdown, e.g. Select "India" from Country.');
  const hit = lookupData(ctx.data, [t.target, ...t.alternatives], ctx.config);
  if (hit)
    return { action: 'select', target: t.target, alternatives: t.alternatives, exact: t.exact, roleHint: t.roleHint, value: hit.ref, warnings: t.warnings };
  if (t.roleHint === 'combobox')
    return unparsed('NO_VALUE', `Say which option to select, e.g. Select "…" from ${t.target}, or add ${t.target}=… to Test Data.`);
  // No "from": the tester is choosing a radio button or checkbox by its label.
  return { action: 'check', target: t.target, alternatives: t.alternatives, exact: t.exact, roleHint: t.roleHint, warnings: t.warnings };
}

function upload(rest: string, ctx: StepContext): ParsedAction {
  const p = protectQuotes(rest);
  const m = /^(\d+|\S+\.\w{1,5})\s+(?:to|in|into|on|for|using|via)\s+(.+)$/i.exec(p.text);
  if (m) return withTarget('upload', p.restore(m[2]), ctx, { value: { kind: 'literal', value: unquote(p.restore(m[1])) } });
  const t = extractTarget(rest, ctx.config);
  if (!t.target) return unparsed('NO_TARGET', 'Say which file to upload and where, e.g. Upload "cv.pdf" to Resume.');
  const hit = lookupData(ctx.data, [t.target, ...t.alternatives], ctx.config);
  if (!hit) return unparsed('NO_VALUE', `Say which file to upload, e.g. Upload "cv.pdf" to ${t.target}, or add ${t.target}=… to Test Data.`);
  return { action: 'upload', target: t.target, alternatives: t.alternatives, exact: t.exact, roleHint: t.roleHint, value: hit.ref, warnings: t.warnings };
}

/** "Enter", "the Tab key", "Ctrl + A" → Playwright key names. Returns undefined if any part is not a key. */
export function parseKey(text: string, ctx: StepContext): string | undefined {
  const t = unquote(
    clean(text)
      .replace(/^(?:the\s+)?/i, '')
      .replace(/\s+(?:key|button)$/i, ''),
  );
  const parts = t.split(/\s*\+\s*/).filter(Boolean);
  if (!parts.length) return undefined;
  const keys = parts.map((part) => {
    const named = ctx.config.lexicon.keys[part.toLowerCase()];
    if (named) return named;
    if (/^f(?:[1-9]|1[0-2])$/i.test(part)) return part.toUpperCase();
    // Single characters only count inside a combination ("Control+A"), not alone ("Press A" is a button).
    return parts.length > 1 && /^[a-z0-9]$/i.test(part) ? part.toUpperCase() : undefined;
  });
  return keys.every(Boolean) ? keys.join('+') : undefined;
}

function verbPhrases(ctx: StepContext): Array<[string, Verb]> {
  return Object.entries(ctx.config.lexicon.actions).flatMap(([a, list]) => list.map((p) => [p, a as Verb] as [string, Verb]));
}

/** "Enter email and click Continue": the text after "and"/"then"/"," starts with another verb. */
function secondAction(rest: string, ctx: StepContext): string | undefined {
  const p = protectQuotes(rest).text;
  const verbs: Array<[string, string]> = [
    ...verbPhrases(ctx).map(([w]) => [w, w] as [string, string]),
    ...ctx.config.lexicon.assertionVerbs.map((w) => [w, w] as [string, string]),
  ];
  for (const m of p.matchAll(/(?:\s+(?:and|then)\s+|\s*,\s*(?:and\s+|then\s+)?)(?:then\s+)?/gi)) {
    const after = p.slice(m.index + m[0].length);
    const hit = matchLeading(after, verbs, true);
    if (hit) return hit.phrase;
  }
  return undefined;
}

function leadingNoise(text: string, ctx: StepContext): string | undefined {
  const hit = matchLeading(
    text,
    ctx.config.lexicon.leadingNoise.map((w) => [w, w] as [string, string]),
  );
  return hit?.rest ? hit.rest : undefined;
}

function noActionAdvice(text: string): string {
  if (/\b(?:log\s?in|sign\s?in)\b/i.test(text)) {
    return 'No action word found. Write the login as separate steps (Enter username, Enter password, Click Login), or use a flow as a precondition.';
  }
  if (/\breach\b/i.test(text)) return 'No action word found. Name each step, or use a named flow as a precondition.';
  const q = findQuoted(text);
  return `No action word found${q ? ` before "${q.value}"` : ''}. Start the step with an action such as Open, Enter, Click, Select, Check or Verify.`;
}

/** "url", "the application URL", "URL for the HR server", "web address": the application's address. */
const URL_PHRASE =
  /^(?:the\s+)?(?:(?:application|app|site|web\s*site|portal|base|login|server|test)\s+)?(?:url|web\s+address|address)\b(?!\s*(?:field|box|text\s*box|input))/i;

function unparsed(code: string, text: string): ParsedAction {
  return { alternatives: [], warnings: [], reason: { code, text } };
}

function action(a: ParsedAction | { action: Action }): LineResult {
  return { kind: 'action', action: { alternatives: [], warnings: [], ...a } };
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}
