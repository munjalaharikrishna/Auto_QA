import type { Precondition } from '../model/test-model.js';
import type { ParserConfig } from './config.js';
import { stripArticles } from './target.js';
import { clean, containsPhrase, splitList, unquote } from './text.js';

/**
 * Preconditions column (FR-PF-01).
 *
 *   "Unauthenticated visitor"    → fresh browser context
 *   "Logged in as admin"         → saved login state for "admin"
 *   "User is on Registration page" → flow "On Registration page" (defined in V2, FR-PF-02)
 */
export function parsePreconditions(cell: string, config: ParserConfig): Precondition[] {
  const { preconditions } = config.lexicon;
  return splitList(cell, { semicolons: true }).map((item): Precondition => {
    const raw = item;
    const text = clean(item);
    if (containsPhrase(text, preconditions.note)) return { kind: 'note', raw };
    if (containsPhrase(text, preconditions.freshContext)) return { kind: 'fresh-context', raw };

    const login = /^(?:(?:the\s+)?user\s+)?(?:is\s+|has\s+)?(?:already\s+)?(?:logged|signed)\s+in(?:\s+(?:as|with)\s+(.+))?$/i.exec(text);
    if (login) {
      const user = login[1] && unquote(stripArticles(login[1]).replace(/\s+(?:user|account|role)$/i, ''));
      return user ? { kind: 'logged-in', user, raw } : { kind: 'logged-in', raw };
    }

    const name = text.replace(/^(?:the\s+)?user\s+(?:is\s+)?/i, '');
    return { kind: 'flow', name: name.charAt(0).toUpperCase() + name.slice(1), raw };
  });
}
