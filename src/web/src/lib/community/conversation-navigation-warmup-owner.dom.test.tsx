import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture, conversationEntryTarget as entryTarget } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { useMessages } from "@/hooks/community/use-messages"
import { ApiError } from "@/lib/errors"
import { startConversationNavigationWarmup } from "./conversation-navigation-warmup"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })
const target = { ...entryTarget, serverId: "s1", href: "/c/channels/s1/c1", viewerId: "viewer", scopeKind: "channel" as const }
async function setup() {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: React.PropsWithChildren) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>
  return { ...owner, wrapper }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe("entry handoff to mounted consumers", () => {
  it("shares prewarm, header and message body through one native request", async () => {
    const { client, wrapper } = await setup()
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const reading = startConversationNavigationWarmup(client, target)
    const hook = renderHook(() => ({ metadata: useChannelMetadata("s1", "c1"), messages: useMessages("c1", { serverId: "s1" }) }), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => { request.resolve(fixture()); await reading })
    await waitFor(() => expect(hook.result.current.messages.messages?.[0]?.content).toBe("Body"))
    expect(hook.result.current.metadata.canRead).toBe(true)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("shares an explicit anchor between route metadata and the actual window", async () => {
    const { wrapper } = await setup()
    const packet = fixture()
    packet.selection = { reason: "explicit_anchor", anchorMessageId: "m1" }
    load.mockResolvedValue(packet)
    const hook = renderHook(() => ({ metadata: useChannelMetadata("s1", "c1", { anchorMessageId: "m1" }),
      messages: useMessages("c1", { serverId: "s1", anchorMessageId: "m1" }) }), { wrapper })
    await waitFor(() => expect(hook.result.current.messages.initialPositionKnown).toBe(true))
    expect(load).toHaveBeenCalledOnce()
    expect(load.mock.calls[0][0]).toBe("/api/community/channels/c1/messages?entry=1&anchor=m1")
    hook.unmount()
  })

  it("rechecks a revoked target once on re-entry without an unblock command", async () => {
    const { registry, wrapper } = await setup()
    registry.runtime.ws.actions.revokeChannelAccess("s1", "c1")
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const hook = renderHook(() => useChannelMetadata("s1", "c1"), { wrapper })
    expect(hook.result.current.denied).toBe(false)
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => { request.resolve(fixture()) })
    await waitFor(() => expect(hook.result.current.canRead).toBe(true))
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it("keeps a fresh denial terminal rather than reprobing after its own generation changes", async () => {
    const { registry, wrapper } = await setup()
    registry.runtime.ws.actions.revokeChannelAccess("s1", "c1")
    load.mockRejectedValue(new ApiError("denied", 403))
    const hook = renderHook(() => useChannelMetadata("s1", "c1"), { wrapper })
    await waitFor(() => expect(hook.result.current.denied).toBe(true))
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })
})
