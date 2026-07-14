import { describe, it, expect, beforeEach, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useBotAuditLog } from "./use-bot-audit-log"
import { useCommunityWsStore } from "@/stores/community/ws"

const mockApiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
}))

function renderWithHook(hook: () => ReturnType<typeof useBotAuditLog>) {
  const result: { current: ReturnType<typeof useBotAuditLog> } = { current: null as never }
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  function Probe() {
    result.current = hook()
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(Probe)),
    )
  })
  return { result, renderer }
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  mockApiFetch.mockReset()
  useCommunityWsStore.getState().reset()
})

describe("useBotAuditLog", () => {
  it("dedups a WS-live event whose id also appears in the initial GET page", async () => {
    mockApiFetch.mockResolvedValueOnce({
      events: [
        {
          id: "e1",
          kind: "tool_call",
          payload: { name: "Read" },
          sessionId: null,
          launchId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    })

    const { result } = renderWithHook(() => useBotAuditLog("b1"))
    await flush()
    await flush()
    expect(result.current.events.map((e) => e.id)).toEqual(["e1"])

    act(() => {
      useCommunityWsStore.getState().pushBotAuditEvent({
        id: "e1",
        botId: "b1",
        kind: "tool_call",
        payload: { name: "Read" },
        createdAt: "2025-01-01T00:00:00.000Z",
      })
    })
    await flush()
    expect(result.current.events.map((e) => e.id)).toEqual(["e1"])
  })

  it("prepends a FRESH WS-live event (id not in cache) into the first page", async () => {
    mockApiFetch.mockResolvedValueOnce({
      events: [
        {
          id: "e_old",
          kind: "tool_call",
          payload: { name: "Read" },
          sessionId: null,
          launchId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    })

    const { result } = renderWithHook(() => useBotAuditLog("b1"))
    await flush()
    await flush()

    act(() => {
      useCommunityWsStore.getState().pushBotAuditEvent({
        id: "e_new",
        botId: "b1",
        kind: "cli_invocation",
        payload: { subcommand: "send" },
        createdAt: "2025-01-01T00:00:05.000Z",
      })
    })
    await flush()
    expect(result.current.events.map((e) => e.id)).toEqual(["e_new", "e_old"])
  })

  it("does NOT include events for a different botId (filter isolates)", async () => {
    mockApiFetch.mockResolvedValueOnce({
      events: [
        {
          id: "e1",
          kind: "tool_call",
          payload: { name: "Read" },
          sessionId: null,
          launchId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    })

    const { result } = renderWithHook(() => useBotAuditLog("b1"))
    await flush()
    await flush()

    act(() => {
      useCommunityWsStore.getState().pushBotAuditEvent({
        id: "e_other_bot",
        botId: "b2",
        kind: "tool_call",
        payload: { name: "Write" },
        createdAt: "2025-01-01T00:00:05.000Z",
      })
    })
    await flush()
    expect(result.current.events.map((e) => e.id)).toEqual(["e1"])
  })

  it("is disabled when botId is null — no fetch happens", async () => {
    renderWithHook(() => useBotAuditLog(null))
    await flush()
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})
