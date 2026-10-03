import { createElement, type PropsWithChildren } from "react"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { shouldPersistQueryKey } from "@/lib/query-persister"
import { ApiError } from "@/lib/errors"
import { useServerAdminChannels } from "./use-server-admin-channels"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: apiFetchMock }))

const channel = {
  id: "private-channel", name: "private-channel", category: { id: "cat", name: "Private" },
  creator: { name: "Alice", handle: "alice#0001" }, createdAt: "2026-10-01T00:00:00.000Z",
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
  return { client, wrapper }
}

beforeEach(() => { apiFetchMock.mockReset() })

describe("admin channel list isolation", () => {
  it("does not fetch until enabled and keeps metadata outside persisted/sidebar data", async () => {
    apiFetchMock.mockResolvedValue({ channels: [channel] })
    const { client, wrapper } = setup()
    const rendered = renderHook(({ serverId, isAdmin }) => useServerAdminChannels(serverId, isAdmin), {
      wrapper, initialProps: { serverId: null as string | null, isAdmin: true },
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
    rendered.rerender({ serverId: "server-1", isAdmin: false })
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(rendered.result.current.channels).toBeUndefined()
    rendered.rerender({ serverId: "server-1", isAdmin: true })
    await waitFor(() => expect(rendered.result.current.channels).toEqual([channel]))
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/server-1/channels/admin", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
    expect(client.getQueryData(communityKeys.adminChannels("server-1"))).toEqual({ channels: [channel] })
    expect(shouldPersistQueryKey(communityKeys.adminChannels("server-1"))).toBe(false)
    rendered.unmount()
    await waitFor(() => expect(client.getQueryData(communityKeys.adminChannels("server-1"))).toBeUndefined())
    client.clear()
  })

  it("never displays old server metadata while the next server is loading", async () => {
    apiFetchMock.mockResolvedValueOnce({ channels: [channel] }).mockImplementationOnce(() => new Promise(() => {}))
    const { client, wrapper } = setup()
    const rendered = renderHook(({ serverId }) => useServerAdminChannels(serverId, true), {
      wrapper, initialProps: { serverId: "server-1" },
    })
    await waitFor(() => expect(rendered.result.current.channels).toEqual([channel]))
    rendered.rerender({ serverId: "server-2" })
    expect(rendered.result.current.channels).toBeUndefined()
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/server-2/channels/admin", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" })))
    rendered.unmount()
    client.clear()
  })

  it("hides already loaded data immediately after role loss", async () => {
    apiFetchMock.mockResolvedValue({ channels: [channel] })
    const { client, wrapper } = setup()
    const rendered = renderHook(({ isAdmin }) => useServerAdminChannels("server-1", isAdmin), {
      wrapper, initialProps: { isAdmin: true },
    })
    await waitFor(() => expect(rendered.result.current.channels).toEqual([channel]))
    rendered.rerender({ isAdmin: false })
    expect(rendered.result.current.channels).toBeUndefined()
    expect(apiFetchMock).toHaveBeenCalledOnce()
    rendered.unmount()
    client.clear()
  })

  it("retains metadata on a transient refresh failure, but hides it after a 403", async () => {
    apiFetchMock.mockResolvedValueOnce({ channels: [channel] })
      .mockRejectedValueOnce(new ApiError("offline", 0))
      .mockRejectedValueOnce(new ApiError("forbidden", 403))
    const { client, wrapper } = setup()
    const rendered = renderHook(() => useServerAdminChannels("server-1", true), { wrapper })
    await waitFor(() => expect(rendered.result.current.channels).toEqual([channel]))
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current.isError).toBe(true))
    expect(rendered.result.current.channels).toEqual([channel])
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current.forbidden).toBe(true))
    expect(rendered.result.current.channels).toBeUndefined()
    rendered.unmount()
    client.clear()
  })

  it("passes an abort signal that cancels an in-flight request on close", async () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const { client, wrapper } = setup()
    const rendered = renderHook(() => useServerAdminChannels("server-1", true), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    const signal = apiFetchMock.mock.calls[0][1].signal as AbortSignal
    rendered.unmount()
    expect(signal.aborted).toBe(true)
    client.clear()
  })
})
