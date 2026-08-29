/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"
import { cleanupAvatarCandidate } from "../src/lib/community/avatar-media-reconciliation"
import {
  buildUserAvatarObjectKey,
  userAvatarUrl,
} from "../src/lib/community/storage"

const runtimeEnv = env as unknown as CloudflareEnv
const users: string[] = []
const mediaKeys: string[] = []

function stamp4(value: string): string {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 10_000
  return String(hash).padStart(4, "0")
}

async function seedHuman(image: string | null = null): Promise<string> {
  const id = `vai_user_${crypto.randomUUID().replaceAll("-", "")}`
  users.push(id)
  await runtimeEnv.DB.prepare(
    "INSERT INTO user (id, email, name, discriminator, image) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, `${id}@example.com`, id, stamp4(id), image).run()
  return id
}

afterEach(async () => {
  for (const key of mediaKeys.splice(0)) await runtimeEnv.COMMUNITY_MEDIA.delete(key)
  for (const id of users.splice(0).reverse()) {
    await runtimeEnv.DB.prepare("DELETE FROM user WHERE id = ?").bind(id).run()
  }
})

describe("versioned human avatar publication in real D1/R2", () => {
  it("keeps legacy/external rows at the migration default until first publish", async () => {
    const external = "https://images.example.test/avatar.png"
    const userId = await seedHuman(external)
    const db = createDb(runtimeEnv.DB)

    await expect(queries.user.getLiveHumanAvatarState(db, userId)).resolves.toEqual({
      id: userId,
      image: external,
      avatarVersion: 0,
      avatarObjectKey: null,
    })

    const objectKey = buildUserAvatarObjectKey(userId, "first")
    await expect(queries.user.publishHumanAvatar(db, userId, {
      objectKey,
      stableUrl: userAvatarUrl(userId),
    })).resolves.toEqual({
      previous: {
        id: userId,
        image: external,
        avatarVersion: 0,
        avatarObjectKey: null,
      },
      current: {
        id: userId,
        image: userAvatarUrl(userId),
        avatarVersion: 1,
        avatarObjectKey: objectKey,
      },
    })
  })

  it("serializes concurrent publishes and deletes only the displaced child after reread", async () => {
    const userId = await seedHuman()
    const db = createDb(runtimeEnv.DB)
    const firstKey = buildUserAvatarObjectKey(userId, "concurrent-a")
    const secondKey = buildUserAvatarObjectKey(userId, "concurrent-b")
    for (const key of [firstKey, secondKey]) {
      mediaKeys.push(key)
      await runtimeEnv.COMMUNITY_MEDIA.put(key, key)
    }

    const outcomes = await Promise.all([
      queries.user.publishHumanAvatar(db, userId, {
        objectKey: firstKey,
        stableUrl: userAvatarUrl(userId),
      }),
      queries.user.publishHumanAvatar(db, userId, {
        objectKey: secondKey,
        stableUrl: userAvatarUrl(userId),
      }),
    ])
    expect(outcomes.every(Boolean)).toBe(true)
    expect(outcomes.map((outcome) => outcome!.current.avatarVersion).sort())
      .toEqual([1, 2])

    const current = await queries.user.getLiveHumanAvatarState(db, userId)
    expect(current?.avatarVersion).toBe(2)
    expect([firstKey, secondKey]).toContain(current?.avatarObjectKey)
    const displaced = current?.avatarObjectKey === firstKey ? secondKey : firstKey

    await expect(cleanupAvatarCandidate(
      db,
      runtimeEnv.COMMUNITY_MEDIA,
      { kind: "human", id: userId },
      current?.avatarObjectKey,
    )).resolves.toBe("retained_current")
    await expect(cleanupAvatarCandidate(
      db,
      runtimeEnv.COMMUNITY_MEDIA,
      { kind: "human", id: userId },
      displaced,
    )).resolves.toBe("deleted")
    expect(await runtimeEnv.COMMUNITY_MEDIA.get(displaced)).toBeNull()
    expect(await runtimeEnv.COMMUNITY_MEDIA.get(current!.avatarObjectKey!)).not.toBeNull()
  })
})
