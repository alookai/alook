import type { SQLInputValue } from "node:sqlite"
import { createRequire } from "node:module"
import * as machineTables from "../../../shared/src/db/community-machine-schema"
import * as communityTables from "../../../shared/src/db/community-schema"
import { session, user } from "../../../shared/src/db/schema"

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")
const requireShared = createRequire(import.meta.resolve("@alook/shared"))
const { is } = requireShared("drizzle-orm") as { is: (value: unknown, kind: unknown) => boolean }
const { SQLiteTable, getTableConfig, SQLiteSyncDialect } = requireShared("drizzle-orm/sqlite-core") as {
  SQLiteTable: unknown
  SQLiteSyncDialect: new () => { sqlToQuery: (value: unknown) => { sql: string; params: unknown[] } }
  getTableConfig: (table: unknown) => {
    name: string
    columns: Array<{ name: string; primary: boolean; isUnique: boolean; default?: unknown; getSQLType: () => string }>
    primaryKeys: Array<{ columns: Array<{ name: string }> }>
    uniqueConstraints: Array<{ columns: Array<{ name: string }> }>
    indexes: Array<{ config: { name: string; unique: boolean; columns: Array<{ name?: string }>; where?: unknown } }>
  }
}

export function createCountingSqliteD1(openDbs: Array<InstanceType<typeof DatabaseSync>>) {
  const sqlite = new DatabaseSync(":memory:")
  openDbs.push(sqlite)
  const dialect = new SQLiteSyncDialect()
  const allTables = [
    user,
    session,
    ...Object.values({ ...communityTables, ...machineTables }).filter((value) => is(value, SQLiteTable)),
  ]
  for (const table of allTables) {
    const config = getTableConfig(table)
    const columnDefs = config.columns.map((column) => {
      const value = column.default
      const initial = typeof value === "string"
        ? ` DEFAULT '${value.replaceAll("'", "''")}'`
        : typeof value === "number"
          ? ` DEFAULT ${value}`
          : typeof value === "boolean"
            ? ` DEFAULT ${Number(value)}`
            : ""
      return `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : column.isUnique ? " UNIQUE" : ""}${initial}`
    })
    const pkDefs = config.primaryKeys.map((key) => `PRIMARY KEY (${key.columns.map((column) => `"${column.name}"`).join(", ")})`)
    const uniqueDefs = config.uniqueConstraints.map((key) => `UNIQUE (${key.columns.map((column) => `"${column.name}"`).join(", ")})`)
    sqlite.exec(`CREATE TABLE "${config.name}" (${[...columnDefs, ...pkDefs, ...uniqueDefs].join(", ")})`)
    for (const index of config.indexes) {
      const stripTable = (expr: string) => expr.replaceAll(`"${config.name}".`, "")
      const columns = index.config.columns.map((column) => ("name" in column && column.name ? `"${column.name}"` : stripTable(dialect.sqlToQuery(column as never).sql))).join(", ")
      const where = index.config.where ? dialect.sqlToQuery(index.config.where) : undefined
      if (where?.params.length) continue
      sqlite.exec(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where ? ` WHERE ${stripTable(where.sql)}` : ""}`)
    }
  }

  const queries: Array<{ sql: string; bindings: SQLInputValue[] }> = []
  const d1 = {
    withSession() {
      return d1
    },
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const runSelect = (arrays: boolean) => {
        queries.push({ sql, bindings: [...values] })
        const stmt = sqlite.prepare(sql)
        stmt.setReturnArrays(arrays)
        return stmt.all(...values)
      }
      const prepared = {
        bind(...bindings: SQLInputValue[]) {
          values = bindings.map((v) => (typeof v === "boolean" ? Number(v) : v)) as SQLInputValue[]
          return prepared
        },
        async raw() {
          return runSelect(true)
        },
        async all() {
          return { success: true, results: runSelect(false) }
        },
        async run() {
          queries.push({ sql, bindings: [...values] })
          return { success: true, meta: sqlite.prepare(sql).run(...values) }
        },
      }
      return prepared
    },
    async batch(statements: Array<{ all: () => Promise<unknown> }>) {
      const results = []
      for (const stmt of statements) results.push(await stmt.all())
      return results
    },
  } as unknown as D1Database

  return {
    sqlite,
    d1,
    queries,
    resetCount: () => {
      queries.length = 0
    },
  }
}

export function seedServerWithMembers(
  sqlite: InstanceType<typeof DatabaseSync>,
  memberCount: number,
  serverId = "srv-1",
  channelId = "ch-1",
) {
  const now = "2026-11-26T00:00:00.000Z"
  const expires = "2099-01-01T00:00:00.000Z"
  const insertUser = sqlite.prepare(
    'INSERT INTO user (id, email, name, discriminator, "isBot", "avatarVersion", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
  )
  const insertMember = sqlite.prepare(
    "INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)",
  )
  sqlite.exec("BEGIN")
  insertUser.run("user-0", "user-0@example.test", "User0", "0000", 0, now, now)
  sqlite.prepare(
    'INSERT INTO session (id, "userId", token, "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
  ).run("sess-0", "user-0", "token-0", expires, now, now)
  sqlite.prepare(
    "INSERT INTO community_server (id, name, discriminator, description, owner_id, created_at) VALUES (?, 'BigServer', '0001', '', 'user-0', ?)",
  ).run(serverId, now)
  insertMember.run("mem-0", serverId, "user-0", "owner", now)
  for (let i = 1; i <= memberCount; i++) {
    const uid = `user-${i}`
    insertUser.run(uid, `${uid}@example.test`, `User${i}`, String(i % 10000).padStart(4, "0"), 0, now, now)
    insertMember.run(`mem-${i}`, serverId, uid, "member", now)
  }
  sqlite.prepare(
    "INSERT INTO community_channel (id, server_id, name, type, topic, position, archived, message_count, created_at, creator_id) VALUES (?, ?, 'general', 'text', '', 0, 0, 0, ?, 'user-0')",
  ).run(channelId, serverId, now)
  sqlite.exec("COMMIT")
}
