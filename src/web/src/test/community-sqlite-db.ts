import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { createRequire } from "node:module"
import { createDb } from "@alook/shared"
import * as tables from "../../../shared/src/db/community-schema"
import { user } from "../../../shared/src/db/schema"

const requireShared = createRequire(import.meta.resolve("@alook/shared"))
const { is } = requireShared("drizzle-orm") as { is: (value: unknown, kind: unknown) => boolean }
const { SQLiteTable, getTableConfig } = requireShared("drizzle-orm/sqlite-core") as {
  SQLiteTable: unknown
  getTableConfig: (table: unknown) => { name: string; columns: Array<{ name: string; default?: unknown; getSQLType: () => string }> }
}

export function createCommunitySqliteDb() {
  const sqlite = new DatabaseSync(":memory:")
  for (const table of [user, ...Object.values(tables).filter(value => is(value, SQLiteTable))]) {
    const config = getTableConfig(table)
    sqlite.exec(`CREATE TABLE "${config.name}" (${config.columns.map(column => {
      const value = column.default
      const initial = typeof value === "string" ? " DEFAULT '" + value.replaceAll("'", "''") + "'" : typeof value === "number" ? ` DEFAULT ${value}` : typeof value === "boolean" ? ` DEFAULT ${Number(value)}` : ""
      return `"${column.name}" ${column.getSQLType()}${initial}`
    }).join(", ")})`)
  }
  const record = { invocations: 0, batches: [] as number[], statements: [] as Array<{ sql: string; bindings: SQLInputValue[] }> }
  const binding = {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const execute = (arrays: boolean, batched = false) => {
        if (!batched) record.invocations++
        record.statements.push({ sql, bindings: [...values] })
        if (values.length > 100) throw new Error("Existing D1 binding limit exceeded")
        const statement = sqlite.prepare(sql)
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
      return Promise.all(statements.map(statement => statement.batchResult()))
    },
  }
  return { sqlite, db: createDb(binding as unknown as D1Database), record }
}
