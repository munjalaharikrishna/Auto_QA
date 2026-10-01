import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAssertions } from '../parser/assertions.js';
import { defaultParserConfig, parseTestCase } from '../parser/index.js';
import { SPECS, specFor } from './registry.js';

const config = defaultParserConfig();

describe('validation catalogue: every example sentence is understood (VALIDATIONS.md §3)', () => {
  for (const spec of SPECS) {
    for (const example of spec.examples) {
      it(`${spec.id} ${spec.title}: "${example}"`, () => {
        const [a] = parseAssertions(example, config, true);
        assert.ok(!a.reason, `not understood: ${a.reason?.text}`);
        assert.equal(a.type, spec.type, `read as ${a.type}`);
        assert.ok(specFor(a.type), 'the type has a spec');
      });
    }
  }

  it('has a spec for every new assertion type', async () => {
    const { EXTRA_ASSERTIONS } = await import('../model/test-model.js');
    const missing = EXTRA_ASSERTIONS.filter((t) => !specFor(t));
    assert.deepEqual(missing, [], 'types in the model without a check');
  });
});

describe('what the tester wrote in the real OrangeHRM case', () => {
  it('reads "Checking the login section at middle of the page" as a layout check, not a missing action', () => {
    const m = parseTestCase(
      {
        title: 'Login layout',
        steps: '1. Open login page\n2. "Checking the login section at middle of the page"',
        expected: 'Login form is in the middle of the screen',
      },
      config,
    );
    const layout = m.assertions.filter((a) => a.type === 'centered');
    assert.equal(layout.length, 2);
    assert.ok(m.steps.every((s) => s.status === 'parsed'));
    assert.ok(layout.every((a) => a.container && a.target?.toLowerCase() === 'login' && a.options?.axis === 'x'));
    assert.deepEqual(
      m.warnings.filter((w) => w.code === 'UNPARSED'),
      [],
    );
  });
});
