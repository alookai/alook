import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as coreSchema from "../../schema"
import * as communitySchema from "../../community-schema"
import * as machineSchema from "../../community-machine-schema"
import * as webhookSchema from "../../community-bot-webhook-schema"
import type { Database } from "../../index"
import {
  createBotWebhook,
  createBotWebhookDelivery,
  deleteBotWebhook,
  getBotWebhookById,
  getBotWebhookByTokenHash,
  listBotWebhookDeliveries,
  listBotWebhooks,
  listPendingBotWebhookDeliveriesForBot,
  updateBotWebhook,
  updateBotWebhookDeliveryStatus,
} from "./bot-webhook"
import { BOT_WEBHOOK_DELIVERY_RETENTION, BOT_WEBHOOK_MAX_PER_BOT } from "../../../bot-webhook"

const schema = { ...coreSchema, ...communitySchema, ...machineSchema, ...webhookSchema }
const migrationsDir = resolve(import.meta.dirname, "../../../../../web/migrations")

function createMigratedSqlite(): Sqlite.Database {
  const sqlite = new Sqlite(":memory:")
  sqlite.pragma("foreign_keys = ON")
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
  for (const file of files) {
    sqlite.exec(readFileSync(resolve(migrationsDir, file), "utf8"))
  }
  return sqlite
}

describe("community bot webhook D1 queries", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = createMigratedSqlite()
    db = drizzle(sqlite, { schema }) as unknown as Database
    const nowIso = "2026-11-27T00:00:00.000Z"
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("owner_1", "gus", "gus@test.local", nowIso, nowIso, 0, null, "1813")
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("bot_1", "Claudette", "bot1@test.local", nowIso, nowIso, 1, "owner_1", "5211")
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("owner_2", "other", "other@test.local", nowIso, nowIso, 0, null, "9999")
  })

  afterEach(() => sqlite.close())

  it("supports CRUD, owner isolation, dedup, retention pruning, pending resync, and index usage", async () => {
    const baseMs = Date.parse("2026-11-27T08:00:00.000Z")
    const created = await createBotWebhook(db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "GitHub CI",
      provider: "github",
      tokenHash: "hash_1",
      signingSecretEnc: "v1:aa:bb",
      eventFilter: ["workflow_run", "pull_request"],
      instruction: "Investigate failures",
      nowMs: baseMs,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(await getBotWebhookById(db, "owner_2", "bot_1", created.webhook.id)).toBeNull()
    expect(await deleteBotWebhook(db, "owner_2", "bot_1", created.webhook.id)).toBe(false)
    expect((await getBotWebhookByTokenHash(db, "hash_1"))?.id).toBe(created.webhook.id)

    const d1 = await createBotWebhookDelivery(db, {
      webhookId: created.webhook.id,
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      externalDeliveryId: "gh-1",
      eventType: "workflow_run.completed",
      summary: "CI Gate failure",
      promptText: "prompt 1",
      status: "pending",
      nowMs: baseMs + 1000,
    })
    expect(d1.inserted).toBe(true)

    const d1Dup = await createBotWebhookDelivery(db, {
      webhookId: created.webhook.id,
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      externalDeliveryId: "gh-1",
      eventType: "workflow_run.completed",
      summary: "CI Gate failure",
      promptText: "prompt 1",
      status: "pending",
      nowMs: baseMs + 2000,
    })
    expect(d1Dup.inserted).toBe(false)
    expect(d1Dup.delivery.id).toBe(d1.delivery.id)

    const pending = await listPendingBotWebhookDeliveriesForBot(db, "bot_1", {
      sinceMs: baseMs,
      limit: 20,
    })
    expect(pending.map((row) => row.id)).toEqual([d1.delivery.id])

    const dispatched = await updateBotWebhookDeliveryStatus(db, d1.delivery.id, {
      status: "dispatched",
      lastError: null,
      dispatchedAtMs: baseMs + 3000,
    })
    expect(dispatched?.status).toBe("dispatched")
    expect(await listPendingBotWebhookDeliveriesForBot(db, "bot_1", { sinceMs: baseMs, limit: 20 })).toEqual([])

    const listed = await listBotWebhooks(db, "owner_1", "bot_1")
    expect(listed.webhooks).toHaveLength(1)
    expect(listed.lastDeliveryByWebhookId[created.webhook.id]?.status).toBe("dispatched")

    const updated = await updateBotWebhook(db, "owner_1", "bot_1", created.webhook.id, {
      enabled: false,
      tokenHash: "hash_2",
      nowMs: baseMs + 4000,
    })
    expect(updated?.enabled).toBe(false)
    expect(await getBotWebhookByTokenHash(db, "hash_1")).toBeNull()
    expect((await getBotWebhookByTokenHash(db, "hash_2"))?.id).toBe(created.webhook.id)

    for (let i = 0; i < BOT_WEBHOOK_DELIVERY_RETENTION + 5; i++) {
      await createBotWebhookDelivery(db, {
        webhookId: created.webhook.id,
        ownerUserId: "owner_1",
        botUserId: "bot_1",
        externalDeliveryId: null,
        eventType: "generic",
        summary: `delivery ${i}`,
        promptText: `body ${i}`,
        status: "dispatched",
        nowMs: baseMs + 10_000 + i,
      })
    }
    const recent = await listBotWebhookDeliveries(db, "owner_1", "bot_1", created.webhook.id, 100)
    expect(recent).toHaveLength(BOT_WEBHOOK_DELIVERY_RETENTION)
    expect(recent[0]?.summary).toBe(`delivery ${BOT_WEBHOOK_DELIVERY_RETENTION + 4}`)

    const pendingPlan = sqlite.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM community_bot_webhook_delivery WHERE bot_user_id = ? AND status = 'pending' AND created_at_ms >= ? ORDER BY created_at_ms ASC LIMIT 20`,
    ).all("bot_1", baseMs) as Array<{ detail: string }>
    expect(pendingPlan.some((row) => row.detail.includes("idx_community_bot_webhook_delivery_bot_pending"))).toBe(true)

    expect(await deleteBotWebhook(db, "owner_1", "bot_1", created.webhook.id)).toBe(true)
    expect(await listBotWebhookDeliveries(db, "owner_1", "bot_1", created.webhook.id, 10)).toEqual([])
  })

  it("enforces per-bot limit and cascades on bot deletion", async () => {
    for (let i = 0; i < BOT_WEBHOOK_MAX_PER_BOT; i++) {
      const res = await createBotWebhook(db, {
        ownerUserId: "owner_1",
        botUserId: "bot_1",
        name: `Hook ${i}`,
        provider: "generic",
        tokenHash: `h_${i}`,
        signingSecretEnc: null,
        eventFilter: null,
        instruction: "",
      })
      expect(res.ok).toBe(true)
    }

    const overflow = await createBotWebhook(db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Overflow",
      provider: "generic",
      tokenHash: "h_overflow",
      signingSecretEnc: null,
      eventFilter: null,
      instruction: "",
    })
    expect(overflow).toEqual({ ok: false, code: "limit_exceeded" })

    sqlite.prepare("DELETE FROM user WHERE id = ?").run("bot_1")
    const afterDelete = await listBotWebhooks(db, "owner_1", "bot_1")
    expect(afterDelete.webhooks).toEqual([])
  })
})
