import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type Sqlite from "better-sqlite3"
import { createMigratedDb } from "../helpers/migrated-db"
import { prepareNativeBatchStatement } from "../helpers/native-batch-prepare"
import type { Database } from "../../src/db"
import * as coreSchema from "../../src/db/schema"
import * as communitySchema from "../../src/db/community-schema"
import * as machineSchema from "../../src/db/community-machine-schema"
import * as communityBotAuditLog from "../../src/db/queries/community/bot-audit-log"
import * as communityBotPrivateInbox from "../../src/db/queries/community/bot-private-inbox"
import * as communityBotWebhook from "../../src/db/queries/community/bot-webhook"
import * as communitySchedule from "../../src/db/queries/community/schedule"
import {
  dispatchBotPrivateInboxEvent,
  resyncBotPrivateInboxForBots,
  type BotAuditWakeBroadcastEvent,
} from "../../src/bot-private-inbox-dispatch"
import { AuditLogWakeTriggerPayloadSchema } from "../../src/schemas"

describe("dispatchBotPrivateInboxEvent — activity log wake_trigger audit", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    const migrated = createMigratedDb()
    sqlite = migrated.sqlite
    db = migrated.db
    ;(db as any).batch = (
      statements: Array<{ toSQL: () => { sql: string; params: unknown[] } }>,
    ) =>
      sqlite.transaction(() =>
        statements.map((statement) => {
          const query = statement.toSQL()
          const prepared = prepareNativeBatchStatement(sqlite, query)
          if (!prepared.reader) return prepared.run(...query.params)
          return prepared.all(...query.params).map((row: any) => {
            if (!("created_at" in row)) return row
            const { created_at: createdAt, ...rest } = row
            return { ...rest, createdAt }
          })
        }),
      )()

    const nowIso = "2026-11-28T00:00:00.000Z"
    db.insert(coreSchema.user)
      .values([
        {
          id: "owner_1",
          name: "gus",
          discriminator: "1813",
          email: "gus@test.local",
          emailVerified: true,
          isBot: false,
          ownerUserId: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        {
          id: "bot_1",
          name: "Claudette",
          discriminator: "5211",
          email: "bot1@test.local",
          emailVerified: true,
          isBot: true,
          ownerUserId: "owner_1",
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ])
      .run()
    db.insert(machineSchema.communityMachine)
      .values({
        id: "mach_1",
        userId: "owner_1",
        hostname: "macbook",
        displayName: "MacBook",
        status: "online",
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run()
    db.insert(machineSchema.communityBotBinding)
      .values({
        userId: "bot_1",
        machineId: "mach_1",
        runtime: "codex",
        isActive: true,
        createdAt: nowIso,
      })
      .run()
    db.insert(communitySchema.communityServer)
      .values({
        id: "srv_1",
        name: "Alook",
        discriminator: "5620",
        ownerId: "owner_1",
        createdAt: nowIso,
      })
      .run()
    db.insert(communitySchema.communityServerMember)
      .values([
        { serverId: "srv_1", userId: "owner_1", role: "owner", joinedAt: nowIso },
        { serverId: "srv_1", userId: "bot_1", role: "member", joinedAt: nowIso },
      ])
      .run()
    db.insert(communitySchema.communityChannel)
      .values({
        id: "ch_1",
        serverId: "srv_1",
        name: "general",
        type: "text",
        isPrivate: false,
        position: 0,
        createdAt: nowIso,
      })
      .run()
    db.insert(communitySchema.communityMessage)
      .values({
        id: "msg_1",
        channelId: "ch_1",
        authorId: "owner_1",
        seq: 42,
        content: "Check CI daily",
        createdAt: nowIso,
      })
      .run()
  })

  afterEach(() => {
    sqlite.close()
  })

  it("records wake_trigger audit row, bumps handled rollup, and broadcasts when a webhook dispatches", async () => {
    const createdWebhook = await communityBotWebhook.createBotWebhook(db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "GitHub alook",
      provider: "github",
      tokenHash: "tok_hash_1",
      signingSecretEnc: null,
      eventFilter: null,
      instruction: "",
      nowMs: 1_700_000_000_000,
    })
    expect(createdWebhook.ok).toBe(true)
    if (!createdWebhook.ok) return
    const webhook = createdWebhook.webhook
    const delivery = await communityBotWebhook.createBotWebhookDelivery(db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      webhookId: webhook.id,
      externalDeliveryId: "ext_1",
      eventType: "workflow_run.completed",
      summary: "CI failed on PR #1513",
      promptText: "[External Webhook Notification]\nCI failed on PR #1513",
      status: "pending",
      nowMs: 1_700_000_001_000,
    })
    const broadcasts: BotAuditWakeBroadcastEvent[] = []
    const result = await dispatchBotPrivateInboxEvent(
      db,
      async () => ({ sent: 1 }),
      delivery.delivery,
      {
        broadcastBotAuditEvent: async (ev) => {
          broadcasts.push(ev)
        },
      },
    )

    expect(result.outcome).toBe("dispatched")
    const rows = await communityBotAuditLog.listOwnedBotActivityEvents(db, {
      botId: "bot_1",
      ownerUserId: "owner_1",
      limit: 10,
    })
    expect(rows).toHaveLength(1)
    expect(rows?.[0]?.kind).toBe("wake_trigger")
    expect(rows?.[0]?.launchId).toBe(delivery.delivery.id)
    const parsedPayload = AuditLogWakeTriggerPayloadSchema.parse(JSON.parse(rows![0]!.payload))
    expect(parsedPayload).toEqual({
      reason: "webhook",
      triggerId: webhook.id,
      triggerName: "GitHub alook",
      provider: "github",
      eventType: "workflow_run.completed",
      summary: "CI failed on PR #1513",
    })

    expect(broadcasts).toEqual([
      {
        botId: "bot_1",
        ownerUserId: "owner_1",
        id: rows![0]!.id,
        kind: "wake_trigger",
        payload: parsedPayload,
        createdAt: rows![0]!.createdAt,
        launchId: delivery.delivery.id,
      },
    ])

    const daily = await db.select().from(communitySchema.communityBotDailyActivity)
    expect(daily).toMatchObject([{ botId: "bot_1", handledCount: 1 }])
  })

  it("does not write an audit row when machine is offline, and falls back gracefully if trigger was deleted before resync", async () => {
    const createdWebhook = await communityBotWebhook.createBotWebhook(db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      name: "Linear",
      provider: "linear",
      tokenHash: "tok_hash_2",
      signingSecretEnc: null,
      eventFilter: null,
      instruction: "",
      nowMs: 1_700_000_000_000,
    })
    expect(createdWebhook.ok).toBe(true)
    if (!createdWebhook.ok) return
    const webhook = createdWebhook.webhook
    const delivery = await communityBotWebhook.createBotWebhookDelivery(db, {
      ownerUserId: "owner_1",
      botUserId: "bot_1",
      webhookId: webhook.id,
      externalDeliveryId: "ext_2",
      eventType: "Issue.create",
      summary: "ENG-123 opened",
      promptText: "[External Webhook Notification]\nENG-123 opened",
      status: "pending",
      nowMs: 1_700_000_001_000,
    })

    const broadcasts: BotAuditWakeBroadcastEvent[] = []
    const offline = await dispatchBotPrivateInboxEvent(
      db,
      async () => ({ sent: 0 }),
      delivery.delivery,
      {
        broadcastBotAuditEvent: async (ev) => {
          broadcasts.push(ev)
        },
      },
    )
    expect(offline.outcome).toBe("pending")
    expect(broadcasts).toHaveLength(0)
    expect(
      await communityBotAuditLog.listOwnedBotActivityEvents(db, {
        botId: "bot_1",
        ownerUserId: "owner_1",
        limit: 10,
      }),
    ).toEqual([])

    // Simulate deleted webhook row while private inbox entry still exists.
    sqlite.prepare("DELETE FROM community_bot_webhook WHERE id = ?").run(webhook.id)
    const resync = await resyncBotPrivateInboxForBots(
      db,
      async () => ({ sent: 1 }),
      "owner_1",
      ["bot_1"],
      {
        broadcastBotAuditEvent: async (ev) => {
          broadcasts.push(ev)
        },
      },
    )
    expect(resync).toEqual({ attempted: 1, dispatched: 1, blocked: 0 })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.payload).toEqual({
      reason: "webhook",
      triggerId: webhook.id,
      triggerName: "Trigger",
      provider: "generic",
      eventType: "Issue.create",
      summary: "ENG-123 opened",
    })
  })

  it("keeps webhook dispatch successful even when broadcast throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const createdWebhook = await communityBotWebhook.createBotWebhook(db, {
        ownerUserId: "owner_1",
        botUserId: "bot_1",
        name: "Stripe",
        provider: "stripe",
        tokenHash: "tok_hash_3",
        signingSecretEnc: null,
        eventFilter: null,
        instruction: "",
        nowMs: 1_700_000_000_000,
      })
      expect(createdWebhook.ok).toBe(true)
      if (!createdWebhook.ok) return
      const webhook = createdWebhook.webhook
      const delivery = await communityBotWebhook.createBotWebhookDelivery(db, {
        ownerUserId: "owner_1",
        botUserId: "bot_1",
        webhookId: webhook.id,
        externalDeliveryId: "ext_3",
        eventType: "invoice.paid",
        summary: "Invoice paid",
        promptText: "[External Webhook Notification]\nInvoice paid",
        status: "pending",
        nowMs: 1_700_000_001_000,
      })
      const result = await dispatchBotPrivateInboxEvent(
        db,
        async () => ({ sent: 1 }),
        delivery.delivery,
        {
          broadcastBotAuditEvent: async () => {
            throw new Error("ws-do down")
          },
        },
      )
      expect(result.outcome).toBe("dispatched")
      const rows = await communityBotAuditLog.listOwnedBotActivityEvents(db, {
        botId: "bot_1",
        ownerUserId: "owner_1",
        limit: 10,
      })
      expect(rows).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("records wake_trigger audit row and broadcasts when a schedule run dispatches", async () => {
    const created = await communitySchedule.createScheduleEvent(db, {
      ownerUserId: "owner_1",
      createdByUserId: "bot_1",
      title: "Daily triage",
      description: "Check open issues",
      startAtMs: 1_700_000_000_000,
      timeZone: "UTC",
      recurrence: null,
      sourceMessageId: "msg_1",
      sourceChannelId: "ch_1",
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const claimed = await communitySchedule.claimDueEventOccurrence(
      db,
      created.event,
      1_700_000_005_000,
    )
    expect(claimed?.status).toBe("pending")
    if (!claimed) return

    const pending = await communityBotPrivateInbox.listPendingPrivateInboxEventsForBot(db, "bot_1", 10)
    expect(pending).toHaveLength(1)

    const broadcasts: BotAuditWakeBroadcastEvent[] = []
    const result = await dispatchBotPrivateInboxEvent(
      db,
      async () => ({ sent: 1 }),
      pending[0]!,
      {
        broadcastBotAuditEvent: async (ev) => {
          broadcasts.push(ev)
        },
      },
    )

    expect(result.outcome).toBe("dispatched")
    const rows = await communityBotAuditLog.listOwnedBotActivityEvents(db, {
      botId: "bot_1",
      ownerUserId: "owner_1",
      limit: 10,
    })
    expect(rows).toHaveLength(1)
    expect(rows?.[0]?.kind).toBe("wake_trigger")
    expect(rows?.[0]?.launchId).toBe(`schrun_${claimed.id}`)
    const parsedPayload = AuditLogWakeTriggerPayloadSchema.parse(JSON.parse(rows![0]!.payload))
    expect(parsedPayload).toEqual({
      reason: "schedule",
      scheduleId: created.event.id,
      runId: claimed.id,
      title: "Daily triage",
      channel: "/Alook#5620/general",
      seq: 42,
    })
    expect(broadcasts).toEqual([
      {
        botId: "bot_1",
        ownerUserId: "owner_1",
        id: rows![0]!.id,
        kind: "wake_trigger",
        payload: parsedPayload,
        createdAt: rows![0]!.createdAt,
        launchId: `schrun_${claimed.id}`,
      },
    ])
  })
})
