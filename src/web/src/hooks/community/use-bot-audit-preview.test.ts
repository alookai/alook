import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useBotAuditPreview } from "./use-bot-audit-preview"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

type Result = ReturnType<typeof useBotAuditPreview>

function renderHook(botId: string | null) {
  const result: { current: Result } = { current: null as never }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  function Probe() {
    result.current = useBotAuditPreview(botId)
    return null
  }
  act(() => {
    TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Probe),
      ),
    )
  })
  return { result, queryClient }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const event = (id: string, second: number) => ({
  id,
  kind: "tool_call" as const,
  payload: { private: id },
  sessionId: null,
  launchId: null,
  createdAt: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
})

describe("useBotAuditPreview", () => {
  beforeEach(() => {
    apiFetch.mockReset()
    useCommunityWsStore.getState().reset()
  })

  it("uses a separate finite limit=5 cache from the full modal", async () => {
    apiFetch.mockResolvedValueOnce({ events: [event("e1", 1)], nextCursor: null })
    const { result, queryClient } = renderHook("b1")
    await flush()
    await flush()

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/bots/b1/audit-log?limit=5",
    )
    expect(result.current.events.map((item) => item.id)).toEqual(["e1"])
    expect(queryClient.getQueryData(communityKeys.botAuditPreview("b1"))).toBeDefined()
    expect(queryClient.getQueryData(communityKeys.botAuditLog("b1"))).toBeUndefined()
  })

  it("does no request when ownership gating passes a null bot id", async () => {
    renderHook(null)
    await flush()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("merges live events, deduplicates by id, orders newest first, and caps five", async () => {
    apiFetch.mockResolvedValueOnce({
      events: [event("e1", 1), event("e2", 2), event("e3", 3), event("e4", 4)],
      nextCursor: null,
    })
    const { result } = renderHook("b1")
    await flush()

    act(() => {
      useCommunityWsStore.getState().pushBotAuditEvent({
        ...event("e2", 12),
        botId: "b1",
      })
      useCommunityWsStore.getState().pushBotAuditEvent({
        ...event("e5", 5),
        botId: "b1",
      })
      useCommunityWsStore.getState().pushBotAuditEvent({
        ...event("e6", 6),
        botId: "b1",
      })
    })
    await flush()

    expect(result.current.events.map((item) => item.id)).toEqual([
      "e2",
      "e6",
      "e5",
      "e4",
      "e3",
    ])
  })

  it("reports authoritative 404s so a stale owned card can hide the preview", async () => {
    apiFetch.mockRejectedValueOnce(new ApiError("not found", 404))
    const { result } = renderHook("b1")
    await flush()
    await flush()
    expect(result.current.isNotFound).toBe(true)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})
