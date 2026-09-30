import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * V1 credential storage (FR-ENV-05): the run settings from the form are written only to the project
 * workspace's git-ignored .env. They are never stored in the database, and the API never returns a
 * secret: it only says whether one is set.
 */

const SECRET = /pass|secret|token|key|pin|otp/i;

export function readEnvFile(workspace: string): Record<string, string> {
  const file = path.join(workspace, '.env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Merges `values` into the workspace's .env. An empty or missing value keeps what is there, so a form
 * that leaves the password blank does not erase it. `null` removes a variable.
 */
export async function writeEnvFile(workspace: string, values: Record<string, string | null | undefined>): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const current = readEnvFile(workspace);
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Za-z_]\w*$/.test(k)) throw new Error(`"${k}" is not a valid variable name.`);
    if (v === null) delete current[k];
    else if (v !== undefined && v !== '') current[k] = v.replace(/[\r\n]/g, '');
  }
  const body = Object.entries(current)
    .map(([k, v]) => `${k}=${quoted(k, v)}`)
    .join('\n');
  await writeFile(path.join(workspace, '.env'), `# Written by Auto QA. Git-ignored; never commit it.\n${body}\n`);
  await ensureIgnored(workspace);
}

/** What the API may show about a workspace's variables: names, the username, and whether each secret is set. */
export function describeEnv(workspace: string): {
  username?: string;
  hasPassword: boolean;
  variables: Array<{ name: string; secret: boolean; value?: string }>;
} {
  const env = readEnvFile(workspace);
  return {
    username: env.TEST_USERNAME,
    hasPassword: !!env.TEST_PASSWORD,
    variables: Object.keys(env)
      .sort()
      .map((name) => (SECRET.test(name) ? { name, secret: true } : { name, secret: false, value: env[name] })),
  };
}

/**
 * .env readers (Node's, Playwright's config) take a quoted value literally, without backslash escapes,
 * so a value is wrapped in whichever quote it does not contain.
 */
function quoted(name: string, value: string): string {
  if (!/[\s#"'=]/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error(`${name} contains both ' and " characters, which a .env file cannot hold. Change it, or set it in the environment instead.`);
}

async function ensureIgnored(workspace: string): Promise<void> {
  const file = path.join(workspace, '.gitignore');
  const current = existsSync(file) ? await readFile(file, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('.env')) await writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.env\n`);
}
