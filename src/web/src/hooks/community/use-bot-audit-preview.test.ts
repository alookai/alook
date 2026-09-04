import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useBotAuditPreview } from "./use-bot-audit-preview"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

type Result = ReturnType<typeof useBotAuditPreview>
const renderers = new Set<TestRenderer.ReactTestRenderer>()

function renderHook(botId: string | null) {
  const result: { current: Result } = { current: null as never }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  function Probe() {
    result.current = useBotAuditPreview(botId)
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Probe),
      ),
    )
  })
  renderers.add(renderer)
  return { result, queryClient }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function waitFor(predicate: () => boolean, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
  expect(predicate()).toBe(true)
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

  afterEach(() => {
    act(() => {
      for (const renderer of renderers) renderer.unmount()
    })
    renderers.clear()
  })

  it("uses a separate finite limit=10 cache from the full modal", async () => {
    apiFetch.mockResolvedValueOnce({ events: [event("e1", 1)], nextCursor: null })
    const { result, queryClient } = renderHook("b1")
    await waitFor(() => result.current.events.length === 1)

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/bots/b1/audit-log?limit=10",
    )
    expect(result.current.events.map((item) => item.id)).toEqual(["e1"])
    expect(result.current.hasEarlierEvents).toBe(false)
    expect(queryClient.getQueryData(communityKeys.botAuditPreview("b1"))).toBeDefined()
    expect(queryClient.getQueryData(communityKeys.botAuditLog("b1"))).toBeUndefined()
  })

  it("does no request when ownership gating passes a null bot id", async () => {
    renderHook(null)
    await flush()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("merges live events, deduplicates by id, orders newest first, and caps ten", async () => {
    apiFetch.mockResolvedValueOnce({
      events: Array.from({ length: 9 }, (_, index) => event(`e${index + 1}`, index + 1)),
      nextCursor: null,
    })
    const { result } = renderHook("b1")
    await waitFor(() => result.current.events.length === 9)

    act(() => {
      useCommunityWsStore.getState().pushBotAuditEvent({
        ...event("e2", 12),
        botId: "b1",
      })
      useCommunityWsStore.getState().pushBotAuditEvent({
        ...event("e10", 10),
        botId: "b1",
      })
      useCommunityWsStore.getState().pushBotAuditEvent({
        ...event("e11", 11),
        botId: "b1",
      })
    })
    await waitFor(() => result.current.events[0]?.id === "e2")

    expect(result.current.events.map((item) => item.id)).toEqual([
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
    expect(result.current.hasEarlierEvents).toBe(true)
  })

  it("reports a server cursor as earlier omitted activity", async () => {
    apiFetch.mockResolvedValueOnce({
      events: [event("e1", 1)],
      nextCursor: { beforeCreatedAt: "2026-01-01T00:00:01.000Z", beforeId: "e1" },
    })
    const { result } = renderHook("b1")
    await waitFor(() => result.current.events.length === 1)
    expect(result.current.hasEarlierEvents).toBe(true)
  })

  it("orders equal timestamps by descending event id", async () => {
    apiFetch.mockResolvedValueOnce({
      events: [event("e1", 1), event("e3", 1), event("e2", 1)],
      nextCursor: null,
    })
    const { result } = renderHook("b1")
    await waitFor(() => result.current.events.length === 3)

    expect(result.current.events.map((item) => item.id)).toEqual(["e3", "e2", "e1"])
  })

  it("reports authoritative 404s so a stale owned card can hide the preview", async () => {
    apiFetch.mockRejectedValueOnce(new ApiError("not found", 404))
    const { result } = renderHook("b1")
    await waitFor(() => result.current.isNotFound)
    expect(result.current.isNotFound).toBe(true)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})
