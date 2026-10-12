import Sqlite from "better-sqlite3"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { getTableName } from "drizzle-orm"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { productAnalyticsEvent } from "../../product-analytics-schema"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../index"
import { claimDelivery, claimSignupSession, finishDelivery, getInviteSource, getOwnedServer, notePendingReason, recordEvent, recordFirstHumanMessage } from "./product-analytics"

const time = "2026-10-12T05:00:00.000Z"
const identity = { clientId: "100.200", sessionId: "1791781200" }

describe("product analytics durable ledger", () => {
  let sqlite: Sqlite.Database
  let db: Database
  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE user (id TEXT PRIMARY KEY, isBot INTEGER, deletedAt TEXT);
      CREATE TABLE community_server (id TEXT PRIMARY KEY, owner_id TEXT);
      CREATE TABLE community_server_invite (id TEXT PRIMARY KEY, token TEXT, server_id TEXT, created_by TEXT);
      CREATE TABLE community_channel (id TEXT PRIMARY KEY, server_id TEXT);
      CREATE TABLE community_message (id TEXT PRIMARY KEY, author_id TEXT, channel_id TEXT, type TEXT, created_at TEXT);
      INSERT INTO user VALUES ('owner', 0, NULL), ('other', 0, NULL), ('bot', 1, NULL), ('deleted', 0, '2026-10-10');
      INSERT INTO community_server VALUES ('server', 'owner'), ('other-server', 'other');
      INSERT INTO community_server_invite VALUES ('invite', 'private-token', 'server', 'owner');
      INSERT INTO community_channel VALUES ('channel', 'server'), ('other-channel', 'other-server'), ('dm', NULL);
    `)
    sqlite.exec(readFileSync(resolve(import.meta.dirname, "../../../../../web/migrations/0107_product_analytics_event.sql"), "utf8"))
    db = drizzle(sqlite) as unknown as Database
  })
  afterEach(() => sqlite.close())
  const entry = () => recordEvent(db, { eventName: "onboarding_enter_clicked", actorUserId: "owner", serverId: "server", dedupeKey: "entry", ...identity, createdAt: time })
  function message(id: string, author = "owner", channel = "channel", createdAt = "2026-10-12T05:00:01.000Z", type = "default") {
    sqlite.prepare("INSERT INTO community_message VALUES (?, ?, ?, ?, ?)").run(id, author, channel, type, createdAt)
  }

  it("keeps migration foreign keys and dedupe/scope indexes aligned with the Drizzle schema", () => {
    const config = getTableConfig(productAnalyticsEvent)
    const declaredKeys = config.foreignKeys.map(key => {
      const ref = key.reference()
      return { from: ref.columns[0].name, table: getTableName(ref.foreignTable), to: ref.foreignColumns[0].name, on_delete: key.onDelete?.toUpperCase() }
    }).sort((a, b) => a.from.localeCompare(b.from))
    const actualKeys = (sqlite.pragma("foreign_key_list(product_analytics_event)") as { from: string; table: string; to: string; on_delete: string }[])
      .map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })).sort((a, b) => a.from.localeCompare(b.from))
    expect(actualKeys).toEqual(declaredKeys)
    const actualIndexes = sqlite.pragma("index_list(product_analytics_event)") as { name: string; unique: number; origin: string }[]
    expect(actualIndexes.filter(index => index.origin === "c").map(index => index.name).sort())
      .toEqual(config.indexes.map(index => index.config.name).sort())
    for (const { config: index } of config.indexes) {
      expect(actualIndexes.find(item => item.name === index.name)?.unique).toBe(index.unique ? 1 : 0)
      const columns = sqlite.pragma(`index_info('${index.name}')`) as { name: string }[]
      expect(columns.map(column => column.name)).toEqual(index.columns.map(column => "name" in column ? column.name : null))
    }
  })
  it("scopes onboarding servers to the actual owner", async () => {
    expect(await getOwnedServer(db, "owner", "server")).toEqual({ id: "server" })
    expect(await getOwnedServer(db, "other", "server")).toBeNull()
  })
  it("resolves invitation source only through the capability token", async () => {
    expect(await getInviteSource(db, "private-token")).toEqual({ id: "invite", serverId: "server", createdBy: "owner" })
    expect(await getInviteSource(db, "unknown")).toBeNull()
  })
  it("deduplicates identical events without exposing another actor's row", async () => {
    const first = await entry()
    expect((await entry())?.row.id).toBe(first?.row.id)
    expect((await entry())?.inserted).toBe(false)
    expect(await recordEvent(db, { eventName: "onboarding_enter_clicked", actorUserId: "other", serverId: "server", dedupeKey: "entry", ...identity, createdAt: time })).toBeNull()
  })
  it("does not invent a first-message event without an Enter click", async () => {
    message("first")
    expect(await recordFirstHumanMessage(db, "owner", "server", identity, "first")).toBeNull()
  })
  it("excludes before-click messages and records the first subsequent human message", async () => {
    message("old", "owner", "channel", "2026-10-12T04:59:00.000Z")
    await entry()
    message("first")
    message("second", "owner", "channel", "2026-10-12T05:00:02.000Z")
    const result = await recordFirstHumanMessage(db, "owner", "server", identity, "first")
    expect(result?.row).toMatchObject({ sourceId: "first", createdAt: "2026-10-12T05:00:01.000Z", eventName: "onboarding_first_message" })
    expect((await recordFirstHumanMessage(db, "owner", "server", identity, "first"))?.row.id).toBe(result?.row.id)
  })
  it("excludes bot, DM, other-server and other-user messages", async () => {
    await entry()
    message("bot", "bot")
    message("other", "other")
    message("dm", "owner", "dm")
    message("other-server", "owner", "other-channel")
    message("system", "owner", "channel", undefined, "system")
    expect(await recordFirstHumanMessage(db, "owner", "server", identity, "first")).toBeNull()
  })
  it("does not backfill a prior untracked message from a later successful write", async () => {
    await entry()
    message("first")
    message("second", "owner", "channel", "2026-10-12T05:00:02.000Z")
    expect(await recordFirstHumanMessage(db, "owner", "server", identity, "second")).toBeNull()
  })
  it("does not count deleted human accounts", async () => {
    await recordEvent(db, { eventName: "onboarding_enter_clicked", actorUserId: "deleted", serverId: "server", dedupeKey: "deleted-entry", ...identity, createdAt: time })
    message("deleted-message", "deleted")
    expect(await recordFirstHumanMessage(db, "deleted", "server", identity, "deleted-message")).toBeNull()
  })
  it("uses the current message session instead of the prior click session", async () => {
    await entry()
    message("late", "owner", "channel", "2026-10-15T05:00:01.000Z")
    expect((await recordFirstHumanMessage(db, "owner", "server", { ...identity, sessionId: "1792040400" }, "late"))?.row.sessionId).toBe("1792040400")
  })
  it("claims the registration's first session atomically and only once", async () => {
    await recordEvent(db, { eventName: "sign_up", actorUserId: "owner", dedupeKey: "signup:owner", ...identity, createdAt: time })
    expect(await claimSignupSession(db, "owner", "session-1")).toBe(true)
    expect(await claimSignupSession(db, "owner", "session-1")).toBe(true)
    expect(await claimSignupSession(db, "owner", "session-2")).toBe(false)
    expect(await claimSignupSession(db, "other", "session-1")).toBe(false)
  })
  it("allows only one transport claim and never retries an ambiguous send", async () => {
    const event = (await entry())!.row
    expect(await claimDelivery(db, event.id)).toMatchObject({ deliveryStatus: "sending" })
    expect(await claimDelivery(db, event.id)).toBeNull()
    await finishDelivery(db, event.id, "uncertain", "collection_transport_ambiguous")
    expect(await claimDelivery(db, event.id)).toBeNull()
    expect(sqlite.prepare("SELECT delivery_status FROM product_analytics_event").get()).toEqual({ delivery_status: "uncertain" })
  })
  it("records missing config without erasing a completed status", async () => {
    const event = (await entry())!.row
    await notePendingReason(db, event.id, "configuration_missing")
    expect(sqlite.prepare("SELECT delivery_reason FROM product_analytics_event").get()).toEqual({ delivery_reason: "configuration_missing" })
    await claimDelivery(db, event.id)
    await finishDelivery(db, event.id, "accepted", "http_accepted")
    await notePendingReason(db, event.id, "configuration_missing")
    expect(sqlite.prepare("SELECT delivery_reason FROM product_analytics_event").get()).toEqual({ delivery_reason: "http_accepted" })
  })
})
