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
  OWNER_CALENDAR_DO: DurableObjectNamespace
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

describe("OwnerCalendarDurableObject workerd runtime", () => {
  it("commits recurring alarm atomically, dispatches via existing agent:event, and stays idempotent on duplicate alarm", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, channelType: "text" })
    try {
      const startAtMs = Date.now() - 1000
      const createRes = await worker.fetch(new Request(`https://worker.test/owner-calendar/${fx.ownerId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
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
        }),
      }))
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { event: { id: string; nextRunAtMs: number } }

      const stub = runtimeEnv.OWNER_CALENDAR_DO.get(
        runtimeEnv.OWNER_CALENDAR_DO.idFromName(`owner-calendar:${fx.ownerId}`),
      )

      const ran = await runDurableObjectAlarm(stub)
      expect(ran).toBe(true)

      await new Promise((r) => setTimeout(r, 30))
      const agentEvents = fx.receivedFrames.filter(
        (frame): frame is { type: string; agentId: string; launchId: string; prompt: string } =>
          typeof frame === "object" && frame !== null && (frame as { type?: string }).type === "agent:event",
      )
      expect(agentEvents).toHaveLength(1)
      expect(agentEvents[0]!.agentId).toBe(fx.botId)
      expect(agentEvents[0]!.launchId).toMatch(/^calrun_crun_/)
      expect(agentEvents[0]!.prompt).toContain("--reply \"#7\"")

      const listRes = await worker.fetch(new Request(`https://worker.test/owner-calendar/${fx.ownerId}/events`))
      const listed = (await listRes.json()) as {
        events: Array<{ id: string; nextRunAtMs: number | null; occurrenceCount: number }>
        latestRunByEvent: Record<string, { status: string; scheduledAtMs: number } | null>
      }
      expect(listed.events).toHaveLength(1)
      expect(listed.events[0]!.occurrenceCount).toBe(1)
      expect(listed.events[0]!.nextRunAtMs).toBeGreaterThan(startAtMs)
      expect(listed.latestRunByEvent[created.event.id]?.status).toBe("dispatched")

      // Next alarm must remain scheduled in the future
      const nextAlarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
      expect(nextAlarm).toBe(listed.events[0]!.nextRunAtMs)

      // Calling alarm() again before nextRunAtMs must NOT duplicate the run or send a second event
      await runInDurableObject(stub, async (instance) => {
        await (instance as unknown as { alarm(): Promise<void> }).alarm()
      })
      const afterRepeat = fx.receivedFrames.filter(
        (frame) => typeof frame === "object" && frame !== null && (frame as { type?: string }).type === "agent:event",
      )
      expect(afterRepeat).toHaveLength(1)
    } finally {
      fx.close()
    }
  })

  it("targets forum post thread (/server/forum/#seq) instead of posting a new forum title", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, channelType: "forum" })
    try {
      const startAtMs = Date.now() - 1000
      const createRes = await worker.fetch(new Request(`https://worker.test/owner-calendar/${fx.ownerId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerUserId: fx.ownerId,
          createdByUserId: fx.botId,
          title: "Forum check-in",
          description: "Reply inside post",
          startAtMs,
          durationMinutes: 15,
          timeZone: "UTC",
          recurrence: null,
          sourceMessageId: fx.messageId,
          sourceChannelId: fx.channelId,
        }),
      }))
      expect(createRes.status).toBe(201)

      const stub = runtimeEnv.OWNER_CALENDAR_DO.get(
        runtimeEnv.OWNER_CALENDAR_DO.idFromName(`owner-calendar:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)
      await new Promise((r) => setTimeout(r, 30))

      const agentEvents = fx.receivedFrames.filter(
        (frame): frame is { type: string; prompt: string } =>
          typeof frame === "object" && frame !== null && (frame as { type?: string }).type === "agent:event",
      )
      expect(agentEvents).toHaveLength(1)
      expect(agentEvents[0]!.prompt).toContain("/general/#7\"")
      expect(agentEvents[0]!.prompt).not.toContain("--reply \"#7\"")
    } finally {
      fx.close()
    }
  })

  it("keeps run pending when machine is offline, then dispatches via resync-bots after reconnect", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: false })
    let reconnectedClient: WebSocket | null = null
    try {
      const startAtMs = Date.now() - 1000
      const createRes = await worker.fetch(new Request(`https://worker.test/owner-calendar/${fx.ownerId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerUserId: fx.ownerId,
          createdByUserId: fx.botId,
          title: "Offline recovery check",
          description: "Run on reconnect",
          startAtMs,
          durationMinutes: 30,
          timeZone: "UTC",
          recurrence: null,
          sourceMessageId: fx.messageId,
          sourceChannelId: fx.channelId,
        }),
      }))
      const created = (await createRes.json()) as { event: { id: string } }

      const stub = runtimeEnv.OWNER_CALENDAR_DO.get(
        runtimeEnv.OWNER_CALENDAR_DO.idFromName(`owner-calendar:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)

      const beforeList = (await (await worker.fetch(
        new Request(`https://worker.test/owner-calendar/${fx.ownerId}/events`),
      )).json()) as { latestRunByEvent: Record<string, { status: string; lastError: string | null } | null> }
      expect(beforeList.latestRunByEvent[created.event.id]?.status).toBe("pending")
      expect(beforeList.latestRunByEvent[created.event.id]?.lastError).toBe("machine_offline")

      // Daemon reconnects
      const wsDoId = runtimeEnv.WS_DO.idFromName("community-machine:" + fx.doName)
      const upgradeRes = await runtimeEnv.WS_DO.get(wsDoId).fetch(
        new Request("https://worker.test/", {
          headers: { Upgrade: "websocket", Authorization: `Bearer ${fx.credSecret}` },
        }),
      )
      expect(upgradeRes.status).toBe(101)
      reconnectedClient = upgradeRes.webSocket!
      reconnectedClient.accept()
      const frames: unknown[] = []
      reconnectedClient.addEventListener("message", (event) => {
        try { frames.push(JSON.parse(String(event.data))) } catch {}
      })

      const resyncRes = await worker.fetch(new Request(`https://worker.test/owner-calendar/${fx.ownerId}/resync-bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerUserId: fx.ownerId, botIds: [fx.botId] }),
      }))
      expect(resyncRes.status).toBe(200)
      await expect(resyncRes.json()).resolves.toEqual({ attempted: 1, dispatched: 1, blocked: 0 })

      await new Promise((r) => setTimeout(r, 30))
      expect(frames.some((f) => (f as { type?: string }).type === "agent:event")).toBe(true)

      const afterList = (await (await worker.fetch(
        new Request(`https://worker.test/owner-calendar/${fx.ownerId}/events`),
      )).json()) as { latestRunByEvent: Record<string, { status: string; lastError: string | null } | null> }
      expect(afterList.latestRunByEvent[created.event.id]?.status).toBe("dispatched")
      expect(afterList.latestRunByEvent[created.event.id]?.lastError).toBeNull()
    } finally {
      try { reconnectedClient?.close(1000, "done") } catch {}
      fx.close()
    }
  })

  it("marks run blocked_access when bot loses access to the bound message", async () => {
    const fx = await seedHouseholdAndMessage({ machineConnected: true, botIsChannelMember: false })
    try {
      const startAtMs = Date.now() - 1000
      const createRes = await worker.fetch(new Request(`https://worker.test/owner-calendar/${fx.ownerId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerUserId: fx.ownerId,
          createdByUserId: fx.botId,
          title: "Lost access event",
          description: "Should block",
          startAtMs,
          durationMinutes: 30,
          timeZone: "UTC",
          recurrence: null,
          sourceMessageId: fx.messageId,
          sourceChannelId: fx.channelId,
        }),
      }))
      const created = (await createRes.json()) as { event: { id: string } }

      const stub = runtimeEnv.OWNER_CALENDAR_DO.get(
        runtimeEnv.OWNER_CALENDAR_DO.idFromName(`owner-calendar:${fx.ownerId}`),
      )
      await runDurableObjectAlarm(stub)

      const list = (await (await worker.fetch(
        new Request(`https://worker.test/owner-calendar/${fx.ownerId}/events`),
      )).json()) as { latestRunByEvent: Record<string, { status: string; lastError: string | null } | null> }
      expect(list.latestRunByEvent[created.event.id]?.status).toBe("blocked_access")
      expect(list.latestRunByEvent[created.event.id]?.lastError).toBe("source_message_inaccessible")
      expect(fx.receivedFrames.filter((f) => (f as { type?: string }).type === "agent:event")).toHaveLength(0)

      // Confirm DB helper is cleanly wired
      const db = createDb(runtimeEnv.DB)
      expect(await queries.communityBot.getBotWakeContext(db, fx.botId)).toMatchObject({ state: "ready" })
    } finally {
      fx.close()
    }
  })
})
