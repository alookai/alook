import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient, type InfiniteData } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { appendBotAuditEvent, useBotAuditLog, UNOBSERVED_AUDIT_HEAD_LIMIT, type AuditEvent, type AuditLogPage } from "./use-bot-audit-log"
import { communityKeys } from "@/lib/query-keys"

const mockApiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
}))

function renderAuditLog(botId: string | null, queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })) {
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
  return { ...renderHook(() => useBotAuditLog(botId), { wrapper: Wrapper }), queryClient }
}

beforeEach(() => {
  mockApiFetch.mockReset()
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

    const { result, queryClient } = renderAuditLog("b1")
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e1"])
    })

    act(() => {
      appendBotAuditEvent(queryClient, "b1", {
        id: "e1",
        kind: "tool_call",
        payload: { name: "Read" },
        sessionId: null,
        launchId: null,
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

    const { result, queryClient } = renderAuditLog("b1")
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e_old"])
    })

    act(() => {
      appendBotAuditEvent(queryClient, "b1", {
        id: "e_new",
        kind: "cli_invocation",
        payload: { subcommand: "send" },
        sessionId: null,
        launchId: null,
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

    const { result, queryClient } = renderAuditLog("b1")
    await waitFor(() => {
      expect(result.current.events.map((event) => event.id)).toEqual(["e1"])
    })

    act(() => {
      appendBotAuditEvent(queryClient, "b2", {
        id: "e_other_bot",
        kind: "tool_call",
        payload: { name: "Write" },
        sessionId: null,
        launchId: null,
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

const auditEvent = (id: string, minute: number): AuditEvent => ({
  id, kind: "tool_call", payload: { id }, sessionId: null, launchId: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
})
const cursor = { beforeCreatedAt: auditEvent("head", 1).createdAt, beforeId: "head" }

function heldPage() {
  let resolve!: (page: AuditLogPage) => void
  const promise = new Promise<AuditLogPage>((done) => { resolve = done })
  return { promise, resolve }
}

describe("canonical audit pagination and retention", () => {
  it("keeps a WS head while fetchNextPage waits for an older HTTP page", async () => {
    const held = heldPage()
    mockApiFetch.mockResolvedValueOnce({ events: [auditEvent("head", 1)], nextCursor: cursor })
      .mockReturnValueOnce(held.promise)
    const { result, queryClient } = renderAuditLog("b1")
    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual(["head"]))
    let fetching!: Promise<unknown>
    act(() => { fetching = result.current.fetchNextPage() })
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2))
    act(() => { appendBotAuditEvent(queryClient, "b1", auditEvent("live", 2)) })
    await act(async () => {
      held.resolve({ events: [auditEvent("head", 1), auditEvent("old", 0)], nextCursor: null })
      await fetching
    })
    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual(["live", "head", "old"]))
    expect(queryClient.getQueryData<InfiniteData<AuditLogPage>>(communityKeys.botAuditLog("b1"))?.pageParams).toEqual([null, cursor])
    expect(result.current.hasNextPage).toBe(false)
  })

  it("keeps a WS head after refetch's head settles while its later page waits", async () => {
    const held = heldPage()
    mockApiFetch.mockResolvedValueOnce({ events: [auditEvent("head", 1)], nextCursor: cursor })
      .mockResolvedValueOnce({ events: [auditEvent("old", 0)], nextCursor: null })
      .mockResolvedValueOnce({ events: [auditEvent("head", 1)], nextCursor: cursor })
      .mockReturnValueOnce(held.promise)
    const { result, queryClient } = renderAuditLog("b1")
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    await act(async () => { await result.current.fetchNextPage() })
    let refetching!: Promise<void>
    act(() => { refetching = queryClient.refetchQueries({ queryKey: communityKeys.botAuditLog("b1"), exact: true }) })
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(4))
    act(() => { appendBotAuditEvent(queryClient, "b1", auditEvent("live", 2)) })
    await act(async () => {
      held.resolve({ events: [auditEvent("old", 0)], nextCursor: null })
      await refetching
    })
    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual(["live", "head", "old"]))
    expect(queryClient.getQueryData<InfiniteData<AuditLogPage>>(communityKeys.botAuditLog("b1"))?.pageParams).toEqual([null, cursor])
    expect(result.current.hasNextPage).toBe(false)
  })

  it("bounds each unobserved head and liveIds without discarding loaded history or cursors", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
    const history = { events: [auditEvent("history", -1)], nextCursor: null }
    queryClient.setQueryData(communityKeys.botAuditLog("b1"), { pages: [{ events: [auditEvent("head", 0)], nextCursor: cursor }, history], pageParams: [null, cursor] }, { updatedAt: 123 })
    for (let n = 1; n <= 350; n++) appendBotAuditEvent(queryClient, "b1", auditEvent(`live-${n}`, n))
    appendBotAuditEvent(queryClient, "b2", auditEvent("other-bot", 500))
    const data = queryClient.getQueryData<InfiniteData<AuditLogPage>>(communityKeys.botAuditLog("b1"))!
    expect(data.pages[0].events).toHaveLength(UNOBSERVED_AUDIT_HEAD_LIMIT)
    expect(data.pages[0].liveIds).toHaveLength(UNOBSERVED_AUDIT_HEAD_LIMIT)
    expect(data.pages[0].events[0].id).toBe("live-350")
    expect(data.pages[0].events.at(-1)?.id).toBe("live-151")
    expect(data.pages[0].nextCursor).toEqual(cursor)
    expect(data.pages[1]).toEqual(history)
    expect(data.pageParams).toEqual([null, cursor])
    expect(queryClient.getQueryState(communityKeys.botAuditLog("b1"))).toMatchObject({ dataUpdatedAt: 123, isInvalidated: true })
    expect(queryClient.getQueryData<InfiniteData<AuditLogPage>>(communityKeys.botAuditLog("b2"))?.pages[0].events.map((e) => e.id)).toEqual(["other-bot"])
    queryClient.clear()
  })

  it("fetches authoritative HTTP history on opening a WS-only seed", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    appendBotAuditEvent(queryClient, "b1", auditEvent("live", 2))
    expect(queryClient.getQueryState(communityKeys.botAuditLog("b1"))?.dataUpdatedAt).toBe(0)
    mockApiFetch.mockResolvedValueOnce({ events: [auditEvent("head", 1)], nextCursor: cursor })
    const { result } = renderAuditLog("b1", queryClient)
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual(["live", "head"]))
    expect(result.current.hasNextPage).toBe(true)
  })
})
