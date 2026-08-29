import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  disposeInboxReadReservation,
  registerInboxReadReservationSurface,
  takeInboxReadReservationNegative,
} from "./inbox-read-reservation"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useInboxUnreads / inboxUnreadsQueryFn", () => {
  it("fetches /inbox/unreads and populates queryClient at communityKeys.inboxUnreads()", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [], dms: [] })
    const { inboxUnreadsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxUnreads()
    await qc.fetchQuery({ queryKey: key, queryFn: inboxUnreadsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/inbox/unreads",
      { signal: expect.any(AbortSignal) },
    )
    expect(qc.getQueryData(key)).toEqual({ servers: [], dms: [] })
  })

  it("aborts an in-flight unread read when the exact query is cancelled", async () => {
    let signal: AbortSignal | undefined
    apiFetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal
      signal.addEventListener("abort", () => reject(new Error("aborted")))
    }))
    const { inboxUnreadsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxUnreads()
    const pending = qc.fetchQuery({ queryKey: key, queryFn: inboxUnreadsQueryFn }).catch(() => undefined)
    await vi.waitFor(() => expect(signal).toBeDefined())
    await qc.cancelQueries({ queryKey: key, exact: true })
    expect(signal?.aborted).toBe(true)
    await pending
  })

  it("fences the production query result until a focused candidate is classified", async () => {
    const data = {
      servers: [{ channels: [{
        channelId: "focused",
        lastMessageAt: "2026-08-27T01:00:00.000Z",
        hasDirectUnread: true,
        children: [],
      }] }],
      dms: [],
    }
    apiFetchMock.mockResolvedValueOnce(data).mockResolvedValueOnce(data)
    const { inboxUnreadsReservedQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(qc, "focused", seen)
    const first = inboxUnreadsReservedQueryFn(qc)()
    void first.catch(() => undefined)
    await vi.waitFor(() => expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: "focused",
    })))

    takeInboxReadReservationNegative(lease)
    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(inboxUnreadsReservedQueryFn(qc)()).resolves.toBe(data)
    disposeInboxReadReservation(qc)
  })

  it("wires the production hook to its live QueryClient across rerenders", async () => {
    apiFetchMock.mockResolvedValue({ servers: [], dms: [] })
    const { useInboxUnreads } = await import("./use-inbox")
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    function Harness() {
      const inbox = useInboxUnreads()
      return React.createElement("span", {
        "data-count": inbox.servers.length + inbox.dms.length,
      })
    }
    const tree = React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Harness),
    )
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(tree)
    })
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    await act(async () => {
      renderer.update(tree)
    })
    expect(renderer.root.findByType("span").props["data-count"]).toBe(0)
    expect(apiFetchMock).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })
})

describe("useInboxMentions / inboxMentionsQueryFn", () => {
  it("fetches /inbox/mentions and populates queryClient at communityKeys.inboxMentions()", async () => {
    apiFetchMock.mockResolvedValueOnce({ mentions: [] })
    const { inboxMentionsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxMentions()
    await qc.fetchQuery({ queryKey: key, queryFn: inboxMentionsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/inbox/mentions")
    expect(qc.getQueryData(key)).toEqual({ mentions: [] })
  })
})

describe("useInboxMarked", () => {
  it("fetches the identity-aware marked feed only when enabled", async () => {
    apiFetchMock.mockResolvedValue({ marked: [] })
    const { useInboxMarked } = await import("./use-inbox")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Harness() {
      const result = useInboxMarked(true)
      return React.createElement("span", { "data-count": result.marked.length })
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })

    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/marks")
    })
    expect(renderer.root.findByType("span").props["data-count"]).toBe(0)
    act(() => renderer.unmount())
  })
})

// WS reconciliation invalidates the shared `inbox()` prefix — both feeds must
// pick it up, otherwise mentions or unread refreshes would silently drop.
describe("communityKeys.inbox() prefix invalidation", () => {
  it("invalidates both inbox queries in a single call", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ servers: [], dms: [] })
      .mockResolvedValueOnce({ mentions: [] })
    const { inboxUnreadsQueryFn, inboxMentionsQueryFn } = await import(
      "./use-inbox"
    )
    const qc = new QueryClient()
    const unreadsKey = communityKeys.inboxUnreads()
    const mentionsKey = communityKeys.inboxMentions()
    await qc.fetchQuery({ queryKey: unreadsKey, queryFn: inboxUnreadsQueryFn })
    await qc.fetchQuery({ queryKey: mentionsKey, queryFn: inboxMentionsQueryFn })

    await qc.invalidateQueries({ queryKey: communityKeys.inbox() })

    expect(qc.getQueryState(unreadsKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(mentionsKey)?.isInvalidated).toBe(true)
  })
})
