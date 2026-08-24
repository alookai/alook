/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

const runtimeEnv = env as unknown as CloudflareEnv
const createdServers: string[] = []
const createdUsers: string[] = []

async function run(statement: string, ...bindings: unknown[]): Promise<void> {
  await runtimeEnv.DB.prepare(statement).bind(...bindings).run()
}

async function first<T>(statement: string, ...bindings: unknown[]): Promise<T | null> {
  return runtimeEnv.DB.prepare(statement).bind(...bindings).first<T>()
}

function stamp4(value: string): string {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 10_000
  return String(hash).padStart(4, "0")
}

async function seedOwnerAndServer(icon: string | null = null) {
  const stamp = crypto.randomUUID().replaceAll("-", "")
  const owner = `cdm_owner_${stamp}`
  const server = `cdm_server_${stamp}`
  createdUsers.push(owner)
  createdServers.push(server)
  await run(
    "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', ?)",
    owner,
    `${owner}@example.com`,
    stamp4(owner),
  )
  await run(
    "INSERT INTO community_server (id, name, description, icon, owner_id, discriminator, created_at) VALUES (?, ?, '', ?, ?, ?, '2026-08-23T00:00:00.000Z')",
    server,
    server,
    icon,
    owner,
    stamp4(server),
  )
  return { owner, server, stamp }
}

afterEach(async () => {
  for (const serverId of createdServers.splice(0)) {
    await runtimeEnv.DB.prepare("DELETE FROM community_server WHERE id = ?").bind(serverId).run()
  }
  for (const userId of createdUsers.splice(0)) {
    await runtimeEnv.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId).run()
  }
})

describe("existing delete media real D1 batches", () => {
  it("channel deletion snapshots root/child linked and pending keys for exactly one winner", async () => {
    const { owner, server, stamp } = await seedOwnerAndServer()
    const root = `cdm_root_${stamp}`
    const child = `cdm_child_${stamp}`
    const unrelated = `cdm_other_${stamp}`
    const rootMessage = `cdm_rm_${stamp}`
    const childMessage = `cdm_cm_${stamp}`
    const unrelatedMessage = `cdm_um_${stamp}`
    await run(
      `INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES
        (?, ?, 'root', 'text', '2026-08-23T00:00:00.000Z'),
        (?, ?, 'child', 'thread', '2026-08-23T00:00:00.000Z'),
        (?, ?, 'other', 'text', '2026-08-23T00:00:00.000Z')`,
      root, server,
      child, server,
      unrelated, server,
    )
    await run("UPDATE community_channel SET parent_channel_id = ? WHERE id = ?", root, child)
    await run(
      `INSERT INTO community_message (id, author_id, content, channel_id, seq, created_at) VALUES
        (?, ?, 'root', ?, 1, '2026-08-23T00:00:00.000Z'),
        (?, ?, 'child', ?, 1, '2026-08-23T00:00:00.000Z'),
        (?, ?, 'other', ?, 1, '2026-08-23T00:00:00.000Z')`,
      rootMessage, owner, root,
      childMessage, owner, child,
      unrelatedMessage, owner, unrelated,
    )
    await run(
      `INSERT INTO community_attachment
        (id, message_id, uploader_id, target_id, r2_key, thumbnail_r2_key, filename, created_at) VALUES
        (?, ?, ?, ?, 'root/original', 'root/thumb', 'root.png', '2026-08-23T00:00:00.000Z'),
        (?, ?, ?, ?, 'child/original', 'child/thumb', 'child.png', '2026-08-23T00:00:00.000Z'),
        (?, NULL, ?, ?, 'root/pending', 'root/pending-thumb', 'pending-root.png', '2026-08-23T00:00:00.000Z'),
        (?, NULL, ?, ?, 'child/pending', NULL, 'pending-child.png', '2026-08-23T00:00:00.000Z'),
        (?, ?, ?, ?, 'other/original', 'other/thumb', 'other.png', '2026-08-23T00:00:00.000Z')`,
      `att_root_${stamp}`, rootMessage, owner, unrelated,
      `att_child_${stamp}`, childMessage, owner, unrelated,
      `att_pending_root_${stamp}`, owner, root,
      `att_pending_child_${stamp}`, owner, child,
      `att_other_${stamp}`, unrelatedMessage, owner, unrelated,
    )
    await run(
      `INSERT INTO community_read_state
        (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq) VALUES
        (?, ?, ?, '2026-08-23T00:00:00.000Z', ?, 1),
        (?, ?, ?, '2026-08-23T00:00:00.000Z', ?, 1),
        (?, ?, ?, '2026-08-23T00:00:00.000Z', ?, 1)`,
      `rs_root_${stamp}`, owner, root, rootMessage,
      `rs_child_${stamp}`, owner, child, childMessage,
      `rs_other_${stamp}`, owner, unrelated, unrelatedMessage,
    )

    const db = createDb(runtimeEnv.DB)
    const results = await Promise.all([
      queries.communityDeleteMedia.deleteChannelWithMedia(db, { channelId: root, serverId: server }),
      queries.communityDeleteMedia.deleteChannelWithMedia(db, { channelId: root, serverId: server }),
    ])

    expect(results.filter((result) => result.deleted)).toHaveLength(1)
    const winner = results.find((result) => result.deleted)!
    expect(new Set(winner.mediaKeys)).toEqual(new Set([
      "root/original", "root/thumb", "child/original", "child/thumb",
      "root/pending", "root/pending-thumb", "child/pending",
    ]))
    expect(winner.readStateSnapshots).toEqual([{
      userId: owner,
      revision: 1,
      readStates: [{
        channelId: unrelated,
        lastReadMessageId: unrelatedMessage,
        lastReadAt: "2026-08-23T00:00:00.000Z",
        lastReadSeq: 1,
      }],
    }])
    expect(results.find((result) => !result.deleted)?.mediaKeys).toEqual([])
    expect(await first("SELECT id FROM community_channel WHERE id = ?", root)).toBeNull()
    expect(await first("SELECT id FROM community_channel WHERE id = ?", child)).toBeNull()
    expect(await first("SELECT id FROM community_attachment WHERE id = ?", `att_pending_child_${stamp}`)).toBeNull()
    expect(await first("SELECT id FROM community_attachment WHERE id = ?", `att_other_${stamp}`)).not.toBeNull()
  })

  it("server deletion is owner-scoped and returns attachment keys plus the winner icon once", async () => {
    const icon = "server-icon/runtime/icon-a"
    const { owner, server, stamp } = await seedOwnerAndServer(icon)
    const channel = `cdm_server_channel_${stamp}`
    const message = `cdm_server_message_${stamp}`
    await run(
      "INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES (?, ?, 'all', 'text', '2026-08-23T00:00:00.000Z')",
      channel, server,
    )
    await run(
      "INSERT INTO community_message (id, author_id, content, channel_id, seq, created_at) VALUES (?, ?, 'hello', ?, 1, '2026-08-23T00:00:00.000Z')",
      message, owner, channel,
    )
    await run(
      `INSERT INTO community_attachment
        (id, message_id, uploader_id, target_id, r2_key, thumbnail_r2_key, filename, created_at) VALUES
        (?, ?, ?, ?, 'server/original', 'server/thumb', 'linked.png', '2026-08-23T00:00:00.000Z'),
        (?, NULL, ?, ?, 'server/pending', NULL, 'pending.png', '2026-08-23T00:00:00.000Z')`,
      `att_server_${stamp}`, message, owner, channel,
      `att_server_pending_${stamp}`, owner, channel,
    )
    await run(
      `INSERT INTO community_read_state
        (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
       VALUES (?, ?, ?, '2026-08-23T00:00:00.000Z', ?, 1)`,
      `rs_server_${stamp}`, owner, channel, message,
    )

    const db = createDb(runtimeEnv.DB)
    await expect(queries.communityDeleteMedia.deleteServerWithMedia(db, {
      serverId: server,
      ownerId: "not-owner",
    })).resolves.toEqual({ deleted: false, mediaKeys: [], iconKey: null, readStateSnapshots: [] })

    const results = await Promise.all([
      queries.communityDeleteMedia.deleteServerWithMedia(db, { serverId: server, ownerId: owner }),
      queries.communityDeleteMedia.deleteServerWithMedia(db, { serverId: server, ownerId: owner }),
    ])
    expect(results.filter((result) => result.deleted)).toHaveLength(1)
    expect(results.find((result) => result.deleted)).toEqual({
      deleted: true,
      mediaKeys: ["server/original", "server/thumb", "server/pending"],
      iconKey: icon,
      readStateSnapshots: [{ userId: owner, revision: 1, readStates: [] }],
    })
    expect(results.find((result) => !result.deleted)).toEqual({
      deleted: false,
      mediaKeys: [],
      iconKey: null,
      readStateSnapshots: [],
    })
    expect(await first("SELECT id FROM community_server WHERE id = ?", server)).toBeNull()
  })
})

describe("guarded pending insert and server icon CAS in real D1", () => {
  it("accepts a live DM target with type=dm and server_id NULL", async () => {
    const { owner, stamp } = await seedOwnerAndServer()
    const dm = `cdm_dm_${stamp}`
    const attachment = `att_dm_${stamp}`
    await run(
      "INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES (?, NULL, NULL, 'dm', '2026-08-23T00:00:00.000Z')",
      dm,
    )

    const db = createDb(runtimeEnv.DB)
    await expect(queries.communityAttachment.createPendingAttachment(db, {
      id: attachment,
      uploaderId: owner,
      targetId: dm,
      r2Key: "pending/dm-live",
      filename: "dm-live.png",
    })).resolves.toMatchObject({ id: attachment, targetId: dm, messageId: null })
    expect(await first("SELECT id FROM community_attachment WHERE id = ?", attachment)).not.toBeNull()

    await run("DELETE FROM community_attachment WHERE id = ?", attachment)
    await run("DELETE FROM community_channel WHERE id = ?", dm)
  })

  it("inserts only while the target channel exists", async () => {
    const { owner, server, stamp } = await seedOwnerAndServer()
    const channel = `cdm_pending_${stamp}`
    await run(
      "INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES (?, ?, 'pending', 'text', '2026-08-23T00:00:00.000Z')",
      channel, server,
    )
    const db = createDb(runtimeEnv.DB)
    const inserted = await queries.communityAttachment.createPendingAttachment(db, {
      id: `att_live_${stamp}`,
      uploaderId: owner,
      targetId: channel,
      r2Key: "pending/live",
      thumbnailR2Key: "pending/live-thumb",
      filename: "live.png",
    })
    expect(inserted.targetId).toBe(channel)

    await queries.communityDeleteMedia.deleteChannelWithMedia(db, {
      channelId: channel,
      serverId: server,
    })
    await expect(queries.communityAttachment.createPendingAttachment(db, {
      id: `att_deleted_${stamp}`,
      uploaderId: owner,
      targetId: channel,
      r2Key: "pending/deleted",
      filename: "deleted.png",
    })).rejects.toThrow("attachment target no longer exists")
    expect(await first("SELECT id FROM community_attachment WHERE id = ?", `att_deleted_${stamp}`)).toBeNull()
  })

  it("uses a null-safe old-value CAS with exactly one concurrent winner", async () => {
    const { server } = await seedOwnerAndServer(null)
    const db = createDb(runtimeEnv.DB)
    const contenders = await Promise.all([
      queries.communityServer.updateServerIconIfCurrent(db, {
        serverId: server,
        expectedIcon: null,
        nextIcon: `server-icon/${server}/b`,
      }),
      queries.communityServer.updateServerIconIfCurrent(db, {
        serverId: server,
        expectedIcon: null,
        nextIcon: `server-icon/${server}/c`,
      }),
    ])
    expect(contenders.filter(Boolean)).toHaveLength(1)
    const live = await first<{ icon: string }>("SELECT icon FROM community_server WHERE id = ?", server)
    expect([`server-icon/${server}/b`, `server-icon/${server}/c`]).toContain(live?.icon)

    await expect(queries.communityServer.updateServerIconIfCurrent(db, {
      serverId: server,
      expectedIcon: null,
      nextIcon: `server-icon/${server}/stale`,
    })).resolves.toBeNull()
    await expect(queries.communityServer.updateServerIconIfCurrent(db, {
      serverId: server,
      expectedIcon: live!.icon,
      nextIcon: `server-icon/${server}/next`,
    })).resolves.toMatchObject({ icon: `server-icon/${server}/next` })
  })

  it("linearizes icon replacement before server deletion at the CAS", async () => {
    const { owner, server } = await seedOwnerAndServer(`server-icon/runtime/${crypto.randomUUID()}`)
    const db = createDb(runtimeEnv.DB)
    const replacement = `server-icon/${server}/replacement`

    await expect(queries.communityServer.updateServerIconIfCurrent(db, {
      serverId: server,
      expectedIcon: (await first<{ icon: string }>(
        "SELECT icon FROM community_server WHERE id = ?",
        server,
      ))!.icon,
      nextIcon: replacement,
    })).resolves.toMatchObject({ icon: replacement })

    await expect(queries.communityDeleteMedia.deleteServerWithMedia(db, {
      serverId: server,
      ownerId: owner,
    })).resolves.toEqual({ deleted: true, mediaKeys: [], iconKey: replacement, readStateSnapshots: [] })
  })

  it("linearizes server deletion before a stale icon replacement at the delete", async () => {
    const original = `server-icon/runtime/${crypto.randomUUID()}`
    const { owner, server } = await seedOwnerAndServer(original)
    const db = createDb(runtimeEnv.DB)

    await expect(queries.communityDeleteMedia.deleteServerWithMedia(db, {
      serverId: server,
      ownerId: owner,
    })).resolves.toEqual({ deleted: true, mediaKeys: [], iconKey: original, readStateSnapshots: [] })
    await expect(queries.communityServer.updateServerIconIfCurrent(db, {
      serverId: server,
      expectedIcon: original,
      nextIcon: `server-icon/${server}/stale-replacement`,
    })).resolves.toBeNull()
  })
})
