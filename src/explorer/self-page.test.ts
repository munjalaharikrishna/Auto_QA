import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startDemoApp } from '../../examples/demo-app/server.js';
import type { Observation } from '../engine/execute/observe.js';
import type { IrExpectation } from '../engine/ir/schema.js';
import { evaluateExpectation } from '../engine/verdict/evaluate.js';
import { openSession } from '../locators/session.js';
import { defaultParserConfig } from '../parser/config.js';
import { parseTestCase } from '../parser/index.js';
import { explore } from './controller.js';
import { filePageStore } from './page-store.js';

/**
 * E0.18, found in the step 8 live run (BookMarket TC01): "User should navigate to Book Market Home Page" passed on the login page,
 * because the first run saved "Book Market Home = /login" from that same page, so the check proved itself (old D19). Owner, 7 Nov
 * 2026: a URL check never saves its own page in silence; a person confirms it once. An address that names the page ("/dashboard" for
 * "Dashboard") is evidence and is used as before. Addresses saved in silence open pages but prove no URL check.
 */

describe('E0.18: a URL check does not name the page it is judged on by itself', { skip: !!process.env.AUTO_QA_SKIP_BROWSER }, () => {
  let app: Awaited<ReturnType<typeof startDemoApp>>;
  let dir: string;
  before(async () => {
    app = await startDemoApp();
    dir = await mkdtemp(path.join(tmpdir(), 'auto-qa-self-page-'));
  });
  after(async () => {
    await app?.close();
  });

  const exploreWith = async (expected: string, yes: boolean) => {
    const config = defaultParserConfig();
    const model = parseTestCase({ id: 'TC-PAGE', title: 'page', steps: `1. Open ${app.url}/ui/controls`, expected }, config);
    const asked: string[] = [];
    const session = await openSession({ headless: true });
    try {
      return {
        result: await explore(model, session, {
          config,
          baseUrl: app.url,
          env: {},
          pageUrls: {},
          outDir: dir,
          resolver: {
            choose: async () => 'skip',
            pageUrl: async () => 'abort',
            confirm: async (q: { text: string }) => {
              asked.push(q.text);
              return yes;
            },
          },
        } as never),
        asked,
      };
    } finally {
      await session.close();
    }
  };

  it('nobody to confirm: nothing is learned, and the check is not made from the page it names itself', async () => {
    const { result, asked } = await exploreWith('User should navigate to Book Market Home Page', false);
    assert.ok(
      asked.some((t) => t.includes('Is this the Book Market Home page?')),
      asked.join(' | '),
    );
    assert.deepEqual(result.learnedPageUrls, {});
    assert.ok(result.items.some((i) => i.warnings.some((w) => w.includes('nobody confirmed'))));
  });

  it('a person says yes: the address is learned and marked confirmed', async () => {
    const { result } = await exploreWith('User should navigate to Book Market Home Page', true);
    assert.equal(result.learnedPageUrls['Book Market Home'], '/ui/controls');
    assert.deepEqual(result.confirmedPages, ['Book Market Home']);
  });

  it('an address that names the page is evidence: nothing is asked', async () => {
    const { asked } = await exploreWith('User should navigate to Controls page', false);
    assert.deepEqual(asked, []);
  });
});

describe('E0.18: an address learned in silence proves no URL check', () => {
  const page = (url: string): Observation => ({ url, title: 't', lines: [], elements: [], messages: [], fieldErrors: [], tabs: 1 });
  const exp: IrExpectation = {
    id: 'E1',
    clause: 'User should navigate to Book Market Home Page',
    negated: false,
    condition: { type: 'URL', target: { ontology: 'Page', name: 'Book Market Home' }, expect: 'Book Market Home', check: 'url' },
    afterStep: 'S1',
  };
  const judgeOn = (unconfirmed?: Set<string>) => {
    const at = page('https://book-market.test/login');
    const step = {
      step: 'S1',
      action: 'NAVIGATE',
      original: 'Open',
      status: 'done',
      calls: [],
      changes: [],
      dialogs: [],
      checksAfter: ['E1'],
      notes: [],
      before: at,
      after: at,
    };
    return evaluateExpectation(exp, {
      steps: [step as never],
      stepOf: new Map([['E1', 'S1']]),
      seen: [at],
      clause: '',
      pages: { 'Book Market Home': '/login' },
      ...(unconfirmed ? { unconfirmedPages: unconfirmed } : {}),
    });
  };

  it('learned in silence: not proven (and not disproven); confirmed by a person: proven', () => {
    const silent = judgeOn(new Set(['Book Market Home']));
    assert.equal(silent.result, 'unproven', silent.actual);
    assert.equal(judgeOn().result, 'proven');
  });
});

describe('E0.18: the command line keeps which pages a person confirmed', () => {
  it('a confirmed page is not unconfirmed; one saved without a person is', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'auto-qa-pages-')), 'pages.json');
    const store = filePageStore('https://book-market.test/login', file);
    await store.save({ 'Book Market Home': '/login', Dashboard: '/dashboard' }, ['Dashboard']);
    assert.deepEqual([...((await store.unconfirmed?.()) ?? [])], ['Book Market Home']);
    assert.deepEqual(await store.load(), { 'Book Market Home': '/login', Dashboard: '/dashboard' });
  });
});
