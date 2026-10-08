import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Storage references (DATABASE.md D27): a file is named `scheme:key`, relative to a configured root, never by an
 * absolute path. Moving the data directory, or later using S3, changes configuration and not rows.
 * `local:` is the data directory (uploads, runs, explorations); `workspace:` is the folder of generated projects.
 */

export type ArtifactRoots = Record<string, string>;

export interface ArtifactStore {
  /** The reference for a file inside a root, or undefined for a file outside every root. */
  toRef(file: string): string | undefined;
  /** The file a reference names on this machine. Throws for a reference that escapes its root. */
  resolve(ref: string): string;
  exists(ref: string): boolean;
}

const REF = /^([a-z][a-z0-9]*):(.+)$/;

/** `C:\x` is not a reference (the scheme is longer than one letter). */
export function isRef(value: string): boolean {
  const m = REF.exec(value);
  return !!m && m[1].length > 1;
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly roots: Array<[string, string]>;

  constructor(roots: ArtifactRoots) {
    // The longest root first, so a root inside another one wins.
    this.roots = Object.entries(roots)
      .map(([scheme, dir]): [string, string] => [scheme, path.resolve(dir)])
      .sort((a, b) => b[1].length - a[1].length);
  }

  toRef(file: string): string | undefined {
    const abs = path.resolve(file);
    for (const [scheme, root] of this.roots) {
      const rel = path.relative(root, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `${scheme}:${rel.split(path.sep).join('/')}`;
    }
    return undefined;
  }

  resolve(ref: string): string {
    const m = REF.exec(ref);
    const root = m && this.roots.find(([scheme]) => scheme === m[1])?.[1];
    if (!m || !root) throw new Error(`Unknown storage reference "${ref}"`);
    const abs = path.resolve(root, ...m[2].split('/'));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`The storage reference "${ref}" leaves its root`);
    return abs;
  }

  exists(ref: string): boolean {
    try {
      return existsSync(this.resolve(ref));
    } catch {
      return false;
    }
  }
}

export interface FileFacts {
  ref: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.html': 'text/html',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Reference, type, size and hash of a file that exists; undefined when it is missing or outside every root. */
export async function describeFile(artifacts: ArtifactStore, file: string): Promise<FileFacts | undefined> {
  const ref = artifacts.toRef(file);
  if (!ref || !existsSync(file)) return undefined;
  const info = await stat(file);
  if (!info.isFile()) return undefined;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { ref, mime: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', sizeBytes: info.size, sha256: hash.digest('hex') };
}
