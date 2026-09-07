import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { useBotAuditLog } from "./use-bot-audit-log"
import { useCommunityWsStore } from "@/stores/community/ws"

const mockApiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
}))

function renderAuditLog(botId: string | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
  return renderHook(() => useBotAuditLog(botId), { wrapper: Wrapper })
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

    const { result } = renderAuditLog("b1")
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e1"])
    })

    act(() => {
      useCommunityWsStore.getState().pushBotAuditEvent({
        id: "e1",
        botId: "b1",
        kind: "tool_call",
        payload: { name: "Read" },
        createdAt: "2025-01-01T00:00:00.000Z",
      })
    })
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e1"])
    })
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

    const { result } = renderAuditLog("b1")
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e_old"])
    })

    act(() => {
      useCommunityWsStore.getState().pushBotAuditEvent({
        id: "e_new",
        botId: "b1",
        kind: "cli_invocation",
        payload: { subcommand: "send" },
        createdAt: "2025-01-01T00:00:05.000Z",
      })
    })
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e_new", "e_old"])
    })
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

    const { result } = renderAuditLog("b1")
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e1"])
    })

    act(() => {
      useCommunityWsStore.getState().pushBotAuditEvent({
        id: "e_other_bot",
        botId: "b2",
        kind: "tool_call",
        payload: { name: "Write" },
        createdAt: "2025-01-01T00:00:05.000Z",
      })
    })
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e1"])
    })
  })

  it("is disabled when botId is null — no fetch happens", () => {
    renderAuditLog(null)
    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})
