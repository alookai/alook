import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Message } from "@alook/shared"
import {
  appendCachedMessage,
  clearAllAgentChatPersistence,
  clearLastOpenForConversation,
  evictLRU,
  getCachedMessages,
  getCachedMessagesBefore,
  getConvExtras,
  getLastOpenConversation,
  invalidateCache,
  mergeCachedMessages,
  openAgentChatPersistence,
  resetAgentChatPersistenceForTests,
  setConvExtras,
  setLastOpenConversation,
} from "./agent-chat-persistence"

function message(id: string, conversationId = "conv-1", minute = 0): Message {
  return {
    id,
    conversation_id: conversationId,
    role: "user",
    content: id,
    task_id: null,
    attachment_ids: null,
    created_at: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
  }
}

beforeEach(async () => {
  await resetAgentChatPersistenceForTests()
  await openAgentChatPersistence("workspace-a")
})

afterEach(() => {
  vi.useRealTimers()
})

describe("agent chat TanStack collections", () => {
  it("keeps deterministic order, excludes temps, and paginates older rows", async () => {
    await mergeCachedMessages("conv-1", [
      message("m-3", "conv-1", 3),
      message("temp-local", "conv-1", 4),
      message("m-1", "conv-1", 1),
      message("m-2", "conv-1", 2),
    ], false, "workspace-a")

    expect((await getCachedMessages("conv-1", "workspace-a"))?.map((row) => row.id))
      .toEqual(["m-1", "m-2", "m-3"])
    expect(await getCachedMessagesBefore(
      "conv-1",
      message("m-3", "conv-1", 3).created_at,
      "m-3",
      2,
      "workspace-a",
    )).toEqual({
      messages: [message("m-1", "conv-1", 1), message("m-2", "conv-1", 2)],
      hasMore: false,
    })
  })

  it("isolates workspace ids and invalidates messages, pointers, and extras together", async () => {
    await mergeCachedMessages("conv-1", [message("m-a")], false, "workspace-a")
    await mergeCachedMessages("conv-1", [message("m-b")], false, "workspace-b")
    await setLastOpenConversation("agent-1", null, {
      conversation_id: "conv-1",
      newestMessageId: "m-a",
      serverMessageCount: 1,
    }, "workspace-a")
    await setConvExtras("conv-1", {
      artifacts: [],
      conversation_type: "task",
      conversation_title: "One",
      conversation_channel: "",
      conversation_created_at: "2026-01-01T00:00:00.000Z",
      hasMoreArtifacts: false,
    }, "workspace-a")

    expect((await getCachedMessages("conv-1", "workspace-a"))?.[0]?.id).toBe("m-a")
    expect((await getCachedMessages("conv-1", "workspace-b"))?.[0]?.id).toBe("m-b")
    await invalidateCache("conv-1", "workspace-a")
    expect(await getCachedMessages("conv-1", "workspace-a")).toBeNull()
    expect(await getLastOpenConversation("agent-1", null, "workspace-a")).toBeNull()
    expect(await getConvExtras("conv-1", "workspace-a")).toBeNull()
    expect((await getCachedMessages("conv-1", "workspace-b"))?.[0]?.id).toBe("m-b")
  })

  it("clears every workspace registry opened by the signed-in session", async () => {
    await mergeCachedMessages("conv-1", [message("m-a")], false, "workspace-a")
    await mergeCachedMessages("conv-1", [message("m-b")], false, "workspace-b")

    await clearAllAgentChatPersistence()

    expect(await getCachedMessages("conv-1", "workspace-a")).toBeNull()
    expect(await getCachedMessages("conv-1", "workspace-b")).toBeNull()
  })

  it("evicts the least-recently-used conversation and its dependent rows", async () => {
    vi.useFakeTimers()
    for (let index = 0; index < 5; index += 1) {
      vi.setSystemTime(new Date(2026, 0, 1, 0, index))
      const conversationId = `conv-${index}`
      await mergeCachedMessages(
        conversationId,
        [message(`m-${index}`, conversationId, index)],
        false,
        "workspace-a",
      )
      await setLastOpenConversation(`agent-${index}`, null, {
        conversation_id: conversationId,
        newestMessageId: `m-${index}`,
        serverMessageCount: 1,
      }, "workspace-a")
    }

    await evictLRU(3, "workspace-a")
    expect(await getCachedMessages("conv-0", "workspace-a")).toBeNull()
    expect(await getCachedMessages("conv-1", "workspace-a")).toBeNull()
    expect(await getCachedMessages("conv-2", "workspace-a")).not.toBeNull()
    expect(await getLastOpenConversation("agent-0", null, "workspace-a")).toBeNull()
  })

  it("does not append until an authoritative cache meta row exists", async () => {
    await appendCachedMessage("conv-empty", message("m-1", "conv-empty"), "workspace-a")
    expect(await getCachedMessages("conv-empty", "workspace-a")).toBeNull()
    await clearLastOpenForConversation("conv-empty", "workspace-a")
  })
})
