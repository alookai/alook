import { appendBotAuditEvent } from "./use-bot-audit-log"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useBotAuditPreview } from "./use-bot-audit-preview"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

function renderBotAuditPreview(botId: string | null, textOnly = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const wrapper = ({ children }: PropsWithChildren) => createElement(
    QueryClientProvider,
    { client: queryClient },
    children,
  )
  return {
    ...renderHook(() => useBotAuditPreview(botId, textOnly), { wrapper }),
    queryClient,
  }
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

  })

  it("derives ten rows from the canonical infinite log cache", async () => {
    apiFetch.mockResolvedValueOnce({ events: [event("e1", 1)], nextCursor: null })
    const rendered = renderBotAuditPreview("b1")
    await waitFor(() => expect(rendered.result.current.events).toHaveLength(1))

    expect(apiFetch).toHaveBeenCalledWith("/api/community/bots/b1/audit-log?limit=50", expect.objectContaining({ assertActive: expect.any(Function) }))
    expect(rendered.result.current.events.map((item) => item.id)).toEqual(["e1"])
    expect(rendered.result.current.hasEarlierEvents).toBe(false)
    expect(rendered.queryClient.getQueryData(communityKeys.botAuditPreview("b1"))).toBeUndefined()
    expect(rendered.queryClient.getQueryData(communityKeys.botAuditLog("b1"))).toBeDefined()
  })

  it("does no request when ownership gating passes a null bot id", async () => {
    renderBotAuditPreview(null)
    await flush()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("merges live events, deduplicates by id, orders newest first, and caps ten", async () => {
    apiFetch.mockResolvedValueOnce({
      events: Array.from({ length: 9 }, (_, index) => event(`e${index + 1}`, index + 1)),
      nextCursor: null,
    })
    const rendered = renderBotAuditPreview("b1")
    await waitFor(() => expect(rendered.result.current.events).toHaveLength(9))

    act(() => {
      appendBotAuditEvent(rendered.queryClient, "b1", { ...event("e2", 12) })
      appendBotAuditEvent(rendered.queryClient, "b1", { ...event("e10", 10) })
      appendBotAuditEvent(rendered.queryClient, "b1", { ...event("e11", 11) })
    })
    await waitFor(() => expect(rendered.result.current.events[0]?.id).toBe("e2"))

    expect(rendered.result.current.events.map((item) => item.id)).toEqual([
      "e2",
      "e11",
      "e10",
      "e9",
      "e8",
      "e7",
      "e6",
      "e5",
      "e4",
      "e3",
    ])
    expect(rendered.result.current.hasEarlierEvents).toBe(true)
  })

  it("reports a server cursor as earlier omitted activity", async () => {
    apiFetch.mockResolvedValueOnce({
      events: [event("e1", 1)],
      nextCursor: { beforeCreatedAt: "2026-01-01T00:00:01.000Z", beforeId: "e1" },
    })
    const rendered = renderBotAuditPreview("b1")
    await waitFor(() => expect(rendered.result.current.events).toHaveLength(1))
    expect(rendered.result.current.hasEarlierEvents).toBe(true)
  })

  it("orders equal timestamps by descending event id", async () => {
    apiFetch.mockResolvedValueOnce({
      events: [event("e1", 1), event("e3", 1), event("e2", 1)],
      nextCursor: null,
    })
    const rendered = renderBotAuditPreview("b1")
    await waitFor(() => expect(rendered.result.current.events).toHaveLength(3))

    expect(rendered.result.current.events.map((item) => item.id)).toEqual(["e3", "e2", "e1"])
  })

  it("reports authoritative 404s so a stale owned card can hide the preview", async () => {
    apiFetch.mockRejectedValueOnce(new ApiError("not found", 404))
    const rendered = renderBotAuditPreview("b1")
    await waitFor(() => expect(rendered.result.current.isNotFound).toBe(true))
    expect(apiFetch).toHaveBeenCalledOnce()
  })
  it("filters text before the ten-row cap without another query or cache", async () => {
    apiFetch.mockResolvedValueOnce({ events: [
      ...Array.from({ length: 11 }, (_, i) => event(`tool-${i}`, i + 10)),
      { ...event("text-1", 1), kind: "text", payload: { text: "An older thought", chars: 16, truncated: false } },
    ], nextCursor: null })
    const rendered = renderBotAuditPreview("b1", true)
    await waitFor(() => expect(rendered.result.current.events.map((row) => row.id)).toEqual(["text-1"]))
    expect(apiFetch).toHaveBeenCalledOnce()
    expect(rendered.queryClient.getQueryData(communityKeys.botAuditLog("b1"))).toBeDefined()
    expect(rendered.queryClient.getQueryData(communityKeys.botAuditPreview("b1"))).toBeUndefined()
  })

  it("ignores live commands in Thoughts and accepts live text from the canonical cache", async () => {
    apiFetch.mockResolvedValueOnce({ events: [], nextCursor: null })
    const rendered = renderBotAuditPreview("b1", true)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    act(() => appendBotAuditEvent(rendered.queryClient, "b1", event("tool", 1)))
    expect(rendered.result.current.events).toHaveLength(0)
    act(() => appendBotAuditEvent(rendered.queryClient, "b1", { ...event("text", 2), kind: "text", payload: { text: "New thought", chars: 11, truncated: false } }))
    await waitFor(() => expect(rendered.result.current.events.map((row) => row.id)).toEqual(["text"]))
  })

})
