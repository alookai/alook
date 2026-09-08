import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as coreSchema from "../schema"
import * as communitySchema from "../community-schema"
import * as machineSchema from "../community-machine-schema"
import type { Database } from "../index"
import {
  deleteAccountRows,
  deleteDeletionChallengeIfMatches,
  getAccountDeletionSnapshot,
  restoreDeletionChallenge,
  takeDeletionChallenge,
  upsertDeletionChallenge,
  type DeletionChallenge,
} from "./account-deletion"

const schema = { ...coreSchema, ...communitySchema, ...machineSchema }

function challenge(overrides: Partial<DeletionChallenge> = {}): DeletionChallenge {
  return {
    id: "account-deletion:test",
    identifier: "account-deletion-otp:user-1:user@example.com",
    value: "123456:0",
    expiresAt: "2026-09-07T15:05:00.000Z",
    createdAt: "2026-09-07T15:00:00.000Z",
    updatedAt: "2026-09-07T15:00:00.000Z",
    ...overrides,
  }
}

describe("account deletion challenge queries", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE verification (
        id TEXT PRIMARY KEY NOT NULL,
        identifier TEXT NOT NULL,
        value TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    db = drizzle(sqlite, { schema }) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("keeps exactly one active row and makes the latest code authoritative", async () => {
    await upsertDeletionChallenge(db, challenge())
    await upsertDeletionChallenge(db, challenge({
      value: "654321:0",
      expiresAt: "2026-09-07T15:06:00.000Z",
      updatedAt: "2026-09-07T15:01:00.000Z",
    }))

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM verification").get()).toEqual({ count: 1 })
    expect(sqlite.prepare("SELECT value, expiresAt FROM verification").get()).toEqual({
      value: "654321:0",
      expiresAt: "2026-09-07T15:06:00.000Z",
    })
  })

  it("fails closed when RETURNING does not yield the persisted challenge", async () => {
    const emptyReturningDb = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({ returning: async () => [] }),
        }),
      }),
    } as unknown as Database

    await expect(upsertDeletionChallenge(emptyReturningDb, challenge()))
      .rejects.toThrow("account deletion challenge was not persisted")
  })

  it("atomically takes a challenge only once", async () => {
    await upsertDeletionChallenge(db, challenge())

    await expect(takeDeletionChallenge(db, challenge())).resolves.toMatchObject({ value: "123456:0" })
    await expect(takeDeletionChallenge(db, challenge())).resolves.toBeNull()
  })

  it("restores only when a newer resend has not won the primary key", async () => {
    const original = challenge()
    await expect(restoreDeletionChallenge(db, original)).resolves.toBe(true)
    await upsertDeletionChallenge(db, challenge({ value: "654321:0" }))
    await expect(restoreDeletionChallenge(db, original)).resolves.toBe(false)
    expect(sqlite.prepare("SELECT value FROM verification").get()).toEqual({ value: "654321:0" })
  })

  it("rolls back only the exact challenge written by a failed send", async () => {
    const original = challenge()
    await upsertDeletionChallenge(db, original)
    await upsertDeletionChallenge(db, challenge({ value: "654321:0" }))

    await expect(deleteDeletionChallengeIfMatches(db, original)).resolves.toBe(false)
    await expect(deleteDeletionChallengeIfMatches(db, challenge({ value: "654321:0" }))).resolves.toBe(true)
  })
})

describe("account deletion snapshot and delete queries", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    const migrationRoot = resolve(import.meta.dirname, "../../../../web/migrations")
    for (const filename of readdirSync(migrationRoot).filter((name) => name.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(resolve(migrationRoot, filename), "utf8"))
    }
    sqlite.pragma("foreign_keys = ON")
    const sqliteDb = drizzle(sqlite, { schema })
    Object.assign(sqliteDb, {
      batch: async (statements: Array<{
        config: { returning?: unknown }
        all: () => unknown[]
        run: () => unknown
      }>) => sqlite.transaction(() => statements.map((statement) =>
        statement.config.returning ? statement.all() : statement.run(),
      ))(),
    })
    db = sqliteDb as unknown as Database
  })

  afterEach(() => sqlite.close())

  function run(statement: string, ...bindings: unknown[]): void {
    sqlite.prepare(statement).run(...bindings)
  }

  it("snapshots every attributable root and deletes it without damaging shared data", async () => {
    const now = "2026-09-08T00:00:00.000Z"
    const owner = "delete_owner"
    const bot = "delete_bot"
    const reader = "surviving_reader"
    const earlyReader = "surviving_early_reader"
    const ownedWorkspace = "owned_workspace"
    const sharedWorkspace = "shared_workspace"
    const ownedAgent = "owned_agent"
    const sharedOwnedAgent = "shared_owned_agent"
    const survivingAgent = "surviving_agent"
    const runtime = "owned_runtime"
    const daemon = "owned_daemon"
    const dm = "surviving_dm"
    const priorMessage = "prior_message"
    const authoredMessage = "authored_message"
    const botMessage = "bot_message"
    const forum = "surviving_forum"
    const opener = "owned_opener"
    const thread = "doomed_thread"
    const reply = "thread_reply"
    const ownedServer = "owned_server"
    const emptyOwnedServer = "empty_owned_server"
    const serverChannel = "owned_server_channel"
    const sharedAttachmentKey = "emails/drafts/shared.txt"
    const privateAttachmentKey = "emails/drafts/private.txt"

    run(
      "INSERT INTO user (id, email, name, discriminator, avatarObjectKey) VALUES (?, ?, 'Owner', '8101', ?), (?, ?, 'Bot', '8102', ?), (?, ?, 'Reader', '8103', NULL), (?, ?, 'Early reader', '8104', NULL)",
      owner, `${owner}@example.com`, `users/${owner}/avatar`,
      bot, `${bot}@example.com`, `bots/${bot}/avatar`,
      reader, `${reader}@example.com`, earlyReader, `${earlyReader}@example.com`,
    )
    run("UPDATE user SET isBot = 1, ownerUserId = ? WHERE id = ?", owner, bot)
    run(
      "INSERT INTO account (id, userId, accountId, providerId, accessToken, refreshToken, createdAt, updatedAt) VALUES ('account_1', ?, 'provider_account', 'github', 'access', 'refresh', ?, ?)",
      owner, now, now,
    )
    run(
      "INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Owned', ?, ?, ?), (?, 'Shared', ?, ?, ?)",
      ownedWorkspace, ownedWorkspace, now, now, sharedWorkspace, sharedWorkspace, now, now,
    )
    run(
      "INSERT INTO member (id, workspace_id, user_id, role, created_at) VALUES ('member_owner', ?, ?, 'owner', ?), ('member_coowner', ?, ?, 'owner', ?), ('member_shared_owner', ?, ?, 'owner', ?), ('member_shared_user', ?, ?, 'member', ?)",
      ownedWorkspace, owner, now, ownedWorkspace, reader, now,
      sharedWorkspace, reader, now, sharedWorkspace, owner, now,
    )
    run(
      "INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES ('token_owner', ?, ?, 'al_owner_token', 'Owner', 'active', ?), ('token_workspace', ?, ?, 'al_workspace_token', 'Workspace', 'active', ?)",
      owner, sharedWorkspace, now, reader, ownedWorkspace, now,
    )
    run(
      "INSERT INTO agent (id, workspace_id, name, owner_id, created_at, updated_at) VALUES (?, ?, 'Owned', ?, ?, ?), (?, ?, 'Shared owned', ?, ?, ?)",
      ownedAgent, ownedWorkspace, owner, now, now,
      sharedOwnedAgent, sharedWorkspace, owner, now, now,
    )
    run(
      "INSERT INTO machine (daemon_id, workspace_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      daemon, sharedWorkspace, owner, now, now,
    )
    run(
      "INSERT INTO agent_runtime (id, workspace_id, daemon_id, provider, created_at, updated_at) VALUES (?, ?, ?, 'codex', ?, ?)",
      runtime, sharedWorkspace, daemon, now, now,
    )
    run(
      "INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, 'Survivor', ?, ?, ?, ?)",
      survivingAgent, sharedWorkspace, runtime, reader, now, now,
    )
    run(
      "INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, type, channel, created_at) VALUES ('owned_conversation', ?, ?, ?, '', 'user_dm_message', 'default', ?)",
      ownedWorkspace, ownedAgent, owner, now,
    )
    run(
      "INSERT INTO artifact (id, conversation_id, agent_id, workspace_id, filename, size, r2_key, thumbnail_r2_key, created_at) VALUES ('owned_artifact', 'owned_conversation', ?, ?, 'artifact.txt', 1, 'artifacts/raw', 'artifacts/thumb', ?)",
      ownedAgent, ownedWorkspace, now,
    )
    run(
      "INSERT INTO meeting_session (id, agent_id, workspace_id, meeting_url, transcript_r2_key, created_at, updated_at) VALUES ('owned_meeting', ?, ?, 'https://example.com', 'meetings/transcript', ?, ?)",
      ownedAgent, ownedWorkspace, now, now,
    )
    run(
      "INSERT INTO emails (id, agent_id, workspace_id, from_email, to_email, r2_key, attachments, created_at) VALUES ('deleting_email', ?, ?, 'owner@example.com', 'x@example.com', 'emails/deleting/raw', ?, ?), ('invalid_email', ?, ?, 'owner@example.com', 'x@example.com', 'emails/invalid/raw', 'not-json', ?), ('non_array_email', ?, ?, 'owner@example.com', 'x@example.com', 'emails/non-array/raw', '{}', ?), ('surviving_email', ?, ?, 'reader@example.com', 'x@example.com', 'emails/surviving/raw', ?, ?)",
      ownedAgent, ownedWorkspace, JSON.stringify([{ key: sharedAttachmentKey }, { key: privateAttachmentKey }, { nope: true }, null]), now,
      ownedAgent, ownedWorkspace, now,
      ownedAgent, ownedWorkspace, now,
      survivingAgent, sharedWorkspace, JSON.stringify([{ key: sharedAttachmentKey }]), now,
    )
    run("INSERT INTO community_machine (id, user_id, created_at, updated_at) VALUES ('community_machine_1', ?, ?, ?)", owner, now, now)
    run(
      "INSERT INTO community_machine_credential (id, user_id, machine_id, credential_hash, do_name, created_at) VALUES ('credential_1', ?, 'community_machine_1', ?, ?, ?)",
      owner, "a".repeat(64), "b".repeat(32), now,
    )
    run(
      "INSERT INTO community_bot_binding (user_id, machine_id, runtime, instruction, created_at) VALUES (?, 'community_machine_1', 'codex', '', ?)",
      bot, now,
    )
    run(
      "INSERT INTO community_server (id, name, discriminator, owner_id, icon, created_at) VALUES (?, 'Owned', '8201', ?, 'servers/owned/icon', ?), (?, 'Empty', '8202', ?, NULL, ?)",
      ownedServer, owner, now, emptyOwnedServer, owner, now,
    )
    run(
      "INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES ('server_member', ?, ?, 'member', ?)",
      ownedServer, reader, now,
    )
    run("INSERT INTO community_channel (id, server_id, name, type, message_count, created_at) VALUES (?, ?, 'owned', 'text', 0, ?)", serverChannel, ownedServer, now)
    run("INSERT INTO community_channel (id, type, message_count, last_message_at, created_at) VALUES (?, 'dm', 3, ?, ?)", dm, now, now)
    run(
      "INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'prior', ?, ?, 1), (?, ?, 'authored', ?, ?, 2), (?, ?, 'bot authored', ?, ?, 3)",
      priorMessage, reader, now, dm,
      authoredMessage, owner, now, dm,
      botMessage, bot, now, dm,
    )
    run(
      "INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq) VALUES ('reader_state', ?, ?, ?, ?, 3), ('early_state', ?, ?, ?, ?, 1)",
      reader, dm, now, botMessage, earlyReader, dm, now, priorMessage,
    )
    run(
      "INSERT INTO community_mention (id, message_id, user_id, kind, read) VALUES ('reader_mention', ?, ?, 'mention', 0)",
      authoredMessage, reader,
    )
    run("INSERT INTO community_channel (id, name, type, message_count, last_message_at, created_at) VALUES (?, 'forum', 'forum', 1, ?, ?)", forum, now, now)
    run("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'opener', ?, ?, 1)", opener, owner, now, forum)
    run(
      "INSERT INTO community_channel (id, name, type, parent_channel_id, parent_message_id, message_count, last_message_at, created_at) VALUES (?, 'thread', 'thread', ?, ?, 1, ?, ?)",
      thread, forum, opener, now, now,
    )
    run("INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'reply', ?, ?, 1)", reply, reader, now, thread)
    run(
      "INSERT INTO community_attachment (id, message_id, uploader_id, target_id, r2_key, thumbnail_r2_key, filename, position, created_at) VALUES ('thread_attachment', ?, ?, ?, 'community/thread/raw', 'community/thread/thumb', 'reply.txt', 0, ?), ('owner_attachment', ?, ?, ?, 'community/owner/raw', NULL, 'owner.txt', 0, ?), ('pending_server_attachment', NULL, ?, ?, 'community/pending-server/raw', NULL, 'pending-server.txt', 0, ?), ('pending_thread_attachment', NULL, ?, ?, 'community/pending-thread/raw', 'community/pending-thread/thumb', 'pending-thread.txt', 0, ?)",
      reply, reader, thread, now,
      authoredMessage, owner, dm, now,
      reader, serverChannel, now,
      reader, thread, now,
    )
    const createdAtMs = Date.parse(now)
    run(
      "INSERT INTO community_diagnostic_report (id, owner_user_id, agent_id, machine_id, client_nonce, rate_bucket, status, from_ms, created_at, deadline_at) VALUES ('dbr_owned', ?, ?, 'community_machine_1', 'nonce_123456789012', ?, 'pending', ?, ?, ?)",
      owner, bot, Math.trunc(createdAtMs / 60_000), createdAtMs - 86_400_000, createdAtMs, createdAtMs + 600_000,
    )

    expect(await getAccountDeletionSnapshot(db, bot)).toBeNull()
    expect(await getAccountDeletionSnapshot(db, "missing_user")).toBeNull()
    const snapshot = await getAccountDeletionSnapshot(db, owner)

    expect(snapshot).not.toBeNull()
    expect(snapshot!.identities.map((row) => row.id).sort()).toEqual([bot, owner])
    expect(snapshot!.providers).toHaveLength(1)
    expect(snapshot!.ownedWorkspaceIds).toEqual([ownedWorkspace])
    expect(snapshot!.ownedAgentIds.sort()).toEqual([ownedAgent, sharedOwnedAgent].sort())
    expect(snapshot!.legacyDaemons).toEqual([{ workspaceId: sharedWorkspace, daemonId: daemon }])
    expect(snapshot!.machineTokens.sort()).toEqual(["al_owner_token", "al_workspace_token"])
    expect(snapshot!.machineDoNames).toEqual(["b".repeat(32)])
    expect(snapshot!.botBindings).toEqual([{ botId: bot, machineId: "community_machine_1" }])
    expect(snapshot!.ownedServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownedServer, memberIds: [reader] }),
      expect.objectContaining({ id: emptyOwnedServer, memberIds: [] }),
    ]))
    expect(snapshot!.readStateUserIds.sort()).toEqual([earlyReader, reader].sort())
    expect(snapshot!.media.communityExactKeys).toEqual(expect.arrayContaining([
      `user-avatar/${owner}`,
      `bot-avatar/${bot}`,
      "community/thread/raw",
      "community/thread/thumb",
      "community/owner/raw",
      "community/pending-server/raw",
      "community/pending-thread/raw",
      "community/pending-thread/thumb",
    ]))
    expect(snapshot!.media.emailExactKeys).toEqual(expect.arrayContaining([
      "artifacts/raw",
      "artifacts/thumb",
      "emails/deleting/raw",
      "meetings/transcript",
    ]))
    expect(snapshot!.media.survivingEmailAttachments).toEqual([
      JSON.stringify([{ key: sharedAttachmentKey }]),
    ])
    expect(snapshot!.media.bugReportPrefixes).toEqual(expect.arrayContaining([
      `bug-reports/${owner}/`,
      `bug-reports/${bot}/`,
    ]))

    const result = await deleteAccountRows(db, snapshot!)
    expect(result.deleted).toBe(true)
    expect(result.readStateRevisions.sort((left, right) => left.userId.localeCompare(right.userId)))
      .toEqual([
        { userId: earlyReader, revision: 1 },
        { userId: reader, revision: 1 },
      ].sort((left, right) => left.userId.localeCompare(right.userId)))
    expect(sqlite.prepare("SELECT id FROM user WHERE id IN (?, ?)").get(owner, bot)).toBeUndefined()
    expect(sqlite.prepare("SELECT id FROM workspace WHERE id = ?").get(ownedWorkspace)).toBeUndefined()
    expect(sqlite.prepare("SELECT id FROM workspace WHERE id = ?").get(sharedWorkspace)).toEqual({ id: sharedWorkspace })
    expect(sqlite.prepare("SELECT runtime_id FROM agent WHERE id = ?").get(survivingAgent)).toEqual({ runtime_id: null })
    expect(sqlite.prepare("SELECT id FROM community_attachment WHERE id IN (?, ?)").get(
      "pending_server_attachment",
      "pending_thread_attachment",
    )).toBeUndefined()
    expect(sqlite.prepare("SELECT id FROM user WHERE id = ?").get(reader)).toEqual({ id: reader })
    expect(sqlite.prepare("SELECT message_count FROM community_channel WHERE id = ?").get(dm)).toEqual({ message_count: 1 })
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  })

  it("returns an empty revision list when deleting a user with no affected readers", async () => {
    run("INSERT INTO user (id, email, name, discriminator) VALUES ('lonely_user', 'lonely@example.com', 'Lonely', '8301')")
    const snapshot = await getAccountDeletionSnapshot(db, "lonely_user")

    expect(snapshot).not.toBeNull()
    await expect(deleteAccountRows(db, snapshot!)).resolves.toEqual({
      deleted: true,
      readStateRevisions: [],
    })
  })
})
