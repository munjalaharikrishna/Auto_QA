import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Handlebars from 'handlebars';
import { format } from 'prettier';
import { pageVariable, quote } from './names.js';
import type { ProjectPlan } from './plan.js';

/**
 * Renders a plan into files (FR-GE-01, FR-GE-05): Handlebars templates, then Prettier with a fixed
 * configuration, so the same plan always gives byte-identical files (FR-GE-06).
 */

/** Written to the generated project too, so its own editor formats the same way. */
export const PRETTIER = { singleQuote: true, printWidth: 120, trailingComma: 'all', semi: true } as const;

const hb = Handlebars.create();
hb.registerHelper('quote', (text: unknown) => quote(String(text ?? '')));
hb.registerHelper('json', (value: unknown) => JSON.stringify(value));
hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);

const template = (name: string) => hb.compile(readFileSync(new URL(`./templates/${name}.hbs`, import.meta.url), 'utf8'), { noEscape: true, strict: true });
const T = {
  page: template('page.ts'),
  spec: template('spec.ts'),
  data: template('data.ts'),
  fixture: template('fixture.ts'),
  config: template('playwright.config.ts'),
  pkg: template('package.json'),
  tsconfig: template('tsconfig.json'),
  env: template('env.example'),
  gitignore: template('gitignore'),
  reporter: template('reporter.ts'),
};

const require = createRequire(import.meta.url);
/** The generated project uses the same Playwright as the platform, so what was validated is what runs. */
const PLAYWRIGHT_VERSION: string = require('@playwright/test/package.json').version;
const TYPES_NODE_VERSION: string = require('@types/node/package.json').version;

export async function renderProject(plan: ProjectPlan, name: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const ts = async (path: string, source: string) => {
    files[path] = await format(source, { ...PRETTIER, parser: 'typescript' });
  };

  for (const page of plan.pages) {
    await ts(`pages/${page.className}.ts`, T.page(page));
    const entries = Object.fromEntries(page.properties.map((p) => [p.name, p.entry]));
    files[`locators/${page.fileBase}.locators.json`] = `${JSON.stringify(entries, null, 2)}\n`;
  }
  for (const spec of plan.specs) {
    const helpers = ['test', 'step', ...(spec.steps.some((s) => s.lines.some((l) => l.includes('expect('))) ? ['expect'] : []), ...spec.helpers];
    await ts(
      `tests/${spec.file}.spec.ts`,
      T.spec({
        ...spec,
        titleLine: `${spec.testId}: ${spec.title}`,
        helperImports: helpers.join(', '),
        pageVars: spec.pages.map((className) => ({ className, var: pageVariable(className) })),
      }),
    );
  }
  for (const d of plan.data) {
    await ts(`data/${d.file}.data.ts`, T.data({ testId: plan.specs.find((s) => s.file === d.file)?.testId ?? d.file, values: d.values }));
  }
  await ts('fixtures/test.fixture.ts', T.fixture({}));
  await ts('reporters/auto-qa-reporter.ts', T.reporter({}));
  await ts('playwright.config.ts', T.config(plan));
  files['package.json'] = T.pkg({ name, playwrightVersion: PLAYWRIGHT_VERSION, typesNodeVersion: TYPES_NODE_VERSION });
  files['tsconfig.json'] = T.tsconfig({});
  files['.env.example'] = T.env(plan);
  files['.gitignore'] = T.gitignore({});
  files['auto-qa.json'] = `${JSON.stringify(
    { version: 1, name, baseUrl: plan.baseUrl, testIdAttribute: plan.testIdAttribute, envVars: plan.envVars, secretVars: plan.secretVars, tests: plan.tests },
    null,
    2,
  )}
`;
  files['.prettierrc.json'] = `${JSON.stringify(PRETTIER, null, 2)}\n`;
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
