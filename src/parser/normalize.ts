/**
 * Text normaliser (FR-PA-14, M1): the noise in a test case that has nothing to do with its meaning. It runs before the
 * parser reads a step or a check, and never touches quoted text, so what a tester typed between quotes stays as typed.
 *
 *   "Enter  pwd in the txt box"      → "Enter password in the text box"
 *   "Enter <username>"               → "Enter username"
 *   "Click   the Login btn."         → "Click the Login button"
 */

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\b(?:pwd|pswd|passwd|pword)\b/gi, 'password'],
  [/\b(?:uname|usr name|usrname)\b/gi, 'username'],
  [/\bbtn\b/gi, 'button'],
  [/\b(?:txt box|txtbox|text-box|txt)\b/gi, 'text box'],
  [/\b(?:chkbox|chk box|check-box)\b/gi, 'checkbox'],
  [/\b(?:ddl|drop-down list|drop down list)\b/gi, 'dropdown'],
  [/\bradio btn\b/gi, 'radio button'],
  [/\bimg\b/gi, 'image'],
  [/\blbl\b/gi, 'label'],
  [/\bcred(?:s)?\b/gi, 'credentials'],
];

/** Quoted pieces are kept exactly: they are replaced by a marker while the rest is cleaned, then put back. */
export function normalizeText(text: string): string {
  const saved: string[] = [];
  const hold = (m: string) => `\u0007${saved.push(m) - 1}\u0007`;
  let t = text
    .replace(/"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`/g, hold)
    // Zero-width and non-breaking characters from copy and paste.
    .replace(/[​‌‍﻿]/g, '')
    .replace(/ /g, ' ')
    // Bullets and numbering that survived the split.
    .replace(/^\s*(?:[-*•●▪]|\(\d+\)|\d+[.)])\s+/, '')
    // A placeholder names data: <username>, {username}, [username]. ({{generators}} are kept.)
    .replace(/<\s*([A-Za-z][\w .-]*?)\s*>/g, '$1')
    .replace(/(?<!\{)\{\s*([A-Za-z][\w .-]*?)\s*\}(?!\})/g, '$1')
    .replace(/\[\s*([A-Za-z][\w .-]*?)\s*\]/g, '$1');
  for (const [pattern, replacement] of ABBREVIATIONS) t = t.replace(pattern, replacement);
  t = t
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:.!?])/g, '$1')
    .trim();
  return t.replace(/\u0007(\d+)\u0007/g, (_, i) => saved[Number(i)]);
}
