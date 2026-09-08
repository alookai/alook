/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

const runtimeEnv = env as unknown as CloudflareEnv
const survivors: string[] = []
const survivingChannels: string[] = []
const survivingWorkspaces: string[] = []

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
  for (const workspaceId of survivingWorkspaces.splice(0)) {
    await run("DELETE FROM workspace WHERE id = ?", workspaceId)
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
    const workspace = `adm_workspace_${stamp}`
    const sharedWorkspace = `adm_shared_workspace_${stamp}`
    const daemon = `adm_daemon_${stamp}`
    const ownerMachineToken = `al_owner_${stamp}`
    const workspaceMachineToken = `al_workspace_${stamp}`
    const runtime = `adm_runtime_${stamp}`
    const survivingAgent = `adm_surviving_agent_${stamp}`
    const ownedSharedAgent = `adm_owned_shared_agent_${stamp}`
    const deletingEmail = `adm_deleting_email_${stamp}`
    const survivingEmail = `adm_surviving_email_${stamp}`
    const sharedDraftKey = `emails/drafts/${stamp}/shared.txt`
    const privateDraftKey = `emails/drafts/${stamp}/private.txt`
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
    survivingWorkspaces.push(sharedWorkspace)

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
    await run(
      "INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES (?, 'Owned', ?, ?, ?), (?, 'Shared', ?, ?, ?)",
      workspace, workspace, now, now, sharedWorkspace, sharedWorkspace, now, now,
    )
    await run(
      "INSERT INTO member (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?), (?, ?, ?, 'owner', ?), (?, ?, ?, 'owner', ?), (?, ?, ?, 'member', ?)",
      `member_owner_${stamp}`, workspace, owner, now,
      `member_coowner_${stamp}`, workspace, reader, now,
      `member_shared_owner_${stamp}`, sharedWorkspace, reader, now,
      `member_shared_user_${stamp}`, sharedWorkspace, owner, now,
    )
    await run(
      "INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, ?, ?, 'Owner token', 'active', ?), (?, ?, ?, ?, 'Workspace token', 'active', ?)",
      `machine_token_owner_${stamp}`, owner, sharedWorkspace, ownerMachineToken, now,
      `machine_token_workspace_${stamp}`, reader, workspace, workspaceMachineToken, now,
    )
    await run("INSERT INTO agent (id, workspace_id, name, owner_id, created_at, updated_at) VALUES (?, ?, 'Owned agent', ?, ?, ?)", `agent_${stamp}`, workspace, owner, now, now)
    await run(
      "INSERT INTO machine (daemon_id, workspace_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      daemon, sharedWorkspace, owner, now, now,
    )
    await run(
      "INSERT INTO agent_runtime (id, workspace_id, daemon_id, provider, created_at, updated_at) VALUES (?, ?, ?, 'codex', ?, ?)",
      runtime, sharedWorkspace, daemon, now, now,
    )
    await run(
      "INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, 'Survivor', ?, ?, ?, ?), (?, ?, 'Owned in shared', NULL, ?, ?, ?)",
      survivingAgent, sharedWorkspace, runtime, reader, now, now,
      ownedSharedAgent, sharedWorkspace, owner, now, now,
    )
    await run(
      "INSERT INTO emails (id, agent_id, workspace_id, from_email, to_email, r2_key, attachments, created_at) VALUES (?, ?, ?, 'owner@example.com', 'x@example.com', ?, ?, ?), (?, ?, ?, 'reader@example.com', 'x@example.com', ?, ?, ?)",
      deletingEmail, `agent_${stamp}`, workspace, `emails/${deletingEmail}/raw`, JSON.stringify([
        { key: sharedDraftKey },
        { key: privateDraftKey },
      ]), now,
      survivingEmail, survivingAgent, sharedWorkspace, `emails/${survivingEmail}/raw`, JSON.stringify([
        { key: sharedDraftKey },
      ]), now,
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
    await run(
      "INSERT INTO community_attachment (id, message_id, uploader_id, target_id, r2_key, filename, position, created_at) VALUES (?, ?, ?, ?, ?, 'reply.txt', 0, ?), (?, NULL, ?, ?, ?, 'pending-server.txt', 0, ?), (?, NULL, ?, ?, ?, 'pending-thread.txt', 0, ?)",
      `attachment_${stamp}`, reply, reader, thread, threadAttachment, now,
      pendingServerAttachment, reader, serverChannel, pendingServerAttachmentKey, now,
      pendingThreadAttachment, reader, thread, pendingThreadAttachmentKey, now,
    )

    const db = createDb(runtimeEnv.DB)
    const snapshot = await queries.accountDeletion.getAccountDeletionSnapshot(db, owner)
    expect(snapshot?.identities.map((row) => row.id).sort()).toEqual([bot, owner].sort())
    expect(snapshot?.ownedWorkspaceIds).toEqual([workspace])
    expect(snapshot?.ownedAgentIds.sort()).toEqual([`agent_${stamp}`, ownedSharedAgent].sort())
    expect(snapshot?.machineTokens.sort()).toEqual([ownerMachineToken, workspaceMachineToken].sort())
    expect(snapshot?.media.communityExactKeys).toContain(threadAttachment)
    expect(snapshot?.media.communityExactKeys).toContain(pendingServerAttachmentKey)
    expect(snapshot?.media.communityExactKeys).toContain(pendingThreadAttachmentKey)
    expect(snapshot?.media.deletingEmailAttachments).toContain(JSON.stringify([
      { key: sharedDraftKey },
      { key: privateDraftKey },
    ]))
    expect(snapshot?.media.survivingEmailAttachments).toContain(JSON.stringify([
      { key: sharedDraftKey },
    ]))
    const result = await queries.accountDeletion.deleteAccountRows(db, snapshot!)

    expect(result.deleted).toBe(true)
    expect(await first("SELECT id FROM user WHERE id IN (?, ?)", owner, bot)).toBeNull()
    expect(await first("SELECT id FROM workspace WHERE id = ?", workspace)).toBeNull()
    expect(await first("SELECT id FROM workspace WHERE id = ?", sharedWorkspace)).toEqual({ id: sharedWorkspace })
    expect(await first("SELECT id FROM machine_token WHERE token IN (?, ?)", ownerMachineToken, workspaceMachineToken)).toBeNull()
    expect(await first("SELECT id FROM agent WHERE id = ?", ownedSharedAgent)).toBeNull()
    expect(await first<{ id: string; runtime_id: string | null }>(
      "SELECT id, runtime_id FROM agent WHERE id = ?",
      survivingAgent,
    )).toEqual({ id: survivingAgent, runtime_id: null })
    expect(await first("SELECT id FROM agent_runtime WHERE id = ?", runtime)).toBeNull()
    expect(await first("SELECT daemon_id FROM machine WHERE daemon_id = ? AND workspace_id = ?", daemon, sharedWorkspace)).toBeNull()
    expect(await first("SELECT id FROM emails WHERE id = ?", deletingEmail)).toBeNull()
    expect(await first("SELECT id FROM emails WHERE id = ?", survivingEmail)).toEqual({ id: survivingEmail })
    expect(await first("SELECT id FROM community_server WHERE id = ?", server)).toBeNull()
    expect(await first("SELECT id FROM community_channel WHERE id = ?", thread)).toBeNull()
    expect(await first("SELECT id FROM community_attachment WHERE id = ?", `attachment_${stamp}`)).toBeNull()
    expect(await first("SELECT id FROM community_attachment WHERE id IN (?, ?)", pendingServerAttachment, pendingThreadAttachment)).toBeNull()
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
