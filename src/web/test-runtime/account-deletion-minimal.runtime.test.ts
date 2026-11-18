/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

const runtimeEnv = env as unknown as CloudflareEnv
const survivors: string[] = []
const survivingChannels: string[] = []

async function run(statement: string, ...bindings: unknown[]): Promise<void> {
  await runtimeEnv.DB.prepare(statement).bind(...bindings).run()
}

async function first<T>(statement: string, ...bindings: unknown[]): Promise<T | null> {
  return runtimeEnv.DB.prepare(statement).bind(...bindings).first<T>()
}

afterEach(async () => {
  for (const channelId of survivingChannels.splice(0)) {
    await run("DELETE FROM community_channel WHERE id = ?", channelId)
  }
  for (const userId of survivors.splice(0)) {
    await run("DELETE FROM user WHERE id = ?", userId)
  }
})

describe("minimal account deletion real D1 batch", () => {
  it("clears blockers and repairs a surviving channel read pointer atomically", async () => {
    const stamp = crypto.randomUUID().replaceAll("-", "")
    const owner = `adm_owner_${stamp}`
    const bot = `adm_bot_${stamp}`
    const reader = `adm_reader_${stamp}`
    const earlyReader = `adm_early_reader_${stamp}`
    const dm = `adm_dm_${stamp}`
    const prior = `adm_prior_${stamp}`
    const authored = `adm_authored_${stamp}`
    const botAuthored = `adm_bot_authored_${stamp}`
    const server = `adm_server_${stamp}`
    const serverChannel = `adm_server_channel_${stamp}`
    const forum = `adm_forum_${stamp}`
    const opener = `adm_opener_${stamp}`
    const thread = `adm_thread_${stamp}`
    const reply = `adm_reply_${stamp}`
    const threadAttachment = `adm_thread_attachment_${stamp}`
    const pendingServerAttachment = `adm_pending_server_attachment_${stamp}`
    const pendingThreadAttachment = `adm_pending_thread_attachment_${stamp}`
    const pendingServerAttachmentKey = `community/pending-server/${stamp}`
    const pendingThreadAttachmentKey = `community/pending-thread/${stamp}`
    const now = "2026-09-08T00:00:00.000Z"
    survivors.push(reader, earlyReader)
    survivingChannels.push(dm, forum)

    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', '8101'), (?, ?, 'Bot', '8102'), (?, ?, 'Reader', '8103'), (?, ?, 'Early reader', '8105')",
      owner, `${owner}@example.com`, bot, `${bot}@example.com`, reader, `${reader}@example.com`, earlyReader, `${earlyReader}@example.com`,
    )
    await run("UPDATE user SET isBot = 1, ownerUserId = ? WHERE id = ?", owner, bot)
    await run(
      "INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      `session_${stamp}`, owner, `token_${stamp}`, now, now, now,
    )
    await run(
      "INSERT INTO account (id, userId, accountId, providerId, createdAt, updatedAt) VALUES (?, ?, ?, 'github', ?, ?)",
      `account_${stamp}`, owner, `provider_${stamp}`, now, now,
    )
    await run(
      "INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
      `otp_${stamp}`, `sign-in-otp-${owner}@example.com`, "123456:0", now, now, now,
      `ott_${stamp}`, `one-time-token:${stamp}`, `token_${stamp}`, now, now, now,
    )
    await run(
      "INSERT INTO deviceCode (id, deviceCode, userCode, userId, expiresAt, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      `device_${stamp}`, `device_code_${stamp}`, `user_code_${stamp}`, owner, now,
    )
    await run("INSERT INTO community_machine (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)", `machine_${stamp}`, owner, now, now)
    await run("INSERT INTO community_bot_binding (user_id, machine_id, runtime, instruction, created_at) VALUES (?, ?, 'codex', '', ?)", bot, `machine_${stamp}`, now)
    await run("INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES (?, ?, '8104', ?, ?)", server, server, owner, now)
    await run(
      "INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)",
      `server_member_${stamp}`, server, reader, now,
    )
    await run(
      "INSERT INTO community_channel (id, server_id, type, message_count, created_at) VALUES (?, ?, 'text', 0, ?)",
      serverChannel, server, now,
    )
    await run("INSERT INTO community_channel (id, type, message_count, last_message_at, created_at) VALUES (?, 'dm', 3, ?, ?)", dm, now, now)
    await run(
      "INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'prior', ?, ?, 1), (?, ?, 'authored', ?, ?, 2), (?, ?, 'bot authored', ?, ?, 3)",
      prior, reader, now, dm, authored, owner, now, dm, botAuthored, bot, now, dm,
    )
    await run(
      "INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq) VALUES (?, ?, ?, ?, ?, 3), (?, ?, ?, ?, ?, 1)",
      `read_${stamp}`, reader, dm, now, botAuthored,
      `read_early_${stamp}`, earlyReader, dm, now, prior,
    )
    await run(
      "INSERT INTO community_channel (id, type, message_count, last_message_at, created_at) VALUES (?, 'forum', 1, ?, ?)",
      forum, now, now,
    )
    await run(
      "INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'opener', ?, ?, 1)",
      opener, owner, now, forum,
    )
    await run(
      "INSERT INTO community_channel (id, type, parent_channel_id, parent_message_id, message_count, last_message_at, created_at) VALUES (?, 'thread', ?, ?, 1, ?, ?)",
      thread, forum, opener, now, now,
    )
    await run(
      "INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'reply', ?, ?, 1)",
      reply, reader, now, thread,
    )
    await run("INSERT INTO community_attachment(id,uploader_id,r2_key,filename,created_at) VALUES (?,?,?,'reply.txt',?),(?,?,?,'pending-server.txt',?),(?,?,?,'pending-thread.txt',?),(?,?,?,'forwarded.txt',?)",
      `attachment_${stamp}`, reader, threadAttachment, now,
      pendingServerAttachment, reader, pendingServerAttachmentKey, now,
      pendingThreadAttachment, reader, pendingThreadAttachmentKey, now,
      `forwarded_${stamp}`, owner, threadAttachment, now)
    await run("INSERT INTO community_message_attachment VALUES (?,?,0),(?,?,0),(?,?,0)", reply, `attachment_${stamp}`, authored, `forwarded_${stamp}`, prior, `forwarded_${stamp}`)

    const db = createDb(runtimeEnv.DB)
    const snapshot = await queries.accountDeletion.getAccountDeletionSnapshot(db, owner)
    expect(snapshot?.identities.map((row) => row.id).sort()).toEqual([bot, owner].sort())
    expect(snapshot?.media.communityExactKeys).not.toContain(threadAttachment)
    expect(snapshot?.media.communityExactKeys).not.toContain(pendingServerAttachmentKey)
    expect(snapshot?.media.communityExactKeys).not.toContain(pendingThreadAttachmentKey)
    const result = await queries.accountDeletion.deleteAccountRows(db, snapshot!)

    expect(result.deleted).toBe(true)
    expect(await first("SELECT id FROM user WHERE id IN (?, ?)", owner, bot)).toBeNull()
    expect(await first("SELECT id FROM community_server WHERE id = ?", server)).toBeNull()
    expect(await first("SELECT id FROM community_channel WHERE id = ?", thread)).toBeNull()
    expect(await first("SELECT id FROM community_attachment WHERE id = ?", `attachment_${stamp}`)).toBeNull()
    expect(await first("SELECT id FROM community_attachment WHERE id IN (?, ?)", pendingServerAttachment, pendingThreadAttachment)).not.toBeNull()
    expect(await first("SELECT id FROM community_attachment WHERE id = ?", `forwarded_${stamp}`)).not.toBeNull()
    expect(await first("SELECT attachment_id FROM community_message_attachment WHERE message_id = ?", prior)).toEqual({ attachment_id: `forwarded_${stamp}` })
    expect(await first("SELECT id FROM user WHERE id = ?", reader)).toEqual({ id: reader })
    expect(await first("SELECT id FROM deviceCode WHERE userId = ?", owner)).toBeNull()
    expect(await first("SELECT id FROM verification WHERE id IN (?, ?)", `otp_${stamp}`, `ott_${stamp}`)).toBeNull()
    expect(await first<{ message_count: number; last_message_at: string }>(
      "SELECT message_count, last_message_at FROM community_channel WHERE id = ?",
      dm,
    )).toEqual({ message_count: 1, last_message_at: now })
    expect(await first<{ last_read_message_id: string; last_read_seq: number }>(
      "SELECT last_read_message_id, last_read_seq FROM community_read_state WHERE user_id = ? AND channel_id = ?",
      reader,
      dm,
    )).toEqual({ last_read_message_id: prior, last_read_seq: 1 })
    expect(result.readStateRevisions.sort((left, right) => left.userId.localeCompare(right.userId)))
      .toEqual([
        { userId: earlyReader, revision: 1 },
        { userId: reader, revision: 1 },
      ].sort((left, right) => left.userId.localeCompare(right.userId)))
    expect(await first("SELECT revision FROM community_read_state_revision WHERE user_id = ?", reader))
      .toEqual({ revision: 1 })
    expect(await first<{ last_read_message_id: string; last_read_seq: number }>(
      "SELECT last_read_message_id, last_read_seq FROM community_read_state WHERE user_id = ? AND channel_id = ?",
      earlyReader,
      dm,
    )).toEqual({ last_read_message_id: prior, last_read_seq: 1 })
    expect(await first("SELECT revision FROM community_read_state_revision WHERE user_id = ?", earlyReader))
      .toEqual({ revision: 1 })
    expect(await runtimeEnv.DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] })
  })
})
