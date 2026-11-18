import type Sqlite from "better-sqlite3"

type CompiledBatchQuery = { sql: string }
type PrepareBatchHook = (database: Sqlite.Database, query: CompiledBatchQuery) => Sqlite.Statement

const prepareBatchHook = Symbol.for("alook.db-query-check.prepare-batch")

export function prepareNativeBatchStatement(database: Sqlite.Database, query: CompiledBatchQuery): Sqlite.Statement {
  const prepare = (globalThis as { [key: symbol]: PrepareBatchHook | undefined })[prepareBatchHook]
  return prepare ? prepare(database, query) : database.prepare(query.sql)
}
