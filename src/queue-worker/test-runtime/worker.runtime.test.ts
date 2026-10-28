/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { createDb, queries, type HostCommand } from "@alook/shared"
import { communityMachine } from "../../shared/src/db/community-machine-schema"

type RuntimeQueueMessage<T> = {
  id: string
  timestamp: Date
  attempts: number
  body: T
}

type RuntimeQueueResult = {
  outcome: string
  explicitAcks: string[]
  retryMessages: Array<{ msgId: string; delaySeconds?: number }>
}

const runtimeEnv = env as unknown as { DB: D1Database; WS_DO_WORKER: Fetcher }
const worker = (exports as unknown as {
  default: {
    fetch(request: Request): Promise<Response>
    queue(queueName: string, messages: RuntimeQueueMessage<unknown>[]): Promise<RuntimeQueueResult>
  }
}).default

describe("queue-worker workerd runtime", () => {
  it("loads production migrations and serves the production entrypoint", async () => {
    const schema = await runtimeEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).bind("community_message").first<{ name: string }>()
    expect(schema?.name).toBe("community_message")

    const response = await worker.fetch(new Request("https://worker.test/health"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })

  it("rejects invalid JSON and non-POST dev requests at the real entrypoint", async () => {
    const malformed = await worker.fetch(new Request("https://worker.test/", {
      method: "POST",
      body: "not json",
    }))
    expect(malformed.status).toBe(400)

    const method = await worker.fetch(new Request("https://worker.test/"))
    expect(method.status).toBe(405)
  })

  it.each([
    ["v1", (messageId: string, botUserId: string) => ({ version: 1, kind: "bot-wake", messageId, botUserId })],
  ])("acks a permanent D1 miss for a %s task through the real queue entrypoint", async (_name, makeBody) => {
    const id = `runtime-${crypto.randomUUID()}`
    const messageId = `missing-message-${crypto.randomUUID()}`
    const botUserId = `missing-bot-${crypto.randomUUID()}`
    const result = await worker.queue("alook-queue", [{
      id,
      timestamp: new Date(),
      attempts: 1,
      body: makeBody(messageId, botUserId),
    }])

    expect(result.outcome).toBe("ok")
    expect(result.explicitAcks).toContain(id)
    expect(result.retryMessages).toEqual([])
  })

  it("ACKs a mobile-push task when its message no longer exists", async () => {
    const id = `runtime-${crypto.randomUUID()}`
    const result = await worker.queue("alook-queue", [{
      id,
      timestamp: new Date(),
      attempts: 1,
      body: {
        version: 1,
        kind: "mobile-push",
        messageId: `missing-message-${crypto.randomUUID()}`,
        userId: `missing-user-${crypto.randomUUID()}`,
      },
    }])

    expect(result.outcome).toBe("ok")
    expect(result.explicitAcks).toContain(id)
    expect(result.retryMessages).toEqual([])
  })

  it("ACKs poison messages while retrying transient mobile and bot failures", async () => {
    const mobileId = `runtime-mobile-${crypto.randomUUID()}`
    const botId = `runtime-bot-${crypto.randomUUID()}`
    const poisonId = `runtime-poison-${crypto.randomUUID()}`
    const unversionedId = `runtime-unversioned-${crypto.randomUUID()}`
    const currentWake = { version: 1, kind: "bot-wake", messageId: `message-${crypto.randomUUID()}`, botUserId: `bot-${crypto.randomUUID()}` }
    await runtimeEnv.DB.prepare(
      "ALTER TABLE community_message RENAME TO community_message_unavailable",
    ).run()
    try {
      const result = await worker.queue("alook-queue", [
        {
          id: mobileId,
          timestamp: new Date(),
          attempts: 1,
          body: {
            version: 1,
            kind: "mobile-push",
            messageId: `message-${crypto.randomUUID()}`,
            userId: `user-${crypto.randomUUID()}`,
          },
        },
        {
          id: botId,
          timestamp: new Date(),
          attempts: 1,
          body: currentWake,
        },
        {
          id: unversionedId, timestamp: new Date(), attempts: 1,
          body: { messageId: currentWake.messageId, botUserId: currentWake.botUserId },
        },
        {
          id: poisonId,
          timestamp: new Date(),
          attempts: 1,
          body: { version: 1, kind: "unknown" },
        },
      ])

      expect(result.outcome).toBe("ok")
      expect(result.explicitAcks).toContain(poisonId)
      expect(result.explicitAcks).toContain(unversionedId)
      expect(result.retryMessages.some(message => message.msgId === unversionedId)).toBe(false)
      expect(result.explicitAcks).not.toContain(mobileId)
      expect(result.retryMessages).toContainEqual({ msgId: mobileId, delaySeconds: 5 })
      expect(result.explicitAcks).not.toContain(botId)
      expect(result.retryMessages).toContainEqual({ msgId: botId, delaySeconds: 5 })
    } finally {
      await runtimeEnv.DB.prepare(
        "ALTER TABLE community_message_unavailable RENAME TO community_message",
      ).run()
    }
    const recovered = await worker.queue("alook-queue", [{ id: botId, timestamp: new Date(), attempts: 2, body: currentWake }])
    expect(recovered.explicitAcks).toContain(botId)
    expect(recovered.retryMessages).toEqual([])
  })

  it("executes current tasks from real D1 and recovers only the failed sibling with a stable wake identity", async () => {
    const db = createDb(runtimeEnv.DB)
    const owner = await queries.user.createUser(db, { name: "QueueOwner", email: `${crypto.randomUUID()}@runtime.test` })
    const machineId = `cm_${crypto.randomUUID()}`
    await db.insert(communityMachine).values({ id: machineId, userId: owner.id, displayName: "Runtime machine", status: "online" })
    const bot = await queries.communityBot.createBot(db, { ownerId: owner.id, name: "QueueBot", machineId, runtime: "codex" })
    const dm = await queries.communityDm.createOrGetDM(db, { userId1: owner.id, userId2: bot.botId })
    const first = await queries.communityMessage.createMessage(db, { channelId: dm.id, authorId: owner.id, authorKind: "human", content: "First current task" })
    const second = await queries.communityMessage.createMessage(db, { channelId: dm.id, authorId: owner.id, authorKind: "human", content: "Second current task" })
    const firstTask = { version: 1, kind: "bot-wake", messageId: first.id, botUserId: bot.botId }
    const secondTask = { ...firstTask, messageId: second.id }
    const ids = { old: crypto.randomUUID(), first: crypto.randomUUID(), second: crypto.randomUUID(), missing: crypto.randomUUID() }
    await runtimeEnv.WS_DO_WORKER.fetch("http://internal/test/fail-once", {
      method: "POST", body: JSON.stringify({ agentId: bot.botId, seq: second.seq }),
    })
    const result = await worker.queue("alook-queue", [
      { id: ids.old, timestamp: new Date(), attempts: 1, body: { messageId: first.id, botUserId: bot.botId } },
      { id: ids.first, timestamp: new Date(), attempts: 1, body: firstTask },
      { id: ids.second, timestamp: new Date(), attempts: 1, body: secondTask },
      { id: ids.missing, timestamp: new Date(), attempts: 1, body: { ...firstTask, messageId: `missing-${crypto.randomUUID()}` } },
    ])
    expect(result.explicitAcks.sort()).toEqual([ids.old, ids.first, ids.missing].sort())
    expect(result.retryMessages).toEqual([{ msgId: ids.second, delaySeconds: 5 }])

    type WakeReceipt = { path: string; command: Extract<HostCommand, { type: "agent:wake" }> }
    const readWakes = async () => {
      const receipts = await (await runtimeEnv.WS_DO_WORKER.fetch("http://internal/test/wakes")).json() as WakeReceipt[]
      return receipts.filter(receipt => receipt.command.agentId === bot.botId)
    }
    const beforeRetry = await readWakes()
    expect(beforeRetry).toHaveLength(2)
    expect(beforeRetry.map(receipt => receipt.command.unreadNotice.latestSeq).sort()).toEqual([first.seq, second.seq])
    for (const receipt of beforeRetry) {
      expect(receipt.path).toBe(`/community-machine/by-id/${machineId}/forward-agent-wake`)
      expect(receipt.command.type).toBe("agent:wake")
      expect(receipt.command.config).toMatchObject({ runtime: "codex" })
      expect(receipt.command.unreadNotice).toEqual({ kind: "unread_notice", channel: `/.dm/${owner.name}#${owner.discriminator}`, channelId: dm.id, latestSeq: receipt.command.unreadNotice.latestSeq })
    }
    const failedWake = beforeRetry.find(receipt => receipt.command.unreadNotice.latestSeq === second.seq)!
    const recovered = await worker.queue("alook-queue", [{ id: ids.second, timestamp: new Date(), attempts: 2, body: secondTask }])
    expect(recovered.explicitAcks).toEqual([ids.second])
    expect(recovered.retryMessages).toEqual([])
    const afterRetry = await readWakes()
    expect(afterRetry).toHaveLength(3)
    expect(afterRetry.filter(receipt => receipt.command.unreadNotice.latestSeq === first.seq)).toHaveLength(1)
    expect(afterRetry.at(-1)?.command).toEqual(failedWake.command)
    const audits = await queries.communityBotAuditLog.listOwnedBotActivityEvents(db, { botId: bot.botId, ownerUserId: owner.id })
    expect(audits).toHaveLength(3)
    expect(audits?.every(audit => audit.kind === "wake_trigger")).toBe(true)
    expect(audits?.map(audit => JSON.parse(audit.payload).messageId).sort()).toEqual([first.id, second.id, second.id].sort())
  })
})
