type CompiledBatchQuery = { sql: string }
type NativeDatabase<Statement> = { prepare(sql: string): Statement }
type PrepareBatchHook = <Statement>(database: NativeDatabase<Statement>, query: object, sql?: string) => Statement

const prepareBatchHook = Symbol.for("alook.db-query-check.prepare-batch")

export function prepareNativeBatchStatement<Statement>(database: NativeDatabase<Statement>, query: CompiledBatchQuery): Statement {
  const prepare = (globalThis as { [key: symbol]: PrepareBatchHook | undefined })[prepareBatchHook]
  return prepare ? prepare(database, query) : database.prepare(query.sql)
}

export function prepareNativeD1BatchStatement<Statement>(database: NativeDatabase<Statement>, prepared: object, sql: string): Statement {
  const prepare = (globalThis as { [key: symbol]: PrepareBatchHook | undefined })[prepareBatchHook]
  return prepare ? prepare(database, prepared, sql) : database.prepare(sql)
}
