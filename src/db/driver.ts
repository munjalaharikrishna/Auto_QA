/**
 * The database driver (DATABASE.md §4.1): the only thing that knows which database is underneath.
 * SQLite today; a PostgreSQL driver arrives with team mode (V3) behind the same interface.
 * Methods are async so the PostgreSQL driver needs no change anywhere else.
 */

export type DialectName = 'sqlite' | 'postgres';
export type Param = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  /** The id of the row an INSERT created (tables with an auto-increment id). */
  lastInsertId: number;
}

/** What repositories use: either the connection itself or a transaction on it. */
export interface Queryable {
  readonly dialect: DialectName;
  run(sql: string, params?: Param[]): Promise<RunResult>;
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface Driver extends Queryable {
  /** The database file, or undefined for an in-memory or server database. */
  readonly file?: string;
  /** All-or-nothing: the function's writes are committed together, or none are (FR-DB-07). */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** A consistent copy of the whole database at `destination`. */
  backup(destination: string): Promise<void>;
  close(): Promise<void>;
}

/** The few differences between databases. Everything else is the common SQL subset (D25). */
export interface Dialect {
  name: DialectName;
  /** UTC timestamp: ISO-8601 text in SQLite. */
  ts: string;
  json: string;
  bool: string;
  blob: string;
  /** A column definition for an auto-incrementing integer primary key. */
  autoId: string;
}

export const DIALECTS: Record<DialectName, Dialect> = {
  sqlite: { name: 'sqlite', ts: 'TEXT', json: 'TEXT', bool: 'INTEGER', blob: 'BLOB', autoId: 'INTEGER PRIMARY KEY AUTOINCREMENT' },
  postgres: { name: 'postgres', ts: 'TIMESTAMPTZ', json: 'JSONB', bool: 'BOOLEAN', blob: 'BYTEA', autoId: 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY' },
};
