/// <reference types="@cloudflare/vitest-plugin/types" />

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { createDb, queries, schema } from "@alook/shared"
import {
  communityBotBinding,
  communityMachine,
  communityMachineCredential,
} from "../../shared/src/db/community-machine-schema"
import {
  communityChannel,
  communityMessage,
  communityServer,
  communityServerMember,
} from "../../shared/src/db/community-schema"

const runtimeEnv = env as unknown as {
  DB: D1Database
  OWNER_SCHEDULE_DO: DurableObjectNamespace
  WS_DO: DurableObjectNamespace
}

const worker = (exports as unknown as {
  default: { fetch(request: Request): Promise<Response> }
}).default

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

async function seedHouseholdAndMessage(opts: {
  channelType?: "text" | "forum"
  botIsChannelMember?: boolean
  machineConnected?: boolean
}) {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerId = `owner_${suffix}`
  const botId = `bot_${suffix}`
  const machineId = `mach_${suffix}`
  const serverId = `srv_${suffix}`
  const channelId = `ch_${suffix}`
  const messageId = `msg_${suffix}`
  const nowIso = new Date().toISOString()

  const db = createDb(runtimeEnv.DB)

  await db.insert(schema.user).values({
    id: ownerId,
    name: `Owner${suffix}`,
    discriminator: "0001",
    email: `${ownerId}@test.local`,
    emailVerified: true,
    isBot: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  })

  await db.insert(schema.user).values({
    id: botId,
    name: `Bot${suffix}`,
    discriminator: "0002",
    email: `${botId}@test.local`,
    emailVerified: true,
    isBot: true,
    ownerUserId: ownerId,
    createdAt: nowIso,
    updatedAt: nowIso,
  })

  await db.insert(communityMachine).values({
    id: machineId,
    userId: ownerId,
    hostname: "macbook",
    displayName: "MacBook",
    status: "online",
    createdAt: nowIso,
    updatedAt: nowIso,
  })

  const credSecret = `cmk_${suffix}_secret`
  const credHash = await sha256Hex(credSecret)
  const doName = credHash.slice(0, 32)
  await db.insert(communityMachineCredential).values({
    id: `cred_${suffix}`,
    machineId,
    userId: ownerId,
    credentialHash: credHash,
    doName,
    createdAt: nowIso,
  })

  await db.insert(communityBotBinding).values({
    userId: botId,
    machineId,
    runtime: "codex",
    isActive: true,
    createdAt: nowIso,
  })

  await db.insert(communityServer).values({
    id: serverId,
    name: `Srv${suffix}`,
    discriminator: "1234",
    ownerId,
    createdAt: nowIso,
  })

  await db.insert(communityServerMember).values({
    serverId,
    userId: ownerId,
    role: "owner",
    joinedAt: nowIso,
  })

  if (opts.botIsChannelMember !== false) {
    await db.insert(communityServerMember).values({
      serverId,
      userId: botId,
      role: "member",
      joinedAt: nowIso,
    })
  }

  const channelType = opts.channelType ?? "text"
  await db.insert(communityChannel).values({
    id: channelId,
    serverId,
    name: "general",
    type: channelType,
    isPrivate: false,
    position: 0,
    createdAt: nowIso,
  })

  await db.insert(communityMessage).values({
    id: messageId,
    channelId,
    authorId: ownerId,
    seq: 7,
    content: "Trigger context message",
    createdAt: nowIso,
  })

  let machineClient: WebSocket | null = null
  const receivedFrames: unknown[] = []
  if (opts.machineConnected) {
    const wsDoId = runtimeEnv.WS_DO.idFromName("community-machine:" + doName)
    const upgradeRes = await runtimeEnv.WS_DO.get(wsDoId).fetch(
      new Request("https://worker.test/", {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${credSecret}`,
        },
      }),
    )
    expect(upgradeRes.status).toBe(101)
    machineClient = upgradeRes.webSocket!
    machineClient.accept()
    machineClient.addEventListener("message", (event) => {
      try {
        receivedFrames.push(JSON.parse(String(event.data)))
      } catch {
        receivedFrames.push(event.data)
      }
    })
  }

  return {
    db,
    ownerId,
    botId,
    machineId,
    serverId,
    channelId,
    messageId,
    doName,
    credSecret,
    machineClient,
    receivedFrames,
    close() {
      try { machineClient?.close(1000, "done") } catch {}
    },
  }
}

async function syncAlarm(ownerId: string, change?: { eventId: string; reason: "created" | "updated" | "deleted" | "run_updated" }) {
  const res = await worker.fetch(new Request(`https://worker.test/owner-schedule/${ownerId}/sync-alarm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerUserId: ownerId, ...change }),
  }))
  expect(res.status).toBe(200)
  return (await res.json()) as { nextAlarmMs: number | null }
}

describe("OwnerScheduleDurableObject workerd runtime (D1 + stateless DO timer)", () => {
  it("dispatches recurring event via agent:event with --ack guidance, advances D1, and supports --ack completion", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, channelType: "text" })
    try {
      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "Hourly standup",
        description: "Post status summary",
        startAtMs,
        durationMinutes: 30,
        timeZone: "UTC",
        recurrence: { freq: "hourly", interval: 1 },
        sourceMessageId: fx.messageId,
        sourceChannelId: fx.channelId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const synced = await syncAlarm(fx.ownerId, { eventId: created.event.id, reason: "created" })
      expect(synced.nextAlarmMs).toBe(startAtMs)

      const stub = runtimeEnv.OWNER_SCHEDULE_DO.get(
        runtimeEnv.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${fx.ownerId}`),
      )

      const ran = await runDurableObjectAlarm(stub)
      expect(ran).toBe(true)
      await new Promise((r) => setTimeout(r, 30))

      expect(fx.receivedFrames).toHaveLength(1)
      const frame = fx.receivedFrames[0] as { type: string; agentId: string; launchId: string; prompt: string }
      expect(frame.type).toBe("agent:event")
      expect(frame.agentId).toBe(fx.botId)
      expect(frame.launchId).toMatch(/^schrun_srun_/)
      expect(frame.prompt).toContain("Hourly standup")
      expect(frame.prompt).toContain('--reply "#7"')
      expect(frame.prompt).toContain(`$ALOOK_CLI schedule update ${created.event.id} --ack`)

      const fetched = await queries.communitySchedule.getScheduleEventById(fx.db, fx.ownerId, created.event.id)
      expect(fetched?.latestRun?.status).toBe("dispatched")
      expect(fetched?.event.nextRunAtMs).toBeGreaterThan(Date.now())

      const ranAgain = await runDurableObjectAlarm(stub)
      expect(ranAgain).toBe(true)
      await new Promise((r) => setTimeout(r, 20))
      expect(fx.receivedFrames).toHaveLength(1)

      const acked = await queries.communitySchedule.updateScheduleEvent(fx.db, fx.ownerId, created.event.id, {
        ack: true,
      })
      expect(acked.ok).toBe(true)
      if (!acked.ok) return
      expect(acked.latestRun?.status).toBe("completed")
      expect(acked.latestRun?.ackedAtMs).toBeTypeOf("number")
    } finally {
      fx.close()
    }
  })

  it("deletes DO storage via deleteAll() after the last one-time event fires", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, channelType: "text" })
    try {
      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "One-off check",
        startAtMs,
        timeZone: "UTC",
        recurrence: null,
        sourceMessageId: fx.messageId,
        sourceChannelId: fx.channelId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      await syncAlarm(fx.ownerId, { eventId: created.event.id, reason: "created" })
      const stub = runtimeEnv.OWNER_SCHEDULE_DO.get(
        runtimeEnv.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${fx.ownerId}`),
      )

      await runDurableObjectAlarm(stub)
      await new Promise((r) => setTimeout(r, 30))
      expect(fx.receivedFrames).toHaveLength(1)

      const storedOwner = await runInDurableObject(stub, async (_instance, state) => {
        return {
          ownerUserId: await state.storage.get("ownerUserId"),
          alarm: await state.storage.getAlarm(),
        }
      })
      expect(storedOwner).toEqual({ ownerUserId: undefined, alarm: null })
    } finally {
      fx.close()
    }
  })

  it("keeps offline triggers pending in D1 and flushes them on /resync-bots once the daemon reconnects", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: false, channelType: "text" })
    let reconnectClient: WebSocket | null = null
    try {
      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "Offline reminder",
        startAtMs,
        timeZone: "UTC",
        recurrence: null,
        sourceMessageId: fx.messageId,
        sourceChannelId: fx.channelId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      await syncAlarm(fx.ownerId, { eventId: created.event.id, reason: "created" })
      const stub = runtimeEnv.OWNER_SCHEDULE_DO.get(
        runtimeEnv.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)

      const afterOffline = await queries.communitySchedule.getScheduleEventById(fx.db, fx.ownerId, created.event.id)
      expect(afterOffline?.latestRun?.status).toBe("pending")
      expect(afterOffline?.latestRun?.lastError).toBe("machine_offline")

      const frames: unknown[] = []
      const wsDoId = runtimeEnv.WS_DO.idFromName("community-machine:" + fx.doName)
      const upgradeRes = await runtimeEnv.WS_DO.get(wsDoId).fetch(
        new Request("https://worker.test/", {
          headers: { Upgrade: "websocket", Authorization: `Bearer ${fx.credSecret}` },
        }),
      )
      expect(upgradeRes.status).toBe(101)
      reconnectClient = upgradeRes.webSocket!
      reconnectClient.accept()
      reconnectClient.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))))

      const resyncRes = await worker.fetch(new Request(`https://worker.test/owner-schedule/${fx.ownerId}/resync-bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerUserId: fx.ownerId, botIds: [fx.botId] }),
      }))
      expect(resyncRes.status).toBe(200)
      expect(await resyncRes.json()).toEqual({ attempted: 1, dispatched: 1, blocked: 0 })

      await new Promise((r) => setTimeout(r, 30))
      expect(frames).toHaveLength(1)

      const afterResync = await queries.communitySchedule.getScheduleEventById(fx.db, fx.ownerId, created.event.id)
      expect(afterResync?.latestRun?.status).toBe("dispatched")
    } finally {
      try { reconnectClient?.close(1000, "done") } catch {}
      fx.close()
    }
  })

  it("marks run blocked_access when the bot no longer has access to the bound message", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, botIsChannelMember: false })
    try {
      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "No access task",
        startAtMs,
        timeZone: "UTC",
        recurrence: null,
        sourceMessageId: fx.messageId,
        sourceChannelId: fx.channelId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      await syncAlarm(fx.ownerId, { eventId: created.event.id, reason: "created" })
      const stub = runtimeEnv.OWNER_SCHEDULE_DO.get(
        runtimeEnv.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)

      const fetched = await queries.communitySchedule.getScheduleEventById(fx.db, fx.ownerId, created.event.id)
      expect(fetched?.latestRun?.status).toBe("blocked_access")
      expect(fetched?.latestRun?.lastError).toBe("source_message_inaccessible")
      expect(fx.receivedFrames).toHaveLength(0)
    } finally {
      fx.close()
    }
  })

  it("formats forum opener bound messages to reply inside /server/forum/#seq without --reply", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, channelType: "forum" })
    try {
      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "Forum post check-in",
        startAtMs,
        timeZone: "UTC",
        recurrence: null,
        sourceMessageId: fx.messageId,
        sourceChannelId: fx.channelId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      await syncAlarm(fx.ownerId, { eventId: created.event.id, reason: "created" })
      const stub = runtimeEnv.OWNER_SCHEDULE_DO.get(
        runtimeEnv.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)
      await new Promise((r) => setTimeout(r, 30))

      expect(fx.receivedFrames).toHaveLength(1)
      const frame = fx.receivedFrames[0] as { prompt: string }
      expect(frame.prompt).toContain('/general/#7"')
      expect(frame.prompt).not.toContain("--reply")
    } finally {
      fx.close()
    }
  })

  it("dispatches when bound to a thread the bot can read via parent channel even before joining the thread", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, channelType: "text" })
    try {
      const threadId = `thr_${crypto.randomUUID().slice(0, 8)}`
      const threadMsgId = `tmsg_${crypto.randomUUID().slice(0, 8)}`
      const nowIso = new Date().toISOString()

      await fx.db.insert(communityChannel).values({
        id: threadId,
        serverId: fx.serverId,
        name: "Side thread",
        type: "thread",
        parentChannelId: fx.channelId,
        parentMessageId: fx.messageId,
        isPrivate: false,
        position: 0,
        createdAt: nowIso,
      })
      await fx.db.insert(communityMessage).values({
        id: threadMsgId,
        channelId: threadId,
        authorId: fx.ownerId,
        seq: 2,
        content: "Thread trigger context",
        createdAt: nowIso,
      })

      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "Thread check-in",
        startAtMs,
        timeZone: "UTC",
        recurrence: null,
        sourceMessageId: threadMsgId,
        sourceChannelId: threadId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      await syncAlarm(fx.ownerId, { eventId: created.event.id, reason: "created" })
      const stub = runtimeEnv.OWNER_SCHEDULE_DO.get(
        runtimeEnv.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)
      await new Promise((r) => setTimeout(r, 30))

      expect(fx.receivedFrames).toHaveLength(1)
      const frame = fx.receivedFrames[0] as { prompt: string }
      expect(frame.prompt).toContain("/general/#7")
      expect(frame.prompt).toContain('--reply "#2"')
    } finally {
      fx.close()
    }
  })

  it("refreshes pending run snapshot on metadata-only edit before /resync-bots dispatches", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: false, channelType: "text" })
    let reconnectClient: WebSocket | null = null
    try {
      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "Original title",
        description: "Original body",
        startAtMs,
        timeZone: "UTC",
        recurrence: { freq: "hourly", interval: 1 },
        sourceMessageId: fx.messageId,
        sourceChannelId: fx.channelId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      await syncAlarm(fx.ownerId, { eventId: created.event.id, reason: "created" })
      const stub = runtimeEnv.OWNER_SCHEDULE_DO.get(
        runtimeEnv.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)

      const beforeEdit = await queries.communitySchedule.getScheduleEventById(fx.db, fx.ownerId, created.event.id)
      expect(beforeEdit?.latestRun?.status).toBe("pending")

      const edited = await queries.communitySchedule.updateScheduleEvent(fx.db, fx.ownerId, created.event.id, {
        title: "Updated title",
        description: "Updated body",
      })
      expect(edited.ok).toBe(true)
      if (!edited.ok) return
      expect(edited.event.nextRunAtMs).toBe(beforeEdit?.event.nextRunAtMs)

      const frames: unknown[] = []
      const wsDoId = runtimeEnv.WS_DO.idFromName("community-machine:" + fx.doName)
      const upgradeRes = await runtimeEnv.WS_DO.get(wsDoId).fetch(
        new Request("https://worker.test/", {
          headers: { Upgrade: "websocket", Authorization: `Bearer ${fx.credSecret}` },
        }),
      )
      reconnectClient = upgradeRes.webSocket!
      reconnectClient.accept()
      reconnectClient.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))))

      const resyncRes = await worker.fetch(new Request(`https://worker.test/owner-schedule/${fx.ownerId}/resync-bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerUserId: fx.ownerId, botIds: [fx.botId] }),
      }))
      expect(await resyncRes.json()).toEqual({ attempted: 1, dispatched: 1, blocked: 0 })
      await new Promise((r) => setTimeout(r, 30))

      expect(frames).toHaveLength(1)
      const frame = frames[0] as { prompt: string }
      expect(frame.prompt).toContain("Updated title")
      expect(frame.prompt).toContain("Updated body")
    } finally {
      try { reconnectClient?.close(1000, "done") } catch {}
      fx.close()
    }
  })

  it("backfills and dispatches an orphaned pending schedule run missing from bot private inbox on /resync-bots", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: false, channelType: "text" })
    let reconnectClient: WebSocket | null = null
    try {
      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "Orphan recovery check",
        description: "Verify missing inbox backfill",
        startAtMs,
        timeZone: "UTC",
        recurrence: null,
        sourceMessageId: fx.messageId,
        sourceChannelId: fx.channelId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const claimed = await queries.communitySchedule.claimDueEventOccurrence(fx.db, created.event, Date.now())
      expect(claimed?.status).toBe("pending")
      const inboxAfterClaim = await queries.communityBotPrivateInbox.listPendingPrivateInboxEventsForBot(fx.db, fx.botId, 10)
      expect(inboxAfterClaim).toHaveLength(1)
      expect(inboxAfterClaim[0]?.sourceRefId).toBe(claimed?.id)

      // Simulate an orphaned schedule run whose private inbox row was missing/lost.
      await queries.communityBotPrivateInbox.deletePrivateInboxEventsForSource(fx.db, "schedule", created.event.id)
      expect(await queries.communityBotPrivateInbox.listPendingPrivateInboxEventsForBot(fx.db, fx.botId, 10)).toEqual([])

      const frames: unknown[] = []
      const wsDoId = runtimeEnv.WS_DO.idFromName("community-machine:" + fx.doName)
      const upgradeRes = await runtimeEnv.WS_DO.get(wsDoId).fetch(
        new Request("https://worker.test/", {
          headers: { Upgrade: "websocket", Authorization: `Bearer ${fx.credSecret}` },
        }),
      )
      expect(upgradeRes.status).toBe(101)
      reconnectClient = upgradeRes.webSocket!
      reconnectClient.accept()
      reconnectClient.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))))

      const resyncRes = await worker.fetch(new Request(`https://worker.test/owner-schedule/${fx.ownerId}/resync-bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerUserId: fx.ownerId, botIds: [fx.botId] }),
      }))
      expect(resyncRes.status).toBe(200)
      expect(await resyncRes.json()).toEqual({ attempted: 1, dispatched: 1, blocked: 0 })
      await new Promise((r) => setTimeout(r, 30))

      expect(frames).toHaveLength(1)
      const afterResync = await queries.communitySchedule.getScheduleEventById(fx.db, fx.ownerId, created.event.id)
      expect(afterResync?.latestRun?.status).toBe("dispatched")
    } finally {
      try { reconnectClient?.close(1000, "done") } catch {}
      fx.close()
    }
  })

  it("writes wake_trigger activity log rows for dispatched schedule and resynced webhook wakes", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, channelType: "text" })
    try {
      const startAtMs = Date.now() - 1000
      const created = await queries.communitySchedule.createScheduleEvent(fx.db, {
        ownerUserId: fx.ownerId,
        createdByUserId: fx.botId,
        title: "Morning digest",
        description: "Summarize open PRs",
        startAtMs,
        timeZone: "UTC",
        recurrence: null,
        sourceMessageId: fx.messageId,
        sourceChannelId: fx.channelId,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      await syncAlarm(fx.ownerId, { eventId: created.event.id, reason: "created" })
      const stub = runtimeEnv.OWNER_SCHEDULE_DO.get(
        runtimeEnv.OWNER_SCHEDULE_DO.idFromName(`owner-schedule:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)

      const createdWebhook = await queries.communityBotWebhook.createBotWebhook(fx.db, {
        ownerUserId: fx.ownerId,
        botUserId: fx.botId,
        name: "GitHub alook",
        provider: "github",
        tokenHash: `tok_${crypto.randomUUID()}`,
        signingSecretEnc: null,
        eventFilter: null,
        instruction: "",
        nowMs: Date.now(),
      })
      expect(createdWebhook.ok).toBe(true)
      if (!createdWebhook.ok) return
      const webhook = createdWebhook.webhook
      const delivery = await queries.communityBotWebhook.createBotWebhookDelivery(fx.db, {
        ownerUserId: fx.ownerId,
        botUserId: fx.botId,
        webhookId: webhook.id,
        externalDeliveryId: `ext_${crypto.randomUUID()}`,
        eventType: "pull_request.opened",
        summary: "PR #1514 opened",
        promptText: "[External Webhook Notification]\nPR #1514 opened",
        status: "pending",
        nowMs: Date.now(),
      })

      const resyncRes = await worker.fetch(new Request(`https://worker.test/owner-schedule/${fx.ownerId}/resync-bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerUserId: fx.ownerId, botIds: [fx.botId] }),
      }))
      expect(resyncRes.status).toBe(200)
      expect(await resyncRes.json()).toEqual({ attempted: 1, dispatched: 1, blocked: 0 })

      const auditRows = await queries.communityBotAuditLog.listOwnedBotActivityEvents(fx.db, {
        botId: fx.botId,
        ownerUserId: fx.ownerId,
        limit: 10,
      })
      expect(auditRows).toHaveLength(2)
      const payloads = auditRows!.map((row) => ({
        kind: row.kind,
        launchId: row.launchId,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }))
      expect(payloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "wake_trigger",
            payload: expect.objectContaining({
              reason: "schedule",
              scheduleId: created.event.id,
              title: "Morning digest",
              seq: 7,
            }),
          }),
          {
            kind: "wake_trigger",
            launchId: delivery.delivery.id,
            payload: {
              reason: "webhook",
              triggerId: webhook.id,
              triggerName: "GitHub alook",
              provider: "github",
              eventType: "pull_request.opened",
              summary: "PR #1514 opened",
            },
          },
        ]),
      )
    } finally {
      fx.close()
    }
  })
})
