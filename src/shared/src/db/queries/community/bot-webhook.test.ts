import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as coreSchema from "../../schema"
import * as communitySchema from "../../community-schema"
import * as machineSchema from "../../community-machine-schema"
import * as privateInboxSchema from "../../community-bot-private-inbox-schema"
import * as webhookSchema from "../../community-bot-webhook-schema"
import type { Database } from "../../index"
import {
  enqueuePrivateInboxEvent,
  listPendingPrivateInboxEventsForBot,
  updatePrivateInboxEventStatus,
} from "./bot-private-inbox"
import {
  allowBotImTriggerSender,
  createBotWebhook,
  createBotWebhookDelivery,
  deleteBotWebhook,
  getBotImReplyRef,
  getBotWebhookById,
  getBotWebhookByTokenHash,
  listBotWebhookDeliveries,
  listBotWebhooks,
  listDaemonPollImTriggersForBots,
  updateBotImDaemonStatus,
  updateBotWebhook,
  upsertBotImReplyRef,
} from "./bot-webhook"
import { BOT_WEBHOOK_DELIVERY_RETENTION, BOT_WEBHOOK_MAX_PER_BOT } from "../../../bot-webhook"

const schema = {
  ...coreSchema,
  ...communitySchema,
  ...machineSchema,
  ...privateInboxSchema,
  ...webhookSchema,
}
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

describe("community bot private inbox & webhook D1 queries", () => {
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

  it("supports webhook CRUD, unified private inbox dedup/resync across webhook + schedule, retention pruning, and indexed pending plan", async () => {
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

    const s1 = await enqueuePrivateInboxEvent(db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      sourceKind: "schedule",
      sourceId: "sch_1",
      sourceRefId: "srun_1",
      dedupeKey: String(baseMs + 1500),
      eventType: "schedule.triggered",
      summary: "Daily standup",
      promptText: "run standup",
      status: "pending",
      nowMs: baseMs + 1500,
    })
    expect(s1.inserted).toBe(true)

    const pending = await listPendingPrivateInboxEventsForBot(db, "bot_1", 20)
    expect(pending.map((row) => [row.sourceKind, row.id])).toEqual([
      ["webhook", d1.delivery.id],
      ["schedule", s1.event.id],
    ])

    const dispatched = await updatePrivateInboxEventStatus(db, d1.delivery.id, {
      status: "dispatched",
      lastError: null,
      dispatchedAtMs: baseMs + 3000,
    })
    expect(dispatched?.status).toBe("dispatched")
    expect((await listPendingPrivateInboxEventsForBot(db, "bot_1", 20)).map((r) => r.id)).toEqual([
      s1.event.id,
    ])

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
      `EXPLAIN QUERY PLAN SELECT * FROM community_bot_private_inbox WHERE bot_user_id = ? AND status = 'pending' ORDER BY created_at_ms ASC LIMIT 20`,
    ).all("bot_1") as Array<{ detail: string }>
    expect(pendingPlan.some((row) => row.detail.includes("idx_community_bot_private_inbox_bot_pending"))).toBe(true)

    const latestPlan = sqlite.prepare(
      `EXPLAIN QUERY PLAN SELECT id, source_id, event_type, summary, status, last_error, created_at_ms FROM community_bot_private_inbox WHERE source_kind = 'webhook' AND source_id = ? ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
    ).all(created.webhook.id) as Array<{ detail: string }>
    expect(latestPlan.some((row) => row.detail.includes("idx_community_bot_private_inbox_source_created"))).toBe(true)

    expect(await deleteBotWebhook(db, "owner_1", "bot_1", created.webhook.id)).toBe(true)
    expect(await listBotWebhookDeliveries(db, "owner_1", "bot_1", created.webhook.id, 10)).toEqual([])
    expect((await listPendingPrivateInboxEventsForBot(db, "bot_1", 20)).map((r) => r.id)).toEqual([
      s1.event.id,
    ])
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

  it("supports IM trigger allow-sender, daemon_poll listing, status updates, and indexed reply-ref lookups", async () => {
    const baseMs = Date.parse("2026-11-28T09:00:00.000Z")
    const created = await createBotWebhook(db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "My WeChat",
      provider: "wechat",
      tokenHash: "wx_tok_1",
      signingSecretEnc: null,
      eventFilter: null,
      instruction: "Be brief",
      nowMs: baseMs,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.webhook.category).toBe("im")
    expect(created.webhook.transport).toBe("daemon_poll")

    const daemonTriggers = await listDaemonPollImTriggersForBots(db, "owner_1", ["bot_1"])
    expect(daemonTriggers.map((t) => t.id)).toEqual([created.webhook.id])

    const allow1 = await allowBotImTriggerSender(db, "owner_1", "bot_1", created.webhook.id, "wx_user_1", baseMs + 100)
    expect(allow1.ok).toBe(true)
    if (allow1.ok) {
      expect(allow1.added).toBe(true)
      expect(allow1.webhook.config.allowedSenders).toEqual(["wx_user_1"])
    }
    const allowDup = await allowBotImTriggerSender(db, "owner_1", "bot_1", created.webhook.id, "wx_user_1", baseMs + 200)
    expect(allowDup.ok && allowDup.added).toBe(false)

    const statusUpdated = await updateBotImDaemonStatus(db, "owner_1", "bot_1", created.webhook.id, {
      daemonStatus: "connected",
      botAccountLabel: "wx_bot@im.bot",
      daemonLastError: null,
      nowMs: baseMs + 300,
    })
    expect(statusUpdated?.config.daemonStatus).toBe("connected")
    expect(statusUpdated?.config.botAccountLabel).toBe("wx_bot@im.bot")

    await upsertBotImReplyRef(db, {
      botUserId: "bot_1",
      ref: "ext_tg_test123",
      ownerUserId: "owner_1",
      triggerId: created.webhook.id,
      platform: "telegram",
      targetJson: JSON.stringify({ chatId: "12345", replyToMessageId: 99 }),
      nowMs: baseMs + 400,
    })
    const refRow = await getBotImReplyRef(db, "bot_1", "ext_tg_test123")
    expect(refRow?.platform).toBe("telegram")
    expect(await getBotImReplyRef(db, "bot_other", "ext_tg_test123")).toBeNull()

    const refPlan = sqlite.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM community_bot_im_reply_ref WHERE bot_user_id = ? AND ref = ? LIMIT 1`,
    ).all("bot_1", "ext_tg_test123") as Array<{ detail: string }>
    expect(refPlan.some((row) => row.detail.includes("PRIMARY KEY") || row.detail.includes("sqlite_autoindex"))).toBe(true)
  })
})
