import type { SQLInputValue } from "node:sqlite"
import { createRequire } from "node:module"
import { createDb } from "@alook/shared"
import * as machineTables from "../../../shared/src/db/community-machine-schema"
import * as tables from "../../../shared/src/db/community-schema"
import { user } from "../../../shared/src/db/schema"

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")
const requireShared = createRequire(import.meta.resolve("@alook/shared"))
const { is } = requireShared("drizzle-orm") as { is: (value: unknown, kind: unknown) => boolean }
const { SQLiteTable, getTableConfig, SQLiteSyncDialect } = requireShared("drizzle-orm/sqlite-core") as {
  SQLiteTable: unknown
  SQLiteSyncDialect: new () => { sqlToQuery: (value: unknown) => { sql: string; params: unknown[] } }
  getTableConfig: (table: unknown) => { name: string; columns: Array<{ name: string; primary: boolean; isUnique: boolean; default?: unknown; getSQLType: () => string }>; primaryKeys: Array<{ columns: Array<{ name: string }> }>; uniqueConstraints: Array<{ columns: Array<{ name: string }> }>; indexes: Array<{ config: { name: string; unique: boolean; columns: Array<{ name?: string }>; where?: unknown } }> }
}

export function createCommunitySqliteDb() {
  const sqlite = new DatabaseSync(":memory:")
  const dialect = new SQLiteSyncDialect()
  for (const table of [user, ...Object.values({ ...tables, ...machineTables }).filter(value => is(value, SQLiteTable))]) {
    const config = getTableConfig(table)
    sqlite.exec(`CREATE TABLE "${config.name}" (${config.columns.map(column => {
      const value = column.default
      const initial = typeof value === "string" ? " DEFAULT '" + value.replaceAll("'", "''") + "'" : typeof value === "number" ? ` DEFAULT ${value}` : typeof value === "boolean" ? ` DEFAULT ${Number(value)}` : ""
      return `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : column.isUnique ? " UNIQUE" : ""}${initial}`
    }).concat(config.primaryKeys.map(key => `PRIMARY KEY (${key.columns.map(column => `"${column.name}"`).join(", ")})`), config.uniqueConstraints.map(key => `UNIQUE (${key.columns.map(column => `"${column.name}"`).join(", ")})`)).join(", ")})`)
    for (const index of config.indexes) if (index.config.unique) {
      const columns = index.config.columns.map(column => column.name ? `"${column.name}"` : dialect.sqlToQuery(column).sql).join(", ")
      const where = index.config.where ? dialect.sqlToQuery(index.config.where) : undefined
      if (where?.params.length) throw new Error("Test schema index requires literal metadata")
      sqlite.exec(`CREATE UNIQUE INDEX "${index.config.name}" ON "${config.name}" (${columns})${where ? ` WHERE ${where.sql}` : ""}`)
    }
  }
  sqlite.exec("CREATE UNIQUE INDEX idx_read_state_user_channel ON community_read_state(user_id, channel_id)")
  const record = { invocations: 0, batches: [] as number[], statements: [] as Array<{ sql: string; bindings: SQLInputValue[] }> }
  const binding = {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const execute = (arrays: boolean, batched = false) => {
        if (!batched) record.invocations++
        record.statements.push({ sql, bindings: [...values] })
        if (values.length > 100) throw new Error("Existing D1 binding limit exceeded")
        let statement
        try { statement = sqlite.prepare(sql) } catch (error) { throw new Error(`Test SQL preparation failed: ${sql}`, { cause: error }) }
        statement.setReturnArrays(arrays)
        return statement.all(...values)
      }
      const prepared = {
        bind(...bindings: SQLInputValue[]) { values = bindings; return prepared },
        async raw() { return execute(true) },
        async all() { return { success: true, results: execute(false) } },
        async run() { record.invocations++; record.statements.push({ sql, bindings: [...values] }); return { success: true, meta: sqlite.prepare(sql).run(...values) } },
        async batchResult() { return { success: true, results: execute(false, true) } },
      }
      return prepared
    },
    async batch(statements: Array<{ batchResult: () => Promise<unknown> }>) {
      record.invocations++
      record.batches.push(statements.length)
      sqlite.exec("BEGIN")
      try {
        const results = []
        for (const statement of statements) results.push(await statement.batchResult())
        sqlite.exec("COMMIT")
        return results
      } catch (error) { sqlite.exec("ROLLBACK"); throw error }
    },
  }
  return { sqlite, db: createDb(binding as unknown as D1Database), record }
}
