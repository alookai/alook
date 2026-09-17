import Sqlite from "better-sqlite3"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as communityFunnelAnalyticsSchema from "../../community-funnel-analytics-schema"
import * as communityMachineSchema from "../../community-machine-schema"
import * as communitySchema from "../../community-schema"
import * as userSchema from "../../schema"
import type { Database } from "../../index"
import {
  claimPendingEvents,
  recordFirstAgentReplyPersisted,
  recordInvitedHumanJoinedStatement,
  recordRuntimeConnectedStatement,
} from "./funnel-analytics"

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../../web/migrations/0103_community_funnel_analytics_event.sql",
)

describe("Community funnel analytics ledger", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY NOT NULL,
        isBot INTEGER NOT NULL,
        ownerUserId TEXT,
        deletedAt TEXT
      );
      CREATE TABLE community_machine (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE community_machine_credential (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE community_server_member (
        id TEXT PRIMARY KEY NOT NULL,
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL
      );
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY NOT NULL,
        author_id TEXT NOT NULL,
        type TEXT NOT NULL,
        deleted_at TEXT
      );
    `)
    sqlite.exec(readFileSync(migrationPath, "utf8"))
    sqlite.prepare("INSERT INTO user (id, isBot, ownerUserId) VALUES (?, ?, ?)").run("owner", 0, null)
    sqlite.prepare("INSERT INTO user (id, isBot, ownerUserId) VALUES (?, ?, ?)").run("other", 0, null)
    sqlite.prepare("INSERT INTO user (id, isBot, ownerUserId) VALUES (?, ?, ?)").run("bot", 1, "owner")
    sqlite.prepare("INSERT INTO user (id, isBot, ownerUserId) VALUES (?, ?, ?)").run("joined", 0, null)
    sqlite.prepare("INSERT INTO user (id, isBot, ownerUserId) VALUES (?, ?, ?)").run("joined-bot", 1, "owner")
    sqlite.prepare("INSERT INTO community_message (id, author_id, type) VALUES (?, ?, ?)")
      .run("message-first", "bot", "default")
    sqlite.prepare("INSERT INTO community_message (id, author_id, type) VALUES (?, ?, ?)")
      .run("message-later", "bot", "default")
    db = drizzle(sqlite, {
      schema: {
        ...userSchema,
        ...communitySchema,
        ...communityMachineSchema,
        ...communityFunnelAnalyticsSchema,
      },
    }) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("binds ledger owners to users and supplies a runtime creation timestamp", () => {
    const config = getTableConfig(communityFunnelAnalyticsSchema.communityFunnelAnalyticsEvent)
    const ownerReference = config.foreignKeys[0]?.reference()

    expect(ownerReference?.foreignTable).toBe(userSchema.user)
    expect(communityFunnelAnalyticsSchema.communityFunnelAnalyticsEvent.createdAt.defaultFn?.())
      .toEqual(expect.any(String))
  })

  it("dedupes authoritative facts, filters actors, and claims exact account payloads once", async () => {
    sqlite.prepare("INSERT INTO community_machine (id, user_id, status) VALUES (?, ?, ?)").run("machine", "owner", "online")
    sqlite.prepare("INSERT INTO community_machine_credential (id, user_id, machine_id, credential_hash) VALUES (?, ?, ?, ?)")
      .run("credential", "owner", "machine", "hash")
    sqlite.prepare("INSERT INTO community_server_member (id, server_id, user_id) VALUES (?, ?, ?)")
      .run("membership", "server", "joined")
    sqlite.prepare("INSERT INTO community_server_member (id, server_id, user_id) VALUES (?, ?, ?)")
      .run("bot-membership", "server", "joined-bot")

    await recordRuntimeConnectedStatement(db, {
      ownerUserId: "owner",
      machineId: "machine",
      credentialHash: "hash",
      now: "2026-09-14T00:00:00.000Z",
    })
    await recordRuntimeConnectedStatement(db, {
      ownerUserId: "owner",
      machineId: "machine",
      credentialHash: "hash",
      now: "2026-09-14T00:00:01.000Z",
    })
    await expect(recordFirstAgentReplyPersisted(db, {
      botUserId: "bot",
      messageId: "message-first",
      conversationType: "thread",
      now: "2026-09-14T00:00:02.000Z",
    })).resolves.toBe(true)
    await expect(recordFirstAgentReplyPersisted(db, {
      botUserId: "bot",
      messageId: "message-later",
      conversationType: "dm",
      now: "2026-09-14T00:00:03.000Z",
    })).resolves.toBe(false)
    await recordInvitedHumanJoinedStatement(db, {
      ownerUserId: "owner",
      membershipId: "membership",
      invitedUserId: "joined",
      now: "2026-09-14T00:00:04.000Z",
    })
    await recordInvitedHumanJoinedStatement(db, {
      ownerUserId: "owner",
      membershipId: "bot-membership",
      invitedUserId: "joined-bot",
      now: "2026-09-14T00:00:05.000Z",
    })

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_funnel_analytics_event").get())
      .toEqual({ count: 3 })
    expect(sqlite.prepare("SELECT source_id FROM community_funnel_analytics_event WHERE event_name = ?").get("first_agent_reply_persisted"))
      .toEqual({ source_id: "message-first" })
    await expect(claimPendingEvents(db, "other")).resolves.toEqual([])
    const events = await claimPendingEvents(db, "owner", "2026-09-14T00:01:00.000Z")
    expect(events.sort((a, b) => a.event.localeCompare(b.event))).toEqual([
      { event: "first_agent_reply_persisted", surface: "community", conversation_type: "thread" },
      { event: "invited_human_joined", surface: "community" },
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
    ])
    expect(JSON.stringify(events)).not.toMatch(/owner|machine|membership|bot|hash/)
    await expect(claimPendingEvents(db, "owner")).resolves.toEqual([])
  })

  it("rejects invalid event and conversation combinations at the migration boundary", () => {
    expect(() => sqlite.prepare(`
      INSERT INTO community_funnel_analytics_event
        (id, owner_user_id, event_name, conversation_type, source_id, dedupe_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("bad", "owner", "runtime_connected", "dm", "source", "bad", "2026-09-14T00:00:00.000Z"))
      .toThrow()
  })

  it("drops an unknown stored event instead of exposing an untyped payload", async () => {
    const returning = vi.fn().mockResolvedValue([{ eventName: "unknown", conversationType: null }])
    const where = vi.fn(() => ({ returning }))
    const set = vi.fn(() => ({ where }))
    const update = vi.fn(() => ({ set }))

    await expect(claimPendingEvents({ update } as unknown as Database, "owner"))
      .resolves.toEqual([])
  })
})
