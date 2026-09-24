import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config";

// Project root: one level above server/ (ts-node) or two above dist/server/ (compiled).
export const ROOT = path.basename(path.dirname(__dirname)) === "dist" ? path.resolve(__dirname, "..", "..") : path.resolve(__dirname, "..");

export type SqlParam = string | number | null;

/**
 * Persistence adapter. All services talk to this interface only, so a Postgres/MySQL driver can be
 * swapped in by implementing it (the SQL in the services is plain ANSI plus `?` placeholders).
 */
export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  get<T>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
}

export class SqliteDb implements Db {
  private readonly conn: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.conn = new Database(file);
    this.conn.pragma("journal_mode = WAL");
    this.conn.pragma("foreign_keys = ON");
  }

  async exec(sql: string): Promise<void> {
    this.conn.exec(sql);
  }
  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    return { changes: this.conn.prepare(sql).run(...params).changes };
  }
  async get<T>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return this.conn.prepare(sql).get(...params) as T | undefined;
  }
  async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.conn.prepare(sql).all(...params) as T[];
  }
}

export const db: Db = new SqliteDb(config.databasePath || path.join(ROOT, "db", "blog-scheduler.sqlite"));

export async function migrate(): Promise<void> {
  await db.exec(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf-8"));
}
