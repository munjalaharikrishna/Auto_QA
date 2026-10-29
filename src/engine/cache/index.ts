import { createHash } from 'node:crypto';
import { isSecret } from '../data/secret.js';
import { patterns } from '../patterns/index.js';
import { componentVersions } from '../versions.js';

/**
 * Layer 76, caching (GV-11). What the engine works out from text alone is the same every time, so it is worked out once: the
 * understanding of a test case, and the knowledge of an application built from saved explorations. Nothing else is cached.
 *
 *  - Nothing that holds data is cached: values are resolved from the environment, the credential store and the test data on every
 *    compile, so a password that was changed is the password that is used.
 *  - Nothing that holds evidence is cached: no page, observation, locator result or verdict is ever kept for another step or run,
 *    so a hit can never make something look as if it was seen now (a stale message cannot become the proof of a PASS).
 *  - The caches live in the memory of the process and are never written to disk: a cached result is only as good as the code that
 *    made it, and the code is the same only for as long as the process lives.
 *  - The key holds everything the result depends on: the whole test case, how it is read, and the version of every component that
 *    reads it. A change to any of them is a miss.
 *  - A hit is a copy: whoever changes what they were given does not change what the next caller gets.
 *
 * `AUTO_QA_CACHE=off` (or `cache: false` in the options of a compile) switches them off, and the result is the same, only slower.
 */

export const CACHE_ENV = 'AUTO_QA_CACHE';

/** Whether caching is on. An explicit option wins over the environment; the default is on. */
export function cacheEnabled(option?: boolean, env: Record<string, string | undefined> = process.env): boolean {
  if (option !== undefined) return option;
  const v = env[CACHE_ENV]?.toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/** Keeps the most recent results, up to a limit. Insertion order is the order of use: a hit moves the entry to the end. */
export class Memo<V> {
  private readonly entries = new Map<string, V>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly limit = 500) {}

  get(key: string): V | undefined {
    const found = this.entries.get(key);
    if (found === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, found);
    return found;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as string);
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}

/** JSON with the keys of every object in order, so two equal values give one text. */
export function canonicalText(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(walk(value));
}

/** A short key for a value: what the result depends on, hashed. */
export const cacheKeyOf = (value: unknown): string => createHash('sha256').update(canonicalText(value)).digest('hex');

/** Everything about how text is read that a different version would change: the components of GV-12 and the pattern set. */
export const readingVersions = (): Record<string, unknown> => ({ components: componentVersions(), patterns: patterns().versions });

/**
 * A copy of plain data that a caller can change freely. A secret is passed on as it is: it cannot be changed and is never
 * written, and a copy of it would lose what it holds.
 */
export function copyOf<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object' || isSecret(v)) return v;
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, walk(x)]));
    if (v instanceof Set) return new Set([...v].map(walk));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value) as T;
}

/** What the caches hold, by name, for a test or a report. */
const registry = new Map<string, Memo<unknown>>();

/** The named cache, made on first use. */
export function memo<V>(name: string, limit?: number): Memo<V> {
  let m = registry.get(name);
  if (!m) {
    m = new Memo<unknown>(limit);
    registry.set(name, m);
  }
  return m as Memo<V>;
}

export const cacheStats = (): Record<string, CacheStats> => Object.fromEntries([...registry].map(([name, m]) => [name, m.stats]));

export function clearCaches(): void {
  for (const m of registry.values()) m.clear();
}
