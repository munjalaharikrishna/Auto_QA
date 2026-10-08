import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Driver, Param, Queryable, RunResult } from './driver.js';

/**
 * SQLite through Node's built-in `node:sqlite` (no native build on Windows). It is experimental in
 * Node 22, which is why nothing outside this file touches it (DATABASE.md §8.2).
 *
 * One connection, one writer. Statements and transactions are queued so a transaction never
 * picks up another caller's statements while it is open.
 */
export class SqliteDriver implements Driver {
  readonly dialect = 'sqlite' as const;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly db: DatabaseSync,
    readonly file: string | undefined,
  ) {}

  /** `file` is the database path, or `:memory:` for tests. */
  static async open(file: string): Promise<SqliteDriver> {
    const memory = file === ':memory:';
    if (!memory) mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    } catch (e) {
      db.close(); // a file that is not a database must not stay locked (it cannot be deleted on Windows otherwise)
      throw e;
    }
    return new SqliteDriver(db, memory ? undefined : file);
  }

  private queue<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  run(sql: string, params: Param[] = []): Promise<RunResult> {
    return this.queue(() => runOn(this.db, sql, params));
  }

  get<T = Record<string, unknown>>(sql: string, params: Param[] = []): Promise<T | undefined> {
    return this.queue(() => getOn<T>(this.db, sql, params));
  }

  all<T = Record<string, unknown>>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.queue(() => allOn<T>(this.db, sql, params));
  }

  exec(sql: string): Promise<void> {
    return this.queue(() => this.db.exec(sql));
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.queue(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(new SqliteTransaction(this.db));
        this.db.exec('COMMIT');
        return result;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    });
  }

  /** VACUUM INTO writes a consistent copy even while the WAL is in use. */
  backup(destination: string): Promise<void> {
    return this.queue(() => {
      mkdirSync(path.dirname(destination), { recursive: true });
      this.db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
    });
  }

  close(): Promise<void> {
    return this.queue(() => this.db.close());
  }
}

/** Runs inside the driver's queue slot, so it must not queue again. */
class SqliteTransaction implements Queryable {
  readonly dialect = 'sqlite' as const;
  constructor(private readonly db: DatabaseSync) {}
  async run(sql: string, params: Param[] = []) {
    return runOn(this.db, sql, params);
  }
  async get<T = Record<string, unknown>>(sql: string, params: Param[] = []) {
    return getOn<T>(this.db, sql, params);
  }
  async all<T = Record<string, unknown>>(sql: string, params: Param[] = []) {
    return allOn<T>(this.db, sql, params);
  }
  async exec(sql: string) {
    this.db.exec(sql);
  }
}

const input = (params: Param[]) => params as SQLInputValue[];

function runOn(db: DatabaseSync, sql: string, params: Param[]): RunResult {
  const r = db.prepare(sql).run(...input(params));
  return { changes: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
}

function getOn<T>(db: DatabaseSync, sql: string, params: Param[]): T | undefined {
  return db.prepare(sql).get(...input(params)) as T | undefined;
}

function allOn<T>(db: DatabaseSync, sql: string, params: Param[]): T[] {
  return db.prepare(sql).all(...input(params)) as T[];
}
