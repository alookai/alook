/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

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

const runtimeEnv = env as unknown as { DB: D1Database }
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
    ["legacy", (messageId: string, botUserId: string) => ({ messageId, botUserId })],
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

  it("ACKs caught mobile and poison siblings while retrying only a transient bot failure", async () => {
    const mobileId = `runtime-mobile-${crypto.randomUUID()}`
    const botId = `runtime-bot-${crypto.randomUUID()}`
    const poisonId = `runtime-poison-${crypto.randomUUID()}`
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
          body: {
            version: 1,
            kind: "bot-wake",
            messageId: `message-${crypto.randomUUID()}`,
            botUserId: `bot-${crypto.randomUUID()}`,
          },
        },
        {
          id: poisonId,
          timestamp: new Date(),
          attempts: 1,
          body: { version: 1, kind: "unknown" },
        },
      ])

      expect(result.outcome).toBe("ok")
      expect(result.explicitAcks).toEqual(expect.arrayContaining([mobileId, poisonId]))
      expect(result.explicitAcks).not.toContain(botId)
      expect(result.retryMessages).toContainEqual({ msgId: botId, delaySeconds: 5 })
    } finally {
      await runtimeEnv.DB.prepare(
        "ALTER TABLE community_message_unavailable RENAME TO community_message",
      ).run()
    }
  })
})
