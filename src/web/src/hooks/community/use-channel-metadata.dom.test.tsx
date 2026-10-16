import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { dmConversationEntryFixture as fixture, conversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider, useDmProjection } from "@/lib/community-db/projections"
import { conversationEntryOptions } from "@/lib/community/conversation-entry"
import { applyCommunityDmBlockAccess, captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { ConversationReadTimeoutError } from "@/lib/community/conversation-read"
import { COMMUNITY_CONVERSATION_ANCHOR_MISSING } from "@alook/shared"
import { ApiError } from "@/lib/errors"
import { useChannelMetadata } from "./use-channel-metadata"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })
const target = { channelId: "c1", serverId: null }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function setup() {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: React.PropsWithChildren) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>
  const qualify = async () => {
    load.mockResolvedValue(fixture())
    await owner.client.query({ ...conversationEntryOptions(owner.client, target), select: undefined })
    load.mockReset()
  }
  return { ...owner, wrapper, qualify }
}

describe("qualified canonical channel identity", () => {
  it("resolves a cold DM and its actual peer without waiting for the full directory", async () => {
    const { client, wrapper } = await setup()
    load.mockResolvedValue(fixture())
    const hook = renderHook(() => ({ metadata: useChannelMetadata(null, "c1"), dms: useDmProjection() }), { wrapper })
    await waitFor(() => expect(hook.result.current.metadata.canRead).toBe(true))
    await waitFor(() => expect(hook.result.current.dms?.[0]).toMatchObject({ id: "c1", userId: "peer", name: "Peer", avatarVersion: 5 }))
    expect(load).toHaveBeenCalledOnce()
    expect(client.getQueryData(["community", "dms"])).toBeUndefined()
    hook.unmount()
  })

  it("leaves an absent target disabled", async () => {
    const { wrapper } = await setup()
    const hook = renderHook(() => useChannelMetadata(null, undefined), { wrapper })
    expect(hook.result.current.status).toBe("no-target")
    expect(load).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("does not qualify a persisted or structural peer list as current reading permission", async () => {
    const { client, wrapper } = await setup()
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "dms", data: { conversations: [{ id: "c1", userId: "peer", name: "Old peer", discriminator: "0042", avatarVersion: 0, avatar: "P", status: "offline", preview: "old" }] } },
      proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const hook = renderHook(() => useChannelMetadata(null, "c1"), { wrapper })
    expect(hook.result.current.canRead).toBe(false)
    expect(hook.result.current.identityKnown).toBe(false)
    expect(hook.result.current.data).toBeUndefined()
    await act(async () => request.resolve(fixture()))
    await waitFor(() => expect(hook.result.current.canRead).toBe(true))
    hook.unmount()
  })

  it("reuses current permission plus the actual covered window without GET", async () => {
    const { wrapper, qualify } = await setup()
    await qualify()
    const hook = renderHook(() => useChannelMetadata(null, "c1"), { wrapper })
    expect(hook.result.current.status).toBe("readable")
    expect(hook.result.current.data?.name).toBe("")
    expect(load).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("retains current identity on a transient background timeout", async () => {
    const { wrapper, qualify } = await setup()
    await qualify()
    load.mockRejectedValue(new ConversationReadTimeoutError())
    const hook = renderHook(() => useChannelMetadata(null, "c1"), { wrapper })
    await act(async () => { await hook.result.current.retry() })
    expect(hook.result.current.status).toBe("readable")
    expect(hook.result.current.canRead).toBe(true)
    expect(hook.result.current.denied).toBe(false)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it.each([403, 404])("withdraws a prior readable target on explicit %s", async status => {
    const { wrapper, qualify, registry } = await setup()
    await qualify()
    const hook = renderHook(() => useChannelMetadata(null, "c1"), { wrapper })
    load.mockRejectedValue(new ApiError("denied", status))
    await act(async () => { await hook.result.current.retry() })
    await waitFor(() => expect(hook.result.current.denied).toBe(true))
    expect(hook.result.current.canRead).toBe(false)
    expect(registry.collections.messages.get("m1")).toBeUndefined()
    expect(hook.result.current.data).toBeUndefined()
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("withdraws block immediately and requalifies on a later mount", async () => {
    const { wrapper, qualify, registry } = await setup()
    await qualify()
    const first = renderHook(() => useChannelMetadata(null, "c1"), { wrapper })
    await act(async () => applyCommunityDmBlockAccess(registry, "peer", true))
    expect(first.result.current.denied).toBe(true)
    expect(load).not.toHaveBeenCalled()
    first.unmount()
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const second = renderHook(() => useChannelMetadata(null, "c1"), { wrapper })
    expect(second.result.current.denied).toBe(false)
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => request.resolve(fixture()))
    await waitFor(() => expect(second.result.current.canRead).toBe(true))
    second.unmount()
  })

  it("keeps a missing deep-link message local while the fallback qualifies the header", async () => {
    const { wrapper } = await setup()
    load.mockRejectedValueOnce(new ApiError("anchor not found", 404, [COMMUNITY_CONVERSATION_ANCHOR_MISSING])).mockResolvedValue(conversationEntryFixture())
    const hook = renderHook(() => useChannelMetadata("s1", "c1", { anchorMessageId: "gone" }), { wrapper })
    await waitFor(() => expect(hook.result.current.canRead).toBe(true))
    expect(hook.result.current.denied).toBe(false)
    expect(load.mock.calls.map(([path]) => path)).toEqual(["/api/community/channels/c1/messages?entry=1&anchor=gone", "/api/community/channels/c1/messages?entry=1"])
    hook.unmount()
  })

  it("does not publish a late identity after account retirement", async () => {
    const { wrapper, registry } = await setup()
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const hook = renderHook(() => useChannelMetadata(null, "c1"), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => { retireCommunityAccount(registry); request.resolve(fixture()) })
    expect(registry.collections.channels.get("c1")).toBeUndefined()
    expect(hook.result.current.canRead).toBe(false)
    hook.unmount()
  })
})
