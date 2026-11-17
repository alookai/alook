import { readFileSync, readdirSync } from "node:fs"
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3"
import Sqlite from "better-sqlite3"
import { vi } from "vitest"
import type { Database } from "../../src/db"

type NativeStatement = {
  toSQL(): { sql: string; params: unknown[] }
  all(): unknown
  run(): unknown
}

export function createMigratedDb() {
  const sqlite = new Sqlite(":memory:")
  try {
    sqlite.pragma("foreign_keys = ON")
    const root = new URL("../../../web/migrations/", import.meta.url)
    for (const name of readdirSync(root).filter(name => name.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(new URL(name, root), "utf8"))
    }
    const errors: unknown[] = []
    const orm = drizzleSqlite(sqlite)
    const batch = vi.fn(async (statements: NativeStatement[]) => {
      try {
        return sqlite.transaction(() => statements.map(statement => {
          const query = statement.toSQL()
          return sqlite.prepare(query.sql).reader ? statement.all() : statement.run()
        }))()
      } catch (error) {
        errors.push(error)
        throw error
      }
    })
    const db = Object.assign(orm, { batch }) as unknown as Database
    return { sqlite, db, batch, errors }
  } catch (error) {
    sqlite.close()
    throw error
  }
}
