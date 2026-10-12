import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Secret } from './secret.js';

/**
 * DS-04: the credential store. Configuration variables that hold secrets are encrypted at rest with AES-256-GCM. The
 * key is not in the store and not next to it: it comes from the environment (`AUTO_QA_KEY`, 32 bytes in base64) or is
 * given by the caller. A store opened with the wrong key, or a file that was changed, does not open: GCM checks both.
 */

const ALGORITHM = 'aes-256-gcm';

export const KEY_ENV = 'AUTO_QA_KEY';

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

interface StoreFile {
  version: 1;
  entries: Record<string, Sealed>;
}

export const newKey = (): Buffer => randomBytes(32);

/** The key from the environment: 32 bytes written in base64. */
export function keyFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env[KEY_ENV];
  if (!raw) throw new Error(`${KEY_ENV} is not set: the credential store needs a 32-byte key (base64) that is kept outside the store`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${KEY_ENV} must be 32 bytes in base64 (AES-256); it is ${key.length}`);
  return key;
}

export class CredentialStore {
  constructor(
    private readonly file: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('the credential store key must be 32 bytes (AES-256)');
  }

  private async read(): Promise<StoreFile> {
    if (!existsSync(this.file)) return { version: 1, entries: {} };
    return JSON.parse(await readFile(this.file, 'utf8')) as StoreFile;
  }

  /** Encrypts a value under a name. A new random IV for every write: the same value never gives the same bytes twice. */
  async set(name: string, value: string): Promise<void> {
    const store = await this.read();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    // The name is authenticated with the value: an entry moved under another name does not open.
    cipher.setAAD(Buffer.from(name));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    store.entries[name] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(store, null, 2)}\n`);
  }

  /** The secret under a name, or undefined. A wrong key or a changed file throws: it is never read as "not there". */
  async get(name: string): Promise<Secret | undefined> {
    const sealed = (await this.read()).entries[name];
    if (!sealed) return undefined;
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    try {
      return new Secret(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch {
      throw new Error(`the credential "${name}" cannot be opened: wrong key, or the store was changed`);
    }
  }

  async names(): Promise<string[]> {
    return Object.keys((await this.read()).entries).sort();
  }
}
