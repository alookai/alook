import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Message } from "@alook/shared"
import {
  appendCachedMessage,
  clearAgentChatPersistenceForAccount,
  clearLastOpenForConversation,
  evictLRU,
  getCacheMeta,
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

const accountAWorkspaceA = { accountId: "account-a", workspaceId: "workspace-a" }
const accountAWorkspaceB = { accountId: "account-a", workspaceId: "workspace-b" }
const accountBWorkspaceA = { accountId: "account-b", workspaceId: "workspace-a" }

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
  await openAgentChatPersistence(accountAWorkspaceA)
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
    ], false, accountAWorkspaceA)

    expect((await getCachedMessages("conv-1", accountAWorkspaceA))?.map((row) => row.id))
      .toEqual(["m-1", "m-2", "m-3"])
    expect(await getCachedMessagesBefore(
      "conv-1",
      message("m-3", "conv-1", 3).created_at,
      "m-3",
      2,
      accountAWorkspaceA,
    )).toEqual({
      messages: [message("m-1", "conv-1", 1), message("m-2", "conv-1", 2)],
      hasMore: false,
    })
  })

  it("isolates workspace ids and invalidates messages, pointers, and extras together", async () => {
    await mergeCachedMessages("conv-1", [message("m-a")], false, accountAWorkspaceA)
    await mergeCachedMessages("conv-1", [message("m-b")], false, accountAWorkspaceB)
    await setLastOpenConversation("agent-1", null, {
      conversation_id: "conv-1",
      newestMessageId: "m-a",
      serverMessageCount: 1,
    }, accountAWorkspaceA)
    await setConvExtras("conv-1", {
      artifacts: [],
      conversation_type: "task",
      conversation_title: "One",
      conversation_channel: "",
      conversation_created_at: "2026-01-01T00:00:00.000Z",
      hasMoreArtifacts: false,
    }, accountAWorkspaceA)

    expect((await getCachedMessages("conv-1", accountAWorkspaceA))?.[0]?.id).toBe("m-a")
    expect((await getCachedMessages("conv-1", accountAWorkspaceB))?.[0]?.id).toBe("m-b")
    await invalidateCache("conv-1", accountAWorkspaceA)
    expect(await getCachedMessages("conv-1", accountAWorkspaceA)).toBeNull()
    expect(await getLastOpenConversation("agent-1", null, accountAWorkspaceA)).toBeNull()
    expect(await getConvExtras("conv-1", accountAWorkspaceA)).toBeNull()
    expect((await getCachedMessages("conv-1", accountAWorkspaceB))?.[0]?.id).toBe("m-b")
  })

  it("isolates identical workspace ids by account and clears only the requested account", async () => {
    await mergeCachedMessages("conv-1", [message("m-a")], false, accountAWorkspaceA)
    await mergeCachedMessages("conv-1", [message("m-b")], false, accountBWorkspaceA)

    expect((await getCachedMessages("conv-1", accountAWorkspaceA))?.[0]?.id).toBe("m-a")
    expect((await getCachedMessages("conv-1", accountBWorkspaceA))?.[0]?.id).toBe("m-b")
    await clearAgentChatPersistenceForAccount("account-a")

    expect(await getCachedMessages("conv-1", accountAWorkspaceA)).toBeNull()
    expect((await getCachedMessages("conv-1", accountBWorkspaceA))?.[0]?.id).toBe("m-b")
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
        accountAWorkspaceA,
      )
      await setLastOpenConversation(`agent-${index}`, null, {
        conversation_id: conversationId,
        newestMessageId: `m-${index}`,
        serverMessageCount: 1,
      }, accountAWorkspaceA)
    }

    await evictLRU(3, accountAWorkspaceA)
    expect(await getCachedMessages("conv-0", accountAWorkspaceA)).toBeNull()
    expect(await getCachedMessages("conv-1", accountAWorkspaceA)).toBeNull()
    expect(await getCachedMessages("conv-2", accountAWorkspaceA)).not.toBeNull()
    expect(await getLastOpenConversation("agent-0", null, accountAWorkspaceA)).toBeNull()
  })

  it("does not append until an authoritative cache meta row exists", async () => {
    await appendCachedMessage("conv-empty", message("m-1", "conv-empty"), accountAWorkspaceA)
    expect(await getCachedMessages("conv-empty", accountAWorkspaceA)).toBeNull()
    await clearLastOpenForConversation("conv-empty", accountAWorkspaceA)
  })

  it("updates cached rows, metadata, pointers, and extras", async () => {
    await mergeCachedMessages("conv-1", [message("m-1")], true, accountAWorkspaceA, 1)
    await mergeCachedMessages("conv-1", [{ ...message("m-1"), content: "updated" }], null, accountAWorkspaceA)
    await appendCachedMessage("conv-1", message("m-2", "conv-1", 2), accountAWorkspaceA)
    await appendCachedMessage("conv-1", { ...message("m-2", "conv-1", 2), content: "latest" }, accountAWorkspaceA)
    await appendCachedMessage("conv-1", message("temp-local"), accountAWorkspaceA)

    expect((await getCachedMessages("conv-1", accountAWorkspaceA))?.map((row) => row.content))
      .toEqual(["updated", "latest"])
    expect(await getCacheMeta("conv-1", accountAWorkspaceA)).toEqual(expect.objectContaining({
      messageCount: 2,
      newestMessageId: "m-2",
      hasMore: true,
      serverMessageCount: 1,
    }))

    await setLastOpenConversation("agent-1", "web", {
      conversation_id: "conv-1",
      newestMessageId: "m-1",
      serverMessageCount: 1,
    }, accountAWorkspaceA)
    await setLastOpenConversation("agent-1", "web", {
      conversation_id: "conv-1",
      newestMessageId: "m-2",
      serverMessageCount: 2,
    }, accountAWorkspaceA)
    expect(await getLastOpenConversation("agent-1", "web", accountAWorkspaceA))
      .toEqual(expect.objectContaining({ newestMessageId: "m-2", serverMessageCount: 2 }))
    await clearLastOpenForConversation("conv-1", accountAWorkspaceA)
    expect(await getLastOpenConversation("agent-1", "web", accountAWorkspaceA)).toBeNull()

    const extras = {
      artifacts: [],
      conversation_type: "task",
      conversation_title: "One",
      conversation_channel: "web",
      conversation_created_at: "2026-01-01T00:00:00.000Z",
      hasMoreArtifacts: false,
    }
    await setConvExtras("conv-1", extras, accountAWorkspaceA)
    await setConvExtras("conv-1", { ...extras, conversation_title: "Two" }, accountAWorkspaceA)
    expect(await getConvExtras("conv-1", accountAWorkspaceA))
      .toEqual(expect.objectContaining({ conversation_title: "Two" }))
  })

  it("returns safe empty results when persistence scope is absent", async () => {
    expect(await getCachedMessages("conv-1")).toBeNull()
    expect(await getCachedMessagesBefore("conv-1", "", "", 1)).toBeNull()
    expect(await getCacheMeta("conv-1")).toBeNull()
    expect(await getLastOpenConversation("agent-1", null)).toBeNull()
    expect(await getConvExtras("conv-1")).toBeNull()
    await mergeCachedMessages("conv-1", [message("m-1")], false)
    await appendCachedMessage("conv-1", message("m-1"))
    await setLastOpenConversation("agent-1", null, {
      conversation_id: "conv-1",
      newestMessageId: null,
      serverMessageCount: 0,
    })
    await clearLastOpenForConversation("conv-1")
    await setConvExtras("conv-1", {
      artifacts: [],
      conversation_type: "task",
      conversation_title: "",
      conversation_channel: "",
      conversation_created_at: "",
      hasMoreArtifacts: false,
    })
    await invalidateCache("conv-1")
    await evictLRU()
  })
})
