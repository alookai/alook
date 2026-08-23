/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"
import { deleteCommunityMediaObjects } from "../src/lib/community/community-media-cleanup"
import { persistUploadedBotAvatar } from "../src/lib/community/bot-avatar-persistence"
import { buildBotAvatarKey, botAvatarUrl } from "../src/lib/community/storage"

const runtimeEnv = env as unknown as CloudflareEnv
const createdUsers: string[] = []
const createdMachines: string[] = []
const mediaKeys: string[] = []
const bugReportKeys: string[] = []

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

async function seedOwner(): Promise<string> {
  const owner = `bac_owner_${crypto.randomUUID().replaceAll("-", "")}`
  createdUsers.push(owner)
  await run(
    "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, ?, ?)",
    owner,
    `${owner}@example.com`,
    owner,
    stamp4(owner),
  )
  return owner
}

async function seedMachine(ownerId: string): Promise<string> {
  const machine = `bac_machine_${crypto.randomUUID().replaceAll("-", "")}`
  createdMachines.push(machine)
  await run(
    `INSERT INTO community_machine
      (id, user_id, available_runtimes, created_at, updated_at)
      VALUES (?, ?, ?, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')`,
    machine,
    ownerId,
    JSON.stringify([{ id: "codex", status: "healthy" }]),
  )
  return machine
}

async function seedBot(
  ownerId: string,
  machineId: string,
  input: { image?: string | null; deletedAt?: string | null } = {},
): Promise<string> {
  const bot = `bac_bot_${crypto.randomUUID().replaceAll("-", "")}`
  createdUsers.push(bot)
  await run(
    `INSERT INTO user
      (id, email, name, discriminator, isBot, ownerUserId, image, deletedAt)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    bot,
    `${bot}@bots.alook.local`,
    bot,
    stamp4(bot),
    ownerId,
    input.image ?? null,
    input.deletedAt ?? null,
  )
  if (!input.deletedAt) {
    await run(
      `INSERT INTO community_bot_binding
        (user_id, machine_id, runtime, created_at)
        VALUES (?, ?, 'codex', '2026-08-24T00:00:00.000Z')`,
      bot,
      machineId,
    )
  }
  return bot
}

async function putMedia(key: string, value: string): Promise<void> {
  mediaKeys.push(key)
  await runtimeEnv.COMMUNITY_MEDIA.put(key, value)
}

afterEach(async () => {
  for (const key of mediaKeys.splice(0)) await runtimeEnv.COMMUNITY_MEDIA.delete(key)
  for (const key of bugReportKeys.splice(0)) await runtimeEnv.BUG_REPORTS.delete(key)
  for (const userId of createdUsers) {
    await runtimeEnv.DB.prepare("DELETE FROM community_bot_binding WHERE user_id = ?")
      .bind(userId)
      .run()
  }
  for (const machineId of createdMachines.splice(0)) {
    await runtimeEnv.DB.prepare("DELETE FROM community_machine WHERE id = ?")
      .bind(machineId)
      .run()
  }
  for (const userId of createdUsers.splice(0).reverse()) {
    await runtimeEnv.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId).run()
  }
})

describe("bot avatar query and winner semantics in real D1", () => {
  it("returns only live bot id/image and exactly one scoped soft-delete winner", async () => {
    const owner = await seedOwner()
    const otherOwner = await seedOwner()
    const machine = await seedMachine(owner)
    const canonicalBot = await seedBot(owner, machine, {
      image: "/api/community/bots/placeholder/avatar",
    })
    await run(
      "UPDATE user SET image = ? WHERE id = ?",
      botAvatarUrl(canonicalBot),
      canonicalBot,
    )
    const deletedBot = await seedBot(owner, machine, {
      image: "/api/community/bots/deleted/avatar",
      deletedAt: "2026-08-24T00:00:00.000Z",
    })
    const human = `bac_human_${crypto.randomUUID().replaceAll("-", "")}`
    createdUsers.push(human)
    await run(
      "INSERT INTO user (id, email, name, discriminator, image) VALUES (?, ?, ?, ?, ?)",
      human,
      `${human}@example.com`,
      human,
      stamp4(human),
      botAvatarUrl(human),
    )

    const db = createDb(runtimeEnv.DB)
    await expect(queries.communityBot.getLiveBotAvatar(db, canonicalBot)).resolves.toEqual({
      id: canonicalBot,
      image: botAvatarUrl(canonicalBot),
    })
    await expect(queries.communityBot.getLiveBotAvatar(db, deletedBot)).resolves.toBeNull()
    await expect(queries.communityBot.getLiveBotAvatar(db, human)).resolves.toBeNull()
    await expect(queries.communityBot.getLiveBotAvatar(db, "missing")).resolves.toBeNull()
    await expect(queries.communityBot.softDeleteBot(db, canonicalBot, otherOwner)).resolves.toBe(false)

    const results = await Promise.all([
      queries.communityBot.softDeleteBot(db, canonicalBot, owner),
      queries.communityBot.softDeleteBot(db, canonicalBot, owner),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    await expect(queries.communityBot.softDeleteBot(db, canonicalBot, owner)).resolves.toBe(false)
    await expect(queries.communityBot.getLiveBotAvatar(db, canonicalBot)).resolves.toBeNull()
  })
})

describe("bot avatar D1 to R2 containment in real workerd", () => {
  it("persists a live upload and deletes only the winning bot fixed key", async () => {
    const owner = await seedOwner()
    const machine = await seedMachine(owner)
    const bot = await seedBot(owner, machine)
    const unrelatedBot = await seedBot(owner, machine, { image: "avatar:beam-seed" })
    const botKey = buildBotAvatarKey(bot)
    const userKey = `user-avatar/${bot}`
    const unrelatedBotKey = buildBotAvatarKey(unrelatedBot)
    const attachmentKey = `channel/runtime/${bot}/attachment.png`
    const serverIconKey = `server-icon/runtime-${bot}/icon`
    const bugKey = `bug-reports/${owner}/runtime-${bot}.ndjson.gz`
    for (const [key, value] of [
      [botKey, "bot"],
      [userKey, "human"],
      [unrelatedBotKey, "other-bot"],
      [attachmentKey, "attachment"],
      [serverIconKey, "server-icon"],
    ] as const) {
      await putMedia(key, value)
    }
    bugReportKeys.push(bugKey)
    await runtimeEnv.BUG_REPORTS.put(bugKey, "diagnostic-sentinel")

    const db = createDb(runtimeEnv.DB)
    await expect(persistUploadedBotAvatar(db, runtimeEnv.COMMUNITY_MEDIA, {
      botId: bot,
      ownerId: owner,
    })).resolves.toEqual({ kind: "persisted" })
    expect((await first<{ image: string }>("SELECT image FROM user WHERE id = ?", bot))?.image)
      .toBe(botAvatarUrl(bot))

    const won = await queries.communityBot.softDeleteBot(db, bot, owner)
    expect(won).toBe(true)
    if (won) await deleteCommunityMediaObjects(runtimeEnv.COMMUNITY_MEDIA, [botKey])

    expect(await runtimeEnv.COMMUNITY_MEDIA.get(botKey)).toBeNull()
    await expect((await runtimeEnv.COMMUNITY_MEDIA.get(userKey))!.text()).resolves.toBe("human")
    await expect((await runtimeEnv.COMMUNITY_MEDIA.get(unrelatedBotKey))!.text()).resolves.toBe("other-bot")
    await expect((await runtimeEnv.COMMUNITY_MEDIA.get(attachmentKey))!.text()).resolves.toBe("attachment")
    await expect((await runtimeEnv.COMMUNITY_MEDIA.get(serverIconKey))!.text()).resolves.toBe("server-icon")
    await expect((await runtimeEnv.BUG_REPORTS.get(bugKey))!.text()).resolves.toBe("diagnostic-sentinel")
  })

  it("inline-compensates an upload whose live D1 update loses to delete", async () => {
    const owner = await seedOwner()
    const machine = await seedMachine(owner)
    const bot = await seedBot(owner, machine)
    const botKey = buildBotAvatarKey(bot)
    await queries.communityBot.softDeleteBot(createDb(runtimeEnv.DB), bot, owner)
    await putMedia(botKey, "late-upload")

    await expect(persistUploadedBotAvatar(createDb(runtimeEnv.DB), runtimeEnv.COMMUNITY_MEDIA, {
      botId: bot,
      ownerId: owner,
    })).resolves.toEqual({ kind: "not_found" })
    expect(await runtimeEnv.COMMUNITY_MEDIA.get(botKey)).toBeNull()
  })
})
