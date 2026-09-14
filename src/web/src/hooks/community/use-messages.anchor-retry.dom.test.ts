import { createElement, type PropsWithChildren } from "react"
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useInitialPositionTransition } from "@/components/community/messages/initial-position-transition"
import { useDmMessages, useMessages } from "./use-messages"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const clients: QueryClient[] = []
const renders: Array<{ ids: string[]; phase: string }> = []
const page = { messages: [{ id: "anchor", seq: 1 }, { id: "cached", seq: 2 }], hasMoreOlder: false, hasMoreNewer: false }

beforeEach(() => {
  vi.useFakeTimers()
  apiFetchMock.mockReset()
  useCommunityWsStore.getState().reset()
  useMessageStreamStore.getState().resetAll()
  focusManager.setFocused(true)
  onlineManager.setOnline(true)
  renders.length = 0
})
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
  vi.useRealTimers()
})

async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
}

function mount(kind: "channel" | "dm" = "channel", stale = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  clients.push(client)
  const key = kind === "channel" ? communityKeys.channelMessages("scope") : communityKeys.dmMessages("scope")
  client.setQueryData(key, {
    pages: [{ messages: [{ id: "cached", seq: 2 }], hasMoreOlder: true, hasMoreNewer: false }],
    pageParams: [{ mode: "newest" }],
  }, { updatedAt: Date.now() - (stale ? 120_000 : 0) })
  function Wrapper({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, children) }
  const useFeed = kind === "channel"
    ? (anchor: string) => useMessages("scope", { serverId: "server", lastReadMessageId: anchor })
    : (anchor: string) => useDmMessages("scope", { lastReadMessageId: anchor })
  const rendered = renderHook(({ anchor }) => {
    const feed = useFeed(anchor)
    const position = useInitialPositionTransition({
      firstWindowReady: !feed.isLoading || feed.messages.length > 0,
      authoritativeEmpty: false,
      positionSettled: false,
    })
    renders.push({ ids: feed.messages.map((message) => message.id), phase: position.phase })
    return feed
  }, { wrapper: Wrapper, initialProps: { anchor: "anchor" } })
  return { client, key, rendered }
}

describe("anchor repair retains the message window", () => {
  it.each(["channel", "dm"] as const)("keeps %s rows and initial positioning through failure then retries the anchor", async (kind) => {
    let fail!: (error: Error) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      .mockResolvedValue(page)
    const { rendered } = mount(kind)
    await advance(900)
    expect(renders.at(-1)?.phase).toBe("aurora")
    await act(async () => { fail(new Error("offline")) })
    await advance()
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["cached"])
    await advance(1000)
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/scope/messages?anchor=anchor",
      "/api/community/channels/scope/messages?anchor=anchor",
    ])
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["anchor", "cached"])
    expect(renders.every((row) => row.ids.length > 0 && row.phase !== "skeleton")).toBe(true)
    rendered.unmount()
  })

  it.each(["focus", "online"])("bounds failed retries and allows recovery on %s", async (event) => {
    apiFetchMock.mockRejectedValue(new Error("offline"))
    const { rendered } = mount()
    await advance()
    await advance(1000)
    await advance(2000)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    await advance(60_000)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["cached"])
    apiFetchMock.mockResolvedValue(page)
    act(() => {
      if (event === "focus") { focusManager.setFocused(false); focusManager.setFocused(true) }
      else { onlineManager.setOnline(false); onlineManager.setOnline(true) }
    })
    await advance()
    expect(apiFetchMock).toHaveBeenCalledTimes(4)
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["anchor", "cached"])
    rendered.unmount()
  })

  it("does not restart backoff when ordinary messages update the cached window", async () => {
    apiFetchMock.mockRejectedValue(new Error("offline"))
    const { client, key, rendered } = mount()
    await advance()
    for (let index = 0; index < 5; index++) {
      act(() => {
        client.setQueryData(key, {
          pages: [{ messages: [{ id: "cached", seq: 2 }, { id: `new-${index}`, seq: index + 3 }], hasMoreOlder: true, hasMoreNewer: false }],
          pageParams: [{ mode: "newest" }],
        })
      })
      await advance(40)
    }
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    await advance(1000)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    await advance(2000)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    await advance(10_000)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["cached", "new-4"])
    rendered.unmount()
  })

  it.each(["unmount", "evict", "revoke"])("stops scheduled retries after %s", async (change) => {
    apiFetchMock.mockRejectedValue(new Error("offline"))
    const { client, key, rendered } = mount()
    await advance()
    act(() => {
      if (change === "unmount") rendered.unmount()
      if (change === "evict") client.removeQueries({ queryKey: key, exact: true })
      if (change === "revoke") {
        useCommunityWsStore.getState().revokeChannelAccess("server", "scope")
        rendered.unmount()
      }
    })
    await advance(10_000)
    expect(apiFetchMock).toHaveBeenCalledTimes(change === "evict" ? 2 : 1)
    if (change === "evict") {
      expect(client.getQueryData(key)).toBeUndefined()
      rendered.unmount()
    }
  })

  it("retries the same anchor after the access epoch changes without accepting the old result", async () => {
    let resolveOld!: (value: typeof page) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValue(page)
    const { rendered } = mount()
    await advance()
    act(() => { useCommunityWsStore.setState((state) => ({ accessEpoch: state.accessEpoch + 1 })) })
    await advance()
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["anchor", "cached"])
    await act(async () => { resolveOld({ ...page, messages: [{ id: "old-secret", seq: 1 }] }) })
    await advance()
    expect(rendered.result.current.messages.some((message) => message.id === "old-secret")).toBe(false)
    rendered.unmount()
  })

  it("replaces a stale window only after a retry succeeds", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ...page, messages: [{ id: "anchor", seq: 1 }] })
    const { rendered } = mount("channel", true)
    await advance()
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["cached"])
    await advance(1000)
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["anchor"])
    expect(renders.every((row) => row.ids.length > 0)).toBe(true)
    rendered.unmount()
  })

  it("does not repeat a completed repair when the server window cannot contain a deleted anchor", async () => {
    const remainingPage = { ...page, messages: [{ id: "cached", seq: 2 }] }
    let resolveRefresh!: (value: typeof remainingPage) => void
    apiFetchMock.mockResolvedValueOnce(remainingPage)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve }))
      .mockResolvedValue(remainingPage)
    const { rendered } = mount()
    await advance()
    act(() => { void rendered.result.current.refetch() })
    await advance()
    await act(async () => { resolveRefresh(remainingPage) })
    await advance()
    await advance(10_000)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.messages.map((message) => message.id)).toEqual(["cached"])
    rendered.unmount()
  })

  it("does not restore a window deliberately reset while a fresh repair was pending", async () => {
    let resolveOld!: (value: typeof page) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockImplementation(() => new Promise(() => undefined))
    const { client, key, rendered } = mount()
    await advance()
    await act(async () => {
      void client.resetQueries({ queryKey: key, exact: true })
      resolveOld(page)
      await Promise.resolve()
    })
    await advance()
    expect(client.getQueryData(key)).toBeUndefined()
    rendered.unmount()
  })

  it("ignores an old anchor result after the anchor changes", async () => {
    let resolveOld!: (value: typeof page) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValue({ ...page, messages: [{ id: "new-anchor", seq: 3 }] })
    const { rendered } = mount()
    await advance()
    rendered.rerender({ anchor: "new-anchor" })
    await advance()
    await act(async () => { resolveOld({ ...page, messages: [{ id: "old-secret", seq: 1 }] }) })
    await advance()
    expect(rendered.result.current.messages.some((message) => message.id === "new-anchor")).toBe(true)
    expect(rendered.result.current.messages.some((message) => message.id === "old-secret")).toBe(false)
    rendered.unmount()
  })
})
