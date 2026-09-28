import { useEffect } from "react"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Message } from "@alook/shared"
import type { AgentChatPersistenceScope } from "@/lib/agent-chat-persistence"
import { useCachedMessages } from "./use-cached-messages"

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  merge: vi.fn(),
  open: vi.fn(),
}))

vi.mock("@/lib/agent-chat-persistence", () => ({
  getCachedMessages: mocks.get,
  mergeCachedMessages: mocks.merge,
  openAgentChatPersistence: mocks.open,
}))

const scope: AgentChatPersistenceScope = {
  accountId: "account-a",
  workspaceId: "workspace-a",
}
const cachedMessage: Message = {
  id: "message-a",
  conversation_id: "conversation-a",
  role: "user",
  content: "cached",
  task_id: null,
  attachment_ids: null,
  created_at: "2026-01-01T00:00:00.000Z",
}

type Result = ReturnType<typeof useCachedMessages>

function Capture({ onResult }: { onResult: (result: Result) => void }) {
  const result = useCachedMessages("conversation-a", scope)
  useEffect(() => onResult(result), [onResult, result])
  return null
}

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue([cachedMessage])
  mocks.merge.mockReset().mockResolvedValue(undefined)
  mocks.open.mockReset().mockResolvedValue(undefined)
})

describe("useCachedMessages", () => {
  it("opens and paints the account-scoped cache", async () => {
    const results: Result[] = []
    render(<Capture onResult={(result) => { results.push(result) }} />)

    await waitFor(() => expect(results.at(-1)?.cachedMessages).toEqual([cachedMessage]))
    expect(results.at(-1)?.isFromCache).toBe(true)
    expect(mocks.open).toHaveBeenCalledWith(scope)
    expect(mocks.get).toHaveBeenCalledWith("conversation-a", scope)
  })

  it("writes authoritative rows to the same account scope", async () => {
    const results: Result[] = []
    render(<Capture onResult={(result) => { results.push(result) }} />)
    await waitFor(() => expect(results.at(-1)).toBeDefined())

    await act(async () => {
      await results.at(-1)!.writeToCache([cachedMessage], false, 1)
    })

    expect(mocks.merge).toHaveBeenCalledWith(
      "conversation-a",
      [cachedMessage],
      false,
      scope,
      1,
    )
  })
})
