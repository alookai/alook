/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

const runtimeEnv = env as unknown as CloudflareEnv
const createdServers: string[] = []
const createdUsers: string[] = []
const createdTriggers: string[] = []
const createdCounterTables: string[] = []

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

type Fixture = {
  userId: string
  serverId: string
  prefix: string
  channelIds: string[]
  messageIds: string[]
}

async function seedNonEmptyChannels(count: number): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "")
  const prefix = `readall_${suffix}`
  const userId = `${prefix}_user`
  const serverId = `${prefix}_server`
  const createdAt = "2026-08-28T01:00:00.000Z"
  const channelIds = Array.from({ length: count }, (_, index) =>
    `${prefix}_channel_${String(index).padStart(3, "0")}`,
  )
  const messageIds = channelIds.map((_, index) =>
    `${prefix}_message_${String(index).padStart(3, "0")}`,
  )

  createdUsers.push(userId)
  createdServers.push(serverId)
  await run(
    "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Reader', ?)",
    userId,
    `${userId}@example.com`,
    stamp4(userId),
  )
  await run(
    `INSERT INTO community_server
      (id, name, description, owner_id, created_at, discriminator)
     VALUES (?, ?, '', ?, ?, ?)`,
    serverId,
    serverId,
    userId,
    createdAt,
    stamp4(serverId),
  )

  const statements = channelIds.flatMap((channelId, index) => [
    runtimeEnv.DB.prepare(
      `INSERT INTO community_channel
        (id, server_id, name, type, message_count, last_message_at, created_at)
       VALUES (?, ?, ?, 'text', 1, ?, ?)`,
    ).bind(channelId, serverId, `channel-${index}`, createdAt, createdAt),
    runtimeEnv.DB.prepare(
      `INSERT INTO community_message
        (id, author_id, content, created_at, channel_id, seq)
       VALUES (?, ?, 'latest', ?, ?, ?)`,
    ).bind(messageIds[index]!, userId, createdAt, channelId, index + 1),
  ])
  for (let offset = 0; offset < statements.length; offset += 60) {
    await runtimeEnv.DB.batch(statements.slice(offset, offset + 60))
  }

  return { userId, serverId, prefix, channelIds, messageIds }
}

async function readRevision(userId: string): Promise<number> {
  return (await first<{ revision: number }>(
    "SELECT revision FROM community_read_state_revision WHERE user_id = ?",
    userId,
  ))?.revision ?? 0
}

async function readStateSummary(fixture: Fixture) {
  return first<{ total: number; aligned: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN rs.last_read_message_id = m.id
                       AND rs.last_read_at = m.created_at
                       AND rs.last_read_seq = m.seq
                     THEN 1 ELSE 0 END) AS aligned
       FROM community_read_state rs
       JOIN community_message m ON m.id = rs.last_read_message_id
      WHERE rs.user_id = ? AND rs.channel_id LIKE ?`,
    fixture.userId,
    `${fixture.prefix}_channel_%`,
  )
}

afterEach(async () => {
  for (const trigger of createdTriggers.splice(0)) {
    await runtimeEnv.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run()
  }
  for (const table of createdCounterTables.splice(0)) {
    await runtimeEnv.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run()
  }
  for (const serverId of createdServers.splice(0)) {
    await runtimeEnv.DB.prepare("DELETE FROM community_server WHERE id = ?").bind(serverId).run()
  }
  for (const userId of createdUsers.splice(0)) {
    await runtimeEnv.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId).run()
  }
})

describe("markAllServerChannelsRead real D1 bind limit", () => {
  it.each([33, 95])("marks %i non-empty channels and makes retry a revision no-op", async (count) => {
    const fixture = await seedNonEmptyChannels(count)
    const db = createDb(runtimeEnv.DB)

    await expect(
      queries.communityReadState.markAllServerChannelsRead(db, fixture.userId, fixture.channelIds),
    ).resolves.toEqual({ count, changed: true, revision: 1 })
    expect(await readStateSummary(fixture)).toEqual({ total: count, aligned: count })

    await expect(
      queries.communityReadState.markAllServerChannelsRead(db, fixture.userId, fixture.channelIds),
    ).resolves.toEqual({ count, changed: false, revision: 1 })
    expect(await readRevision(fixture.userId)).toBe(1)
    expect(await readStateSummary(fixture)).toEqual({ total: count, aligned: count })
  })

  it("bumps once for a mixed 95-target advance, then stays stable on retry", async () => {
    const fixture = await seedNonEmptyChannels(95)
    const db = createDb(runtimeEnv.DB)
    await queries.communityReadState.markAllServerChannelsRead(db, fixture.userId, fixture.channelIds)

    const advancedAt = "2026-08-28T02:00:00.000Z"
    for (const index of [0, 9, 94]) {
      const messageId = `${fixture.prefix}_advanced_${index}`
      await run(
        `INSERT INTO community_message
          (id, author_id, content, created_at, channel_id, seq)
         VALUES (?, ?, 'advanced', ?, ?, ?)`,
        messageId,
        fixture.userId,
        advancedAt,
        fixture.channelIds[index],
        1_000 + index,
      )
    }

    await expect(
      queries.communityReadState.markAllServerChannelsRead(db, fixture.userId, fixture.channelIds),
    ).resolves.toEqual({ count: 95, changed: true, revision: 2 })
    expect(await readRevision(fixture.userId)).toBe(2)
    expect(await readStateSummary(fixture)).toEqual({ total: 95, aligned: 95 })

    await expect(
      queries.communityReadState.markAllServerChannelsRead(db, fixture.userId, fixture.channelIds),
    ).resolves.toEqual({ count: 95, changed: false, revision: 2 })
    expect(await readRevision(fixture.userId)).toBe(2)
  })

  it("rolls back the revision and earlier rows when a later upsert fails", async () => {
    const fixture = await seedNonEmptyChannels(5)
    const db = createDb(runtimeEnv.DB)
    const suffix = crypto.randomUUID().replaceAll("-", "")
    const counterTable = `readall_counter_${suffix}`
    const trigger = `readall_abort_${suffix}`
    createdCounterTables.push(counterTable)
    createdTriggers.push(trigger)
    await runtimeEnv.DB.prepare(`CREATE TABLE ${counterTable} (attempts INTEGER NOT NULL)`).run()
    await runtimeEnv.DB.prepare(`INSERT INTO ${counterTable} (attempts) VALUES (0)`).run()
    await runtimeEnv.DB.prepare(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON community_read_state
      BEGIN
        UPDATE ${counterTable} SET attempts = attempts + 1;
        SELECT CASE WHEN (SELECT attempts FROM ${counterTable}) = 3
          THEN RAISE(ABORT, 'forced read-state failure') END;
      END
    `).run()

    await expect(
      queries.communityReadState.markAllServerChannelsRead(db, fixture.userId, fixture.channelIds),
    ).rejects.toThrow(/forced read-state failure/)

    expect(await readRevision(fixture.userId)).toBe(0)
    expect(await readStateSummary(fixture)).toEqual({ total: 0, aligned: null })
    expect(await first<{ attempts: number }>(`SELECT attempts FROM ${counterTable}`)).toEqual({ attempts: 0 })
  })
})
