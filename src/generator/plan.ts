import type { ExplorationResult, ExploredItem } from '../explorer/controller.js';
import type { Fingerprint } from '../locators/ladder.js';
import type { Assertion, AssertionOptions, Step, TestModel, ValueRef } from '../model/test-model.js';
import { defaultParserConfig } from '../parser/config.js';
import { isSecret } from '../parser/test-data.js';
import { codeFor } from '../validations/registry.js';
import { automationId, camel, escapeRegex, kebabId, kebabPage, pageVariable, pascal, propertyName, quote, singleMethodName, unique } from './names.js';

/**
 * Generation plan (FR-GE-02, 03, 10, 11): test models + their explorations → what to write.
 * Pure and deterministic (FR-GE-06): tests are taken in id order and nothing depends on time.
 */

export interface GenerateInput {
  model: TestModel;
  exploration: ExplorationResult;
}

export interface LocatorEntry {
  locator: string;
  strategy: string;
  page: string;
  validated: boolean;
  validatedAt: string;
  fingerprint?: Fingerprint;
  alternatives: string[];
  history: never[];
}

export interface PageProperty {
  name: string;
  /** Locator code on `page`, e.g. `getByRole('button', { name: 'Login', exact: true })`. */
  code: string;
  entry: LocatorEntry;
}

export interface PageMethod {
  name: string;
  params: string[];
  body: string[];
  /** Where it came from, for the doc comment. */
  steps: string[];
}

export interface PagePlan {
  className: string;
  /** `login` for LoginPage: `locators/login.locators.json`. */
  fileBase: string;
  path: string;
  title: string;
  properties: PageProperty[];
  methods: PageMethod[];
}

export interface SpecPlan {
  file: string;
  testId: string;
  title: string;
  automationId: string;
  tags: string[];
  /** Page Objects the spec creates an instance of. */
  pages: string[];
  /** Page Objects the spec refers to, e.g. `DashboardPage.path` in a URL check: all are imported. */
  imports: string[];
  dataFile?: string;
  helpers: string[];
  steps: Array<{ label: string; lines: string[] }>;
}

/** What the platform needs to judge a run (FR-VAL-01): each test's steps and checks as the tester wrote them. */
export interface ManifestTest {
  testId: string;
  title: string;
  automationId: string;
  file: string;
  steps: Array<{ id: string; raw: string; action?: string }>;
  checks: Array<{
    id: string;
    raw: string;
    type?: string;
    expected?: string;
    target?: string;
    negated: boolean;
    options?: AssertionOptions;
    other?: string;
    learned?: string;
  }>;
  /** What was assumed or learned rather than said by the tester: shown in the result next to PASS (D30, D31). */
  assumptions?: string[];
  /** Items the parser could not read: the test's result is NEEDS REVIEW until they are fixed (FR-VAL-05). */
  unparsed: string[];
}

export interface ProjectPlan {
  pages: PagePlan[];
  tests: ManifestTest[];
  specs: SpecPlan[];
  data: Array<{ file: string; values: Record<string, string> }>;
  /** Environment variables the tests read, for `.env.example`. */
  envVars: string[];
  /** The ones holding secrets (passwords, tokens…): masked in every report (FR-EV-03). A username is not one. */
  secretVars: string[];
  baseUrl: string;
  testIdAttribute: string;
  warnings: string[];
}

const COLLECT = new Set(['fill', 'clear', 'select', 'check', 'uncheck']);
const SUBMIT = new Set(['click', 'press']);

export function planProject(inputs: GenerateInput[]): ProjectPlan {
  const sorted = [...inputs].sort((a, b) => a.model.id.localeCompare(b.model.id));
  if (!sorted.length) throw new Error('Nothing to generate.');
  for (const { model, exploration } of sorted) {
    if (exploration.status !== 'complete') {
      const open = exploration.items.filter((i) => i.status !== 'done').map((i) => `${i.id} ${i.status}`);
      throw new Error(`${model.id} is not fully explored (${exploration.status}: ${open.join(', ') || 'stopped'}). Explore it again first.`);
    }
  }

  const warnings: string[] = [];
  const pages = new Map<string, PagePlan>();
  const envVars = new Set(['BASE_URL']);
  const first = sorted[0].exploration;

  const pageFor = (name: string, exploration: ExplorationResult): PagePlan => {
    let p = pages.get(name);
    if (!p) {
      const known = exploration.pages[name];
      if (!known) throw new Error(`${exploration.testId}: no URL path is known for ${name}.`);
      // Two names for one path ("Login page", "Sign in page") are one Page Object: the first name wins.
      const samePath = [...pages.values()].find((x) => x.path === known.path);
      if (samePath) {
        warnings.push(`${exploration.testId}: ${name} is the same page as ${samePath.className} (${known.path}), so it uses ${samePath.className}.`);
        pages.set(name, samePath);
        return samePath;
      }
      p = { className: name, fileBase: kebabPage(name), path: known.path, title: known.title, properties: [], methods: [] };
      pages.set(name, p);
    }
    return p;
  };

  /** The property for an explored element, shared by every step that uses the same locator. */
  const propertyFor = (item: ExploredItem, exploration: ExplorationResult): { page: PagePlan; prop: PageProperty } => {
    const page = pageFor(item.page!.name, exploration);
    const code = item.locator!.code;
    let prop = page.properties.find((p) => p.code === code);
    if (!prop) {
      const base = propertyName(elementOf(item).role, elementOf(item).name);
      const name = unique(base, (n) => page.properties.some((p) => p.name === n) || page.methods.some((m) => m.name === n));
      prop = {
        name,
        code,
        entry: {
          locator: code,
          strategy: item.locator!.strategy,
          page: page.className,
          validated: item.locator!.validated,
          validatedAt: exploration.finishedAt,
          fingerprint: item.fingerprint,
          alternatives: (item.alternatives ?? []).map((a) => a.replace(/\s+\(MCP, after action\)$/, '')),
          history: [],
        },
      };
      page.properties.push(prop);
    }
    return { page, prop };
  };

  /** Adds a method, reusing one with the same name and body (FR-GE-11). */
  const addMethod = (page: PagePlan, method: PageMethod, testId: string): string => {
    const same = (m: PageMethod) => m.params.join() === method.params.join() && m.body.join('\n') === method.body.join('\n');
    const existing = page.methods.find((m) => m.name === method.name);
    if (existing && same(existing)) return existing.name;
    const name = unique(method.name, (n) => page.properties.some((p) => p.name === n) || page.methods.some((m) => m.name === n && !same(m)));
    const reuse = page.methods.find((m) => m.name === name);
    if (reuse) return reuse.name;
    if (name !== method.name) warnings.push(`${testId}: ${page.className}.${method.name}() already does something else, so this one is ${name}() (FR-GE-11).`);
    page.methods.push({ ...method, name });
    return name;
  };

  const specs: SpecPlan[] = [];
  const tests: ManifestTest[] = [];
  const data: ProjectPlan['data'] = [];

  for (const { model, exploration } of sorted) {
    const file = kebabId(model.id);
    // The login's own Test Data joins this test's, for a "Logged in" precondition.
    const allData = { ...exploration.setup?.data, ...model.data };
    const dataKeys = new Map(Object.keys(allData).map((k) => [k, camel(k)]));
    let usesData = false;
    const helpers = new Set<string>();
    const usedPages = new Set<string>();
    const referenced = new Set<string>();
    const pageClass = (className: string) => {
      referenced.add(className);
      return className;
    };
    const steps: SpecPlan['steps'] = [];
    const pageVar = (className: string) => {
      usedPages.add(className);
      return pageVariable(className);
    };

    const valueExpr = (ref: ValueRef): string => {
      switch (ref.kind) {
        case 'env':
          envVars.add(ref.name);
          return `process.env.${ref.name}!`;
        case 'data':
          usesData = true;
          return `data.${dataKeys.get(ref.key) ?? camel(ref.key)}`;
        case 'literal':
          return quote(ref.value);
        case 'generator':
          helpers.add('generate');
          return `generate(${quote(ref.name)})`;
      }
    };

    const stepOf = (item: ExploredItem, m: TestModel): Step | undefined => m.steps.find((s) => s.id === item.id);
    const checkOf = (item: ExploredItem): Assertion | undefined => model.assertions.find((a) => a.id === item.id);

    /** One line inside a Page Object method for one explored step. */
    const actionLine = (item: ExploredItem, step: Step, prop: PageProperty, param?: string): string => {
      const target = `this.${prop.name}`;
      switch (step.action) {
        case 'fill':
          return `await ${target}.fill(${param});`;
        case 'clear':
          return `await ${target}.clear();`;
        case 'select':
          return `await ${target}.selectOption(${param});`;
        case 'check':
          return `await ${target}.check();`;
        case 'uncheck':
          return `await ${target}.uncheck();`;
        case 'click':
          return `await ${target}.click();`;
        case 'hover':
          return `await ${target}.hover();`;
        case 'upload':
          return `await ${target}.setInputFiles(${param});`;
        case 'press':
          return `await ${target}.press(${quote(step.key ?? 'Enter')});`;
        default:
          throw new Error(`${item.id}: ${step.action} is not an element action.`);
      }
    };
    const takesValue = (step: Step) => step.action === 'fill' || step.action === 'select' || step.action === 'upload';

    type Pending = { item: ExploredItem; step: Step; page: PagePlan; prop: PageProperty };
    let buffer: Pending[] = [];

    const emitMethod = (group: Pending[], name: string) => {
      const page = group[0].page;
      const params: string[] = [];
      const args: string[] = [];
      const body = group.map((g) => {
        let param: string | undefined;
        if (takesValue(g.step)) {
          param = unique(camel(elementOf(g.item).name) || 'value', (n) => params.includes(n));
          params.push(param);
          args.push(valueExpr(g.step.value!));
        }
        return actionLine(g.item, g.step, g.prop, param);
      });
      const method = addMethod(page, { name, params, body, steps: group.map((g) => `${g.item.id} ${g.item.raw}`) }, model.id);
      const label = `${group.map((g) => g.item.id).join(', ')}: ${group.map((g) => g.item.raw).join('; ')}`;
      steps.push({ label: `${prefix(group[0].item)}${label}`, lines: [`await ${pageVar(page.className)}.${method}(${args.join(', ')});`] });
    };
    const flushSingles = () => {
      for (const g of buffer) emitMethod([g], singleMethodName(g.step.action!, elementOf(g.item).role, elementOf(g.item).name));
      buffer = [];
    };
    const prefix = (item: ExploredItem) => (item.phase === 'setup' ? 'Precondition · ' : '');

    const run = (items: ExploredItem[], m: TestModel) => {
      for (const item of items) {
        if (item.kind === 'check') {
          flushSingles();
          const lines = checkLines(item, checkOf(item)!);
          if (lines.length) steps.push({ label: `${item.id}: ${item.raw}`, lines });
          continue;
        }
        const step = stepOf(item, m);
        if (!step?.action) throw new Error(`${model.id} ${item.id}: no parsed step for this exploration item.`);

        if (!item.locator) {
          flushSingles();
          steps.push({ label: `${prefix(item)}${item.id}: ${item.raw}`, lines: pageLines(item, step, exploration) });
          continue;
        }
        const { page, prop } = propertyFor(item, exploration);
        const pending = { item, step, page, prop };
        if (COLLECT.has(step.action)) {
          if (buffer.length && buffer[0].page !== page) flushSingles();
          buffer.push(pending);
        } else if (SUBMIT.has(step.action) && buffer.length && buffer[0].page === page) {
          // Rule 1: fields filled on one page and the click that submits them are one method.
          const group = [...buffer, pending];
          buffer = [];
          emitMethod(group, camel(elementOf(item).name) || singleMethodName(step.action, elementOf(item).role, ''));
        } else {
          flushSingles();
          buffer = [pending];
          flushSingles();
        }
      }
      flushSingles();
    };

    /** Navigation and browser steps, written in the spec itself. */
    function pageLines(item: ExploredItem, step: Step, ex: ExplorationResult): string[] {
      switch (step.action) {
        case 'navigate': {
          const name = step.page ? pageNameFor(step.page, ex) : pageByUrl(step.baseUrl ? ex.baseUrl : (step.url ?? ''), ex);
          if (name) return [`await ${pageVar(pageFor(name, ex).className)}.goto();`];
          return [`await page.goto(${quote(step.baseUrl ? pathOf(ex.baseUrl) : (step.url ?? ''))});`];
        }
        case 'back':
          return ['await page.goBack();'];
        case 'forward':
          return ['await page.goForward();'];
        case 'refresh':
          return ['await page.reload();'];
        case 'press':
          return [`await page.keyboard.press(${quote(step.key ?? 'Enter')});`];
        default:
          throw new Error(`${model.id} ${item.id}: ${step.action} has no locator.`);
      }
    }

    function checkLines(item: ExploredItem, a: Assertion): string[] {
      const not = a.negated ? 'not.' : '';
      const target = () => {
        const { page, prop } = propertyFor(item, exploration);
        return `${pageVar(page.className)}.${prop.name}`;
      };
      switch (a.type) {
        case 'url':
          if (a.match === 'page' && a.expected) {
            helpers.add('expectPath');
            const name = pageNameFor(a.expected, exploration);
            if (!name) throw new Error(`${model.id} ${item.id}: no path is known for the ${a.expected} page.`);
            return [`await expectPath(page, ${pageClass(pageFor(name, exploration).className)}.path${a.negated ? ', { not: true }' : ''});`];
          }
          return [`await expect(page).${not}toHaveURL(new RegExp(${quote(escapeRegex(a.expected ?? ''))}));`];
        case 'url-unchanged': {
          helpers.add('expectPath');
          const name = a.expected ? pageNameFor(a.expected, exploration) : undefined;
          // "User is logged in" without a page: the page is no longer the one the last action started on.
          if (a.negated && !name) return [`await expectPath(page, ${quote(pathOf(item.observed?.previousUrl ?? item.observed?.url ?? '/'))}, { not: true });`];
          const path = name ? `${pageClass(pageFor(name, exploration).className)}.path` : quote(pathOf(item.observed?.url ?? '/'));
          return [`await expectPath(page, ${path});`];
        }
        case 'text':
          return a.negated
            ? [`await expect(page.getByText(${quote(a.expected ?? '')})).toHaveCount(0);`]
            : [`await expect(page.getByText(${quote(a.expected ?? '')}).first()).toBeVisible();`];
        case 'visible':
          return [`await expect(${target()}).${not}toBeVisible(${a.options?.timeoutMs ? `{ timeout: ${a.options.timeoutMs} }` : ''});`];
        case 'enabled':
          return [`await expect(${target()}).${not}toBeEnabled();`];
        case 'disabled':
          return [`await expect(${target()}).${not}toBeDisabled();`];
        case 'checked':
          return [`await expect(${target()}).${not}toBeChecked();`];
        case 'value':
          return [`await expect(${target()}).${not}toHaveValue(${quote(a.expected ?? '')});`];
        case 'health':
          // Checked by the test fixture after every test (FR-VAL-04, M6).
          return [];
        default: {
          // The checks of the validation catalogue: each type writes its own code (src/validations).
          // A message the tester left open ("an appropriate error message") is written as the one learned in exploration.
          const lines = codeFor(item.learned && !a.expected ? { ...a, expected: item.learned.text } : a, {
            target,
            other: () => {
              if (!item.other) throw new Error(`${model.id} ${item.id}: the second element of this check was not found.`);
              return `page.${item.other.locator.code}`;
            },
            quote,
            escapeRegex,
            helpers,
          });
          if (!lines) throw new Error(`${model.id} ${item.id}: no code for the check type "${a.type}".`);
          return lines;
        }
      }
    }

    const setup = exploration.items.filter((i) => i.phase === 'setup');
    if (setup.length) {
      const loginModel = exploration.setup ? { ...model, steps: exploration.setup.steps } : loginModelFor(sorted, setup);
      if (!loginModel) throw new Error(`${model.id}: the login steps of its "Logged in" precondition are not known. Explore it again.`);
      run(setup, loginModel);
    }
    run(
      exploration.items.filter((i) => i.phase === 'test'),
      model,
    );

    tests.push({
      testId: model.id,
      title: model.title,
      automationId: automationId(model.id),
      file: `tests/${file}.spec.ts`,
      steps: model.steps.map((s) => ({ id: s.id, raw: s.raw, action: s.action })),
      checks: model.assertions.map((a) => ({
        id: a.id,
        raw: a.raw,
        type: a.type,
        expected: a.expected,
        target: a.target,
        negated: a.negated,
        options: a.options,
        other: a.other?.target,
        learned: exploration.items.find((i) => i.id === a.id && i.phase === 'test')?.learned?.text,
      })),
      assumptions: assumptionsOf(model, exploration),
      unparsed: [...model.steps, ...model.assertions].filter((x) => x.status === 'unparsed').map((x) => x.id),
    });
    if (usesData) data.push({ file, values: Object.fromEntries([...dataKeys].map(([k, v]) => [v, allData[k]])) });
    specs.push({
      file,
      testId: model.id,
      title: model.title,
      automationId: automationId(model.id),
      tags: model.type ? [`@${model.type}`] : [],
      pages: [...usedPages].sort(),
      imports: [...new Set([...usedPages, ...referenced])].sort(),
      dataFile: usesData ? file : undefined,
      helpers: [...helpers].sort(),
      steps,
    });
  }

  return {
    // A merged page is in the map under both names; list it once.
    pages: [...new Set(pages.values())],
    tests,
    specs,
    data,
    envVars: [...envVars].sort((a, b) => (a === 'BASE_URL' ? -1 : b === 'BASE_URL' ? 1 : a.localeCompare(b))),
    secretVars: [...envVars].filter((n) => isSecret(n, defaultParserConfig())).sort(),
    baseUrl: first.baseUrl,
    testIdAttribute: first.testIdAttribute,
    warnings,
  };
}

/** The element's role and name; explorations saved before `element` existed fall back to the fingerprint. */
function elementOf(item: ExploredItem): { role: string; name: string } {
  if (item.element) return item.element;
  const f = item.fingerprint;
  return { role: f?.role ?? 'element', name: f?.name || f?.label || f?.text || f?.placeholder || '' };
}

/** A setup phase comes from the login test case; find its model so its step values resolve. */
function loginModelFor(inputs: GenerateInput[], setup: ExploredItem[]): TestModel | undefined {
  const ids = setup.map((i) => `${i.id}|${i.raw}`).join();
  return inputs
    .map((i) => i.model)
    .find((m) =>
      m.steps
        .map((s) => `${s.id}|${s.raw}`)
        .join()
        .startsWith(ids),
    );
}

/** The Page Object for a page name the tester used ("Login" → LoginPage), if the exploration saw it. */
function pageNameFor(name: string, ex: ExplorationResult): string | undefined {
  const className = pascal(name).endsWith('Page') ? pascal(name) : `${pascal(name)}Page`;
  return ex.pages[className] ? className : undefined;
}

function pageByUrl(url: string, ex: ExplorationResult): string | undefined {
  try {
    const u = new URL(url, ex.baseUrl);
    if (u.origin !== new URL(ex.baseUrl).origin) return undefined;
    return Object.entries(ex.pages).find(([, p]) => p.path === u.pathname)?.[0];
  } catch {
    return undefined;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Decisions the platform made that the tester did not state: made-up values, page aliases, spelling fixes, learned messages. */
function assumptionsOf(model: TestModel, exploration: ExplorationResult): string[] {
  const codes = new Set(['ASSUMED_VALUE', 'PAGE_ALIAS', 'SPELLING_FIXED']);
  return [
    ...model.warnings.filter((w) => codes.has(w.code)).map((w) => `${w.at ? `${w.at}: ` : ''}${w.text}`),
    ...exploration.items
      .filter((i) => i.learned && i.phase === 'test')
      .map((i) => `${i.id}: the error message "${i.learned?.text}" was learned from the application.`),
  ];
}
