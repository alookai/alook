import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest } from "@alook/test-utils"

let seed: TestSeed
let conversationId: string

beforeAll(async () => {
  seed = seedTestData()

  const convRes = await tokenRequest(
    `/api/conversations?workspace_id=${seed.workspaceId}`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: seed.agentId }),
    },
  )
  const convData = await convRes.json() as { id: string }
  conversationId = convData.id

  // Send a message to populate conversation
  await tokenRequest(
    `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Init test message" }),
    },
  )
})

afterAll(() => cleanupTestData(seed))

describe("GET /api/conversations/[id]/init", () => {
  it("returns full conversation initialization data", async () => {
    const res = await tokenRequest(
      `/api/conversations/${conversationId}/init?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.conversation).toBeTruthy()
    expect(data.messages).toBeTruthy()
    expect(Array.isArray(data.messages)).toBe(true)
    expect(typeof data.has_more_messages).toBe("boolean")
    expect(typeof data.has_more_conversations).toBe("boolean")
    expect(typeof data.has_more_artifacts).toBe("boolean")
    expect(Array.isArray(data.artifacts)).toBe(true)
    expect(Array.isArray(data.flagged_message_ids)).toBe(true)
    expect(typeof data.cache_valid).toBe("boolean")
    expect(typeof data.message_count).toBe("number")
  })

  it("returns cache_valid=true when newest_message_id matches", async () => {
    // First get the init data to find the newest message id
    const firstRes = await tokenRequest(
      `/api/conversations/${conversationId}/init?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    const firstData = await firstRes.json() as { messages: Array<{ id: string }>; message_count: number }
    const newestMsgId = firstData.messages[0]?.id
    const msgCount = firstData.message_count

    if (newestMsgId) {
      const res = await tokenRequest(
        `/api/conversations/${conversationId}/init?workspace_id=${seed.workspaceId}&newest_message_id=${newestMsgId}&message_count=${msgCount}`,
        seed.machineToken,
      )
      expect(res.status).toBe(200)
      const data = await res.json() as { cache_valid: boolean; messages: unknown }
      expect(data.cache_valid).toBe(true)
      expect(data.messages).toBeNull()
    }
  })

  it("returns 404 for non-existent conversation", async () => {
    const res = await tokenRequest(
      `/api/conversations/conv_nonexistent_xyz/init?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(404)
  })

  it("rejects unauthenticated request", async () => {
    const res = await fetch(
      `${process.env.APP_URL || "http://localhost:3000"}/api/conversations/${conversationId}/init?workspace_id=${seed.workspaceId}`,
    )
    expect(res.status).toBe(401)
  })
})
