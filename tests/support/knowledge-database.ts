import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { SharedDatabase, SharedStatement } from "@/lib/kroger-shared-sql";
import { krogerHandoffSchemaStatements } from "@/db/schema";

/** Real SQLite, same prepared statements as D1. File-backed callers can close
 * and reopen it to prove that process caches are not the learning mechanism. */
export function knowledgeDatabase(path = ":memory:") {
  const sqlite = new DatabaseSync(path);
  for (const sql of krogerHandoffSchemaStatements) sqlite.exec(sql);
  // Test migration ledger only. Production migrations belong to Sites.
  sqlite.exec("CREATE TABLE IF NOT EXISTS test_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL)");
  for (const name of readdirSync(resolve("drizzle")).filter(f => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve("drizzle", name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const prior = sqlite.prepare("SELECT checksum FROM test_migrations WHERE name=?").get(name);
    if (prior) { if (prior.checksum !== checksum) throw new Error("Applied migration changed"); continue; }
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of sql.split("--> statement-breakpoint").filter(s => s.trim())) sqlite.exec(statement);
      sqlite.prepare("INSERT INTO test_migrations VALUES (?,?)").run(name, checksum);
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  class Statement implements SharedStatement {
    constructor(readonly sql: string, readonly values: (string | number | null)[] = []) {}
    bind(...values: (string | number | null)[]) { return new Statement(this.sql, values); }
    async first<T>() { return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
    async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  }
  const db: SharedDatabase = {
    prepare: sql => new Statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map(s => { const q = s as Statement; return { results: sqlite.prepare(q.sql).all(...q.values) as Record<string, unknown>[] }; });
        sqlite.exec("COMMIT"); return result;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return { sqlite, db, close: () => sqlite.close() };
}
