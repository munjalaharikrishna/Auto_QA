/**
 * The fixed word lists behind the `abbreviation` (NM-11) and `contraction` (NM-12) patterns. A pattern finds the word;
 * these tables say what it stands for. They hold no regular expressions. Bump the pattern version when a table changes.
 */

const ABBREVIATIONS: Record<string, string> = {
  pwd: 'password',
  passwd: 'password',
  btn: 'button',
  txtbox: 'text box',
  ddl: 'dropdown',
  dropdownlist: 'dropdown',
  chkbox: 'checkbox',
  usrname: 'username',
  uname: 'username',
  msg: 'message',
  err: 'error',
  num: 'number',
  req: 'required',
  mand: 'mandatory',
  nav: 'navigation',
  lbl: 'label',
  img: 'image',
  dob: 'date of birth',
  addr: 'address',
  qty: 'quantity',
  tel: 'telephone',
  phno: 'phone number',
};

const IRREGULAR_CONTRACTIONS: Record<string, string> = {
  "can't": 'cannot',
  "won't": 'will not',
  "shan't": 'shall not',
};

const STEMS = new Set(['do', 'does', 'did', 'is', 'are', 'was', 'were', 'have', 'has', 'had', 'could', 'would', 'should', 'must', 'might', 'need']);

/** Lower case with every space removed, so `Txt  Box` and `txtbox` look the same. */
export const squash = (s: string): string => s.toLowerCase().split(/\s+/).join('');

export const expandAbbreviation = (found: string): string | undefined => ABBREVIATIONS[squash(found)];

export function expandContraction(found: string): string | undefined {
  const w = found.toLowerCase();
  const irregular = IRREGULAR_CONTRACTIONS[w];
  if (irregular) return irregular;
  const stem = w.endsWith("n't") ? w.slice(0, -3) : undefined;
  return stem !== undefined && STEMS.has(stem) ? `${stem} not` : undefined;
}
