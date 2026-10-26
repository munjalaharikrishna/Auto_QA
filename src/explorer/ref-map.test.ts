import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refsToMcp } from './ref-map.js';
import { flatten, parseSnapshot } from './snapshot-parser.js';

const nodes = (yaml: string) => flatten(parseSnapshot(yaml));

describe('the MCP and the page snapshot number the same elements differently', () => {
  const mcp = nodes(`
- navigation [ref=e100]:
  - button "🎓 B.Tech" [ref=e120] [cursor=pointer]
  - list [ref=e121]:
    - listitem [ref=e140] [cursor=pointer]:
      - generic [ref=e141]: EEE
    - listitem [ref=e203] [cursor=pointer]:
      - generic [ref=e204]: EEE
`);

  it('turns each page ref into the MCP ref of the same element', () => {
    const page = nodes(`
- navigation [ref=e1] [box=0,0,200,700]:
  - button "🎓 B.Tech" [ref=e43] [cursor=pointer] [box=14,116,219,46]
  - list [ref=e49]:
    - listitem [ref=e63] [cursor=pointer] [box=14,345,219,44]:
      - generic [ref=e65]: EEE
    - listitem [ref=e127] [cursor=pointer] [box=-234,389,219,44]:
      - generic [ref=e129]: EEE
`);
    const map = refsToMcp(mcp, page);
    assert.equal(map.get('e43'), 'e120');
    assert.equal(map.get('e1'), 'e100');
    assert.equal(map.get('e49'), 'e121');
  });

  it('two identical elements keep their order: the first in one is the first in the other', () => {
    const page = nodes(`
- list [ref=e49]:
  - listitem [ref=e63]:
    - generic [ref=e65]: EEE
  - listitem [ref=e127]:
    - generic [ref=e129]: EEE
`);
    const two = nodes(`
- list [ref=e121]:
  - listitem [ref=e140]:
    - generic [ref=e141]: EEE
  - listitem [ref=e203]:
    - generic [ref=e204]: EEE
`);
    const map = refsToMcp(two, page);
    assert.equal(map.get('e65'), 'e141');
    assert.equal(map.get('e129'), 'e204');
  });

  it('an element only one of them has is left out, and the rest still line up', () => {
    const page = nodes(`
- navigation [ref=e1]:
  - button "New banner" [ref=e2]
  - button "🎓 B.Tech" [ref=e43]
`);
    const map = refsToMcp(mcp, page);
    assert.equal(map.has('e2'), false, 'nothing in the MCP snapshot is called "New banner"');
    assert.equal(map.get('e43'), 'e120');
  });

  it('numbers that happen to be equal are not trusted: matching is by what the element is', () => {
    const a = nodes('- button "Save" [ref=e5]\n- button "Edit" [ref=e6]');
    const b = nodes('- button "Edit" [ref=e5]\n- button "Save" [ref=e6]');
    const map = refsToMcp(a, b);
    assert.equal(map.get('e5'), 'e6', 'page "Edit" is the MCP\'s e6, not its e5');
    assert.equal(map.get('e6'), 'e5');
  });
});
