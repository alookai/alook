/// <reference types="@cloudflare/vitest-plugin/types" />

import type { WakePayload } from "@alook/shared"
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
  retryMessages: Array<{ msgId: string }>
}

const runtimeEnv = env as unknown as { DB: D1Database }
const worker = (exports as unknown as {
  default: {
    fetch(request: Request): Promise<Response>
    queue(queueName: string, messages: RuntimeQueueMessage<WakePayload>[]): Promise<RuntimeQueueResult>
  }
}).default

describe("wake-worker workerd runtime", () => {
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

  it("acks a permanent D1 miss through the real queue entrypoint", async () => {
    const id = `runtime-${crypto.randomUUID()}`
    const result = await worker.queue("alook-wake", [{
      id,
      timestamp: new Date(),
      attempts: 1,
      body: {
        messageId: `missing-message-${crypto.randomUUID()}`,
        botUserId: `missing-bot-${crypto.randomUUID()}`,
      },
    }])

    expect(result.outcome).toBe("ok")
    expect(result.explicitAcks).toContain(id)
    expect(result.retryMessages).toEqual([])
  })
})
