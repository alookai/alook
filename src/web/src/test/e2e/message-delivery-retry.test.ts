import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { MessageDeliveryBatch } from "@alook/shared"

const fake = vi.hoisted(() => ({ url: "" }))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { DEV_WS_DO_URL: fake.url },
    ctx: { waitUntil: vi.fn() },
  }),
}))

import { sendMessageDeliveryBatch } from "../../lib/community/message-delivery-transport"

const requests: MessageDeliveryBatch[] = []
let server: Server

function batch(): MessageDeliveryBatch {
  return {
    messageId: "message-qa-1",
    messageEvent: {
      type: "community:message.create",
      channelId: "channel-qa-1",
      serverId: "server-qa-1",
      message: {
        id: "message-qa-1",
        seq: 3,
        authorId: "author",
        authorName: "Author",
        authorAvatarVersion: 0,
        content: "failed-only retry",
        type: "chat",
        createdAt: "2026-08-18T00:00:00.000Z",
      },
    },
    contentUserIds: ["author", "healthy", "retry"],
    unreadPlainUserIds: ["healthy", "retry"],
    unreadMentionUserIds: [],
    mentionUserIds: [],
  }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      requests.push(JSON.parse(body) as MessageDeliveryBatch)
      response.statusCode = requests.length === 1 ? 207 : 200
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ failedUserIds: requests.length === 1 ? ["retry"] : [] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fake ws-do did not bind")
  fake.url = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe("message delivery failed-only retry QA", () => {
  it("retries only the failed target after a real HTTP 207", async () => {
    await sendMessageDeliveryBatch(batch())

    expect(requests).toHaveLength(2)
    expect(requests[0]?.contentUserIds).toEqual(["author", "healthy", "retry"])
    expect(requests[1]).toMatchObject({
      contentUserIds: ["retry"],
      unreadPlainUserIds: ["retry"],
      unreadMentionUserIds: [],
      mentionUserIds: [],
    })
    expect(requests[1]?.contentUserIds).not.toContain("healthy")
    expect(requests[1]?.contentUserIds).not.toContain("author")
  })
})
