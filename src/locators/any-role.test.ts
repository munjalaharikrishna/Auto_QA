import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flatten, parseSnapshot } from '../explorer/snapshot-parser.js';
import { defaultParserConfig } from '../parser/config.js';
import { clickableByAnyRole, contentTextOf, findCandidates, type TargetQuery } from './match.js';

const config = defaultParserConfig();
const q = (kind: TargetQuery['kind'], target: string, more: Partial<TargetQuery> = {}): TargetQuery => ({ kind, target, alternatives: [], ...more });

// What the real page gives: each sidebar row is <button role="listitem"> (the app overrides the role), so the snapshot calls it a listitem.
const sidebar = parseSnapshot(`
- complementary "Course navigation" [ref=e40]:
  - button "🎓 B.Tech" [expanded] [ref=e43] [cursor=pointer] [box=14,116,219,46]:
  - list [ref=e49]:
    - listitem [ref=e50] [cursor=pointer] [box=14,169,219,44]:
      - generic [ref=e51] [box=40,180,20,20]: 📚
      - generic [ref=e52] [box=70,180,80,20]: First year
    - listitem [ref=e63] [cursor=pointer] [box=14,345,219,44]:
      - generic [ref=e64] [box=40,356,20,20]: ⚡
      - generic [ref=e65] [box=70,356,40,20]: EEE
    - listitem [ref=e66] [cursor=pointer] [box=14,389,219,44]:
      - generic [ref=e67] [box=40,400,20,20]: 📡
      - generic [ref=e68] [box=70,400,40,20]: ECE
`);

const result = (query: TargetQuery, nodes = sidebar) => findCandidates(query, nodes, config);

describe('click steps reach any element that can be clicked, whatever its role', () => {
  it('finds a <button role="listitem"> row by the text inside it, and says it is not a button', () => {
    const r = result(q('click', 'EEE', { roleHint: 'button' }));
    assert.equal(r.status, 'matched');
    if (r.status !== 'matched') return;
    assert.equal(r.best.node.ref, 'e63');
    assert.equal(r.best.how, 'exact');
    assert.ok(
      r.best.notes.some((n) => /not a button or link: it is a listitem that shows a pointer cursor/.test(n)),
      r.best.notes.join(' | '),
    );
  });

  it('a row that shows a pointer cursor scores like a control, one that does not is a little lower', () => {
    const rows = (cursor: string) =>
      parseSnapshot(`- list [ref=e1]:
  - listitem [ref=e2]${cursor}:
    - generic [ref=e3]: EEE`);
    const pointer = result(q('click', 'EEE', { roleHint: 'button' }), rows(' [cursor=pointer]'));
    const quiet = result(q('click', 'EEE', { roleHint: 'button' }), rows(''));
    assert.ok(pointer.status === 'matched' && quiet.status === 'matched');
    if (pointer.status === 'matched' && quiet.status === 'matched') {
      assert.equal(pointer.best.score, 1);
      assert.equal(quiet.best.score, 0.9);
    }
  });

  it('an extra word in the step ("the preffered EEE button") still finds the row', () => {
    const r = result(q('click', 'preffered EEE', { roleHint: 'button' }));
    assert.equal(r.status, 'matched');
    if (r.status === 'matched') assert.equal(r.best.node.ref, 'e63');
  });

  it('finds a picture by its alt text', () => {
    const nodes = parseSnapshot(`
- main [ref=e1]:
  - img "Cover of Data Structures" [ref=e227] [box=281,318,225,196]
  - img "Cover of Digital Logic Design" [ref=e265] [box=528,318,225,196]
`);
    const r = result(q('click', 'Data Structures'), nodes);
    assert.equal(r.status, 'matched');
    if (r.status === 'matched') assert.equal(r.best.node.ref, 'e227');
  });

  it('a real control still wins, and the second pass is not used', () => {
    const nodes = parseSnapshot(`
- navigation [ref=e1]:
  - button "EEE" [ref=e2] [cursor=pointer]
  - listitem [ref=e3] [cursor=pointer]:
    - generic [ref=e4]: EEE
`);
    const r = result(q('click', 'EEE'), nodes);
    assert.equal(r.status, 'matched');
    if (r.status === 'matched') {
      assert.equal(r.best.node.ref, 'e2');
      assert.equal(r.best.score, 1);
      assert.equal(r.candidates.length, 1, 'the list item was never considered');
    }
  });

  it('two equally good elements are still left to the tester', () => {
    const nodes = parseSnapshot(`
- list [ref=e1]:
  - listitem [ref=e2] [cursor=pointer]:
    - generic [ref=e3]: EEE
  - listitem [ref=e4] [cursor=pointer]:
    - generic [ref=e5]: EEE
`);
    const r = result(q('click', 'EEE'), nodes);
    assert.equal(r.status, 'needs-review');
    if (r.status === 'needs-review') assert.equal(r.code, 'AMBIGUOUS');
  });

  it('plain text is a click target only when the page shows it reacts to a click', () => {
    const quiet = parseSnapshot('- generic [ref=e1]:\n  - generic [ref=e2]: Archive');
    const pointer = parseSnapshot('- generic [ref=e1]:\n  - generic [ref=e2] [cursor=pointer]: Archive');
    assert.equal(result(q('click', 'Archive'), quiet).status, 'needs-review');
    const r = result(q('click', 'Archive'), pointer);
    assert.equal(r.status, 'matched');
    if (r.status === 'matched') assert.equal(r.best.node.ref, 'e2');
  });

  it('only click-like steps are widened: a field is still a field', () => {
    assert.equal(result(q('fill', 'EEE')).status, 'needs-review');
  });

  it('a click never lands on a form field: "Click Forgot password" is not the Password field', () => {
    const login = parseSnapshot(`
- form [ref=e1]:
  - generic [ref=e2]: Password
  - textbox "Password" [ref=e3]
  - button "Login" [ref=e4] [cursor=pointer]
`);
    assert.equal(result(q('click', 'Forgot password'), login).status, 'needs-review');
    const [field] = flatten(login).filter((n) => n.role === 'textbox');
    assert.equal(clickableByAnyRole(field), false);
  });

  it('an element that holds a control is a container around it, not the thing to click', () => {
    const nodes = parseSnapshot(`
- listitem [ref=e1] [cursor=pointer]:
  - generic [ref=e2]: Save draft
  - button "Delete" [ref=e3] [cursor=pointer]
`);
    const [row] = flatten(nodes);
    assert.equal(contentTextOf(row), undefined);
    assert.equal(result(q('click', 'Save draft'), nodes).status, 'needs-review');
  });

  it('what is offered on the picture: rows, pictures and icons, not the page around them', () => {
    const nodes = flatten(
      parseSnapshot(`
- main [ref=e1]:
  - generic [ref=e2]: Welcome
  - generic [ref=e3] [cursor=pointer]: Card
  - listitem [ref=e4]:
    - generic [ref=e5]: Row
  - img [ref=e6]
`),
    );
    const byRef = (ref: string) => nodes.find((n) => n.ref === ref) as (typeof nodes)[number];
    assert.equal(clickableByAnyRole(byRef('e1')), false, 'main');
    assert.equal(clickableByAnyRole(byRef('e2')), false, 'text without a pointer');
    assert.equal(clickableByAnyRole(byRef('e3')), true, 'a card with a pointer');
    assert.equal(clickableByAnyRole(byRef('e4')), true, 'a list row');
    assert.equal(clickableByAnyRole(byRef('e6')), true, 'a picture or icon');
  });
});
