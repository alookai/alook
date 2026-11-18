import type Sqlite from "better-sqlite3"

export type BoundQuery = { sql: string; params: unknown[] }
export type QueryPlanRow = { id: number; parent: number; detail: string }

export function queryPlan(sqlite: Sqlite.Database, query: BoundQuery): QueryPlanRow[] {
  return sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as QueryPlanRow[]
}

export function businessTableScans(sqlite: Sqlite.Database, query: BoundQuery): string[] {
  const tables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(row => row.name))
  const aliases = new Map<string, string>()
  const explicitTables = new Set<string>()
  const identifier = '"([^"\\n]+)"|([a-zA-Z_][a-zA-Z_0-9]*)'
  const sources = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(?:${identifier})(?:\\s+(?:AS\\s+)?(?:${identifier}))?`, "gi")
  for (const match of query.sql.matchAll(sources)) {
    const table = match[1] ?? match[2]!
    const alias = match[3] ?? match[4]
    if (tables.has(table)) explicitTables.add(table)
    if (tables.has(table) && alias && !/^(?:where|set|on|left|inner|outer|cross|join|order|group|union|limit|returning|values)$/i.test(alias)) aliases.set(alias, table)
  }
  return queryPlan(sqlite, query).flatMap(row => {
    const match = /^SCAN (?:TABLE )?["`]?([a-zA-Z_][a-zA-Z_0-9]*)/.exec(row.detail)
    if (!match) return []
    const source = aliases.get(match[1]!) ?? match[1]!
    return explicitTables.has(source) ? [`${source}: ${row.detail}`] : []
  })
}

export function assertNoBusinessTableScans(sqlite: Sqlite.Database, query: BoundQuery): void {
  const scans = businessTableScans(sqlite, query)
  if (scans.length) throw new Error(`Unbounded business-table scan:\n${scans.join("\n")}\n${query.sql}`)
}
