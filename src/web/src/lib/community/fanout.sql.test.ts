import type { SQLInputValue } from "node:sqlite"
import { createRequire } from "node:module"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as sharedActual from "@alook/shared"
import * as machineTables from "../../../../shared/src/db/community-machine-schema"
import * as communityTables from "../../../../shared/src/db/community-schema"
import { user } from "../../../../shared/src/db/schema"
import { prepareNativeD1BatchStatement } from "../../../../shared/test/helpers/native-batch-prepare"

const state = vi.hoisted(() => ({
  db: null as unknown as sharedActual.Database,
  wsDoFetches: [] as Array<{ url: string; method: string; body: string }>,
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      DB: state.db,
      WS_DO_WORKER: {
        fetch: vi.fn(async (input: string | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.url
          const method = typeof input === "string" ? (init?.method ?? "GET") : input.method
          const body = typeof input === "string"
            ? String(init?.body ?? "")
            : await input.clone().text()
          state.wsDoFetches.push({ url, method, body })
          return Response.json({ sent: 1 }, { status: 200 })
        }),
      },
    },
    ctx: { waitUntil: vi.fn() },
  }),
}))

vi.mock("@/lib/db", () => ({
  getDb: () => state.db,
  getPrimaryDb: () => state.db,
}))

vi.mock("@/lib/middleware/auth", () => ({
  humanAuthPolicy: {
    resolve: async () => ({
      context: {
        env: { DB: state.db },
        userId: "u-0",
      },
    }),
  },
}))

import { DELETE as deleteChannelRoute } from "@/app/api/community/channels/[id]/route"
import { POST as addParticipantRoute } from "@/app/api/community/channels/[id]/participants/route"
import { publishServerMemberLeaves } from "./fanout"

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

const openDbs: InstanceType<typeof DatabaseSync>[] = []

beforeEach(() => {
  state.wsDoFetches.length = 0
})

afterEach(() => {
  for (const sqlite of openDbs) sqlite.close()
  openDbs.length = 0
  vi.restoreAllMocks()
})

function createWebCountingSqliteDb() {
  const sqlite = new DatabaseSync(":memory:")
  openDbs.push(sqlite)
  const dialect = new SQLiteSyncDialect()
  const allTables = [
    user,
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
  sqlite.exec("CREATE UNIQUE INDEX idx_read_state_user_channel ON community_read_state(user_id, channel_id)")

  const queries: Array<{ sql: string; bindings: SQLInputValue[] }> = []
  const binding = {
    withSession() {
      return binding
    },
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const runSelect = (arrays: boolean, batched = false) => {
        const stmt = batched ? prepareNativeD1BatchStatement(sqlite, prepared, sql) : sqlite.prepare(sql)
        stmt.setReturnArrays(arrays)
        const rows = stmt.all(...values)
        queries.push({ sql, bindings: [...values] })
        return rows
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
          const meta = sqlite.prepare(sql).run(...values)
          queries.push({ sql, bindings: [...values] })
          return { success: true, meta }
        },
        async batchResult() {
          return { success: true, results: runSelect(false, true) }
        },
      }
      return prepared
    },
    async batch(statements: Array<{ batchResult: () => Promise<unknown> }>) {
      sqlite.exec("BEGIN")
      try {
        const results = []
        for (const stmt of statements) results.push(await stmt.batchResult())
        sqlite.exec("COMMIT")
        return results
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  }

  const db = sharedActual.createDb(binding as unknown as D1Database)
  state.db = db
  return { sqlite, db, queries }
}

function seedServerMembers(sqlite: InstanceType<typeof DatabaseSync>, humans: number) {
  const now = "2026-11-26T00:00:00.000Z"
  const insertUser = sqlite.prepare(
    'INSERT INTO user (id, email, name, discriminator, "isBot", "ownerUserId", "avatarVersion", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, 0, NULL, 0, ?, ?)',
  )
  const insertMember = sqlite.prepare(
    "INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, 'srv-1', ?, ?, ?)",
  )
  sqlite.exec("BEGIN")
  sqlite.prepare(
    "INSERT INTO community_server (id, name, discriminator, description, owner_id, created_at) VALUES ('srv-1', 'ScaleSrv', '0001', '', 'u-0', ?)",
  ).run(now)
  for (let i = 0; i < humans; i++) {
    const uid = `u-${i}`
    insertUser.run(uid, `${uid}@example.test`, `User${i}`, String((i + 10) % 10000).padStart(4, "0"), now, now)
    insertMember.run(`m-h-${i}`, uid, i === 0 ? "owner" : "member", now)
  }
  sqlite.prepare(
    "INSERT INTO community_channel (id, server_id, name, type, topic, position, archived, message_count, created_at, creator_id) VALUES ('ch-pub', 'srv-1', 'general', 'text', '', 0, 0, 0, ?, 'u-0')",
  ).run(now)
  sqlite.exec("COMMIT")
}

describe("batched community fan-out routes", () => {
  it("batches ws-do broadcasts for channel delete, thread participant add, and server member leaves without per-user loops", async () => {
    const fixture = createWebCountingSqliteDb()
    seedServerMembers(fixture.sqlite, 200)
    const now = "2026-11-26T00:00:00.000Z"

    fixture.sqlite.exec("BEGIN")
    fixture.sqlite.prepare(
      "INSERT INTO community_message (id, author_id, content, type, channel_id, seq, created_at) VALUES ('m-1', 'u-0', 'hi', 'default', 'ch-pub', 1, ?)",
    ).run(now)
    const insertRead = fixture.sqlite.prepare(
      "INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq) VALUES (?, ?, 'ch-pub', ?, 'm-1', 1)",
    )
    const insertRev = fixture.sqlite.prepare(
      "INSERT INTO community_read_state_revision (user_id, revision) VALUES (?, 1)",
    )
    for (let i = 0; i < 200; i++) {
      insertRead.run(`rs-${i}`, `u-${i}`, now)
      insertRev.run(`u-${i}`)
    }
    fixture.sqlite.prepare(
      "INSERT INTO community_channel (id, server_id, name, type, topic, position, parent_channel_id, archived, message_count, created_at, creator_id) VALUES ('ch-parent', 'srv-1', 'parent', 'text', '', 1, NULL, 0, 0, ?, 'u-0')",
    ).run(now)
    fixture.sqlite.prepare(
      "INSERT INTO community_channel (id, server_id, name, type, topic, position, parent_channel_id, archived, message_count, created_at, creator_id) VALUES ('ch-thread', 'srv-1', 'thread', 'thread', '', 0, 'ch-parent', 0, 0, ?, 'u-0')",
    ).run(now)
    fixture.sqlite.exec("COMMIT")

    const delRes = await deleteChannelRoute(
      new NextRequest("https://alook.test/api/community/channels/ch-pub", { method: "DELETE" }),
      { params: Promise.resolve({ id: "ch-pub" }) },
    )
    expect(delRes.status).toBe(204)
    expect(state.wsDoFetches.filter((f) => f.url.includes("/broadcast/community/user/"))).toHaveLength(0)
    expect(state.wsDoFetches.filter((f) => f.url.includes("/broadcast/community/deliveries"))).toHaveLength(1)
    expect(state.wsDoFetches.filter((f) => f.url.includes("/broadcast/community/users"))).toHaveLength(1)

    state.wsDoFetches.length = 0
    const addPartRes = await addParticipantRoute(
      new NextRequest("https://alook.test/api/community/channels/ch-thread/participants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "u-1" }),
      }),
      { params: Promise.resolve({ id: "ch-thread" }) },
    )
    expect(addPartRes.status).toBe(201)
    expect(state.wsDoFetches.filter((f) => f.url.includes("/broadcast/community/user/"))).toHaveLength(0)
    expect(state.wsDoFetches.filter((f) => f.url.includes("/broadcast/community/users"))).toHaveLength(1)

    state.wsDoFetches.length = 0
    fixture.queries.length = 0
    await publishServerMemberLeaves("srv-1", Array.from({ length: 20 }, (_, i) => `u-${i + 1}`))
    expect(state.wsDoFetches.filter((f) => f.url.includes("/broadcast/community/user/"))).toHaveLength(0)
    expect(state.wsDoFetches.filter((f) => f.url.includes("/broadcast/community/deliveries"))).toHaveLength(1)
    expect(fixture.queries.filter((q) => q.sql.includes("community_server_member"))).toHaveLength(1)
  })
})
