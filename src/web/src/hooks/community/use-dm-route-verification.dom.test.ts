import React from "react"
import { onlineManager } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { QueryClientProvider } from "@tanstack/react-query"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { channelMetadataOptions } from "./channel-metadata"
import { startDmRouteVerification, useDmRouteVerification } from "./use-dm-route-verification"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const dm = { id: "dm-a", userId: "peer", name: "Peer", discriminator: "0001", avatar: "P", status: "offline" as const, preview: "" }
const metadata = { id: dm.id, serverId: null, type: "dm", name: null, parentChannelId: null,
  parentMessageId: null, creatorId: null, archived: false, lastMessageAt: null, createdAt: "2026-10-02T00:00:00Z" }
const denied = () => Object.assign(new Error("missing"), { status: 404 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function fixture(strict = false) {
  const { client, registry } = await createCommunityQueryOwner()
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity, gcTime: Infinity } })
  const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(QueryClientProvider,
    { client }, React.createElement(CommunityDbProvider, { registry }, strict ? React.createElement(React.StrictMode, null, children) : children))
  return { client, registry, wrapper }
}

beforeEach(() => {
  apiFetch.mockReset()
})
afterEach(() => onlineManager.setOnline(true))

describe("DM route uses the shared Channel metadata owner", () => {
  it("shares one exact Channel request between imperative and route consumers without another DM-list request", async () => {
    const { client, registry, wrapper } = await fixture(true)
    client.setQueryData(communityKeys.dms(), { conversations: [] })
    const request = deferred<typeof metadata>()
    apiFetch.mockReturnValue(request.promise)
    const first = startDmRouteVerification(client, dm.id)
    const second = startDmRouteVerification(client, dm.id)
    const route = renderHook(() => useDmRouteVerification(dm.id), { wrapper })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    expect(route.result.current.status).toBe("pending")
    await act(async () => request.resolve(metadata))
    await expect(first).resolves.toBe("present")
    await expect(second).resolves.toBe("present")
    await waitFor(() => expect(route.result.current.status).toBe("present"))
    expect(apiFetch).toHaveBeenCalledWith(`/api/community/channels/${dm.id}`, expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
    expect(client.getQueryData(communityKeys.channelMeta(null, dm.id))).toMatchObject({ id: metadata.id })
    expect(client.getQueryData(communityKeys.dms())).toEqual({ conversations: [] })
    expect(registry.runtime.ws.get().channelAccessScopes.size).toBe(0)
    route.unmount()
    client.clear()
  })

  it("reuses the same metadata Query when another Channel consumer has already fetched it", async () => {
    const { client, registry, wrapper } = await fixture()
    apiFetch.mockResolvedValue(metadata)
    await client.fetchQuery(channelMetadataOptions(client, null, dm.id))
    const route = renderHook(() => useDmRouteVerification(dm.id), { wrapper })
    expect(route.result.current.status).toBe("present")
    await expect(startDmRouteVerification(client, dm.id)).resolves.toBe("present")
    expect(apiFetch).toHaveBeenCalledOnce()
    route.unmount()
    client.clear()
  })

  it("a manually cached peer list cannot qualify the target Channel", async () => {
    const { client, registry, wrapper } = await fixture()
    client.setQueryData(communityKeys.dms(), { conversations: [dm] })
    const request = deferred<typeof metadata>()
    apiFetch.mockReturnValue(request.promise)
    const route = renderHook(() => useDmRouteVerification(dm.id), { wrapper })
    expect(route.result.current.status).toBe("pending")
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    await act(async () => request.resolve(metadata))
    await waitFor(() => expect(route.result.current.status).toBe("present"))
    route.unmount()
    client.clear()
  })

  it.each([403, 404])("keeps explicit %s terminal and rejects scope mismatches", async (status) => {
    const { client, registry } = await fixture()
    apiFetch.mockRejectedValueOnce(Object.assign(new Error("denied"), { status }))
    await expect(startDmRouteVerification(client, dm.id)).resolves.toBe("denied")
    apiFetch.mockResolvedValueOnce({ ...metadata, serverId: "server", type: "text" })
    await expect(startDmRouteVerification(client, "other")).rejects.toThrow("scope mismatch")
    expect(client.getQueryData(communityKeys.dms())).toBeUndefined()
    client.clear()
  })

  it("keeps a transient error local across a remount/reconnect and retries only its Channel resource", async () => {
    const { client, registry, wrapper } = await fixture()
    apiFetch.mockRejectedValueOnce(new Error("offline"))
    const hook = ({ key }: { key: string }) => React.createElement(Capture, { key })
    let latest!: ReturnType<typeof useDmRouteVerification>
    function Capture() { latest = useDmRouteVerification(dm.id); return null }
    const { render } = await import("@/test/react-dom-harness")
    const route = render(hook({ key: "first" }), { wrapper })
    await waitFor(() => expect(latest.status).toBe("error"))
    route.rerender(hook({ key: "second" }))
    await act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true) })
    expect(latest.status).toBe("error")
    expect(apiFetch).toHaveBeenCalledOnce()
    apiFetch.mockResolvedValueOnce(metadata)
    await act(async () => latest.retry())
    await waitFor(() => expect(latest.status).toBe("present"))
    expect(apiFetch).toHaveBeenCalledTimes(2)
    route.unmount()
    client.clear()
  })

  it.each(["cancel", "account", "access"] as const)("rejects an old successful metadata response after %s", async (race) => {
    const { client, registry } = await fixture()
    const request = deferred<typeof metadata>()
    apiFetch.mockReturnValue(request.promise)
    const started = startDmRouteVerification(client, dm.id)
    const rejection = expect(started).rejects.toBeDefined()
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    if (race === "cancel") await client.cancelQueries({ queryKey: communityKeys.channelMeta(null, dm.id), exact: true })
    else if (race === "account") registry.runtime.ws.actions.activateProfileAccount("other")
    else registry.runtime.ws.setState((state) => ({ ...state, accessEpoch: state.accessEpoch + 1 }))
    request.resolve(metadata)
    await rejection
    expect(client.getQueryData(communityKeys.channelMeta(null, dm.id))).toBeUndefined()
    expect(registry.runtime.ws.get().channelAccessScopes.size).toBe(0)
    client.clear()
  })

  it("releases the last route observer and aborts its metadata request", async () => {
    const { client, registry, wrapper } = await fixture()
    const request = deferred<typeof metadata>()
    apiFetch.mockReturnValue(request.promise)
    const route = renderHook(() => useDmRouteVerification(dm.id), { wrapper })
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    const signal = apiFetch.mock.calls[0][1].signal as AbortSignal
    route.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => request.resolve(metadata))
    expect(client.getQueryData(communityKeys.channelMeta(null, dm.id))).toBeUndefined()
    client.clear()
  })
})
