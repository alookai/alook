import { beforeEach, describe, expect, it, vi } from "vitest"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture, conversationEntryTarget as entryTarget } from "@/test/conversation-entry-fixtures"
import { communityKeys } from "@/lib/query-keys"
import { conversationEntryOptions } from "./conversation-entry"
import { retireCommunityAccount } from "./account-cache-lifecycle"
import { ApiError } from "@/lib/errors"
import { startConversationNavigationWarmup } from "./conversation-navigation-warmup"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })
const target = { ...entryTarget, serverId: "s1", href: "/c/channels/s1/c1", viewerId: "viewer", scopeKind: "channel" as const }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe("native entry warmup", () => {
  it("joins concurrent intent reads and reuses a covered current window", async () => {
    const { client } = await createCommunityQueryOwner()
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const first = startConversationNavigationWarmup(client, target)
    const second = startConversationNavigationWarmup(client, target)
    expect(load).toHaveBeenCalledOnce()
    request.resolve(fixture())
    await Promise.all([first, second])
    await startConversationNavigationWarmup(client, target)
    expect(load).toHaveBeenCalledOnce()
    expect(client.getQueryData(conversationEntryOptions(client, entryTarget).queryKey)).toBeDefined()
  })

  it("keeps a different historical window and its page parameters", async () => {
    const { client } = await createCommunityQueryOwner()
    const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "old" })
    const previous = { pages: [{ messages: [{ id: "old", seq: 0 }] }], pageParams: [{ mode: "anchor", anchor: "old" }] }
    client.setQueryData(key, previous)
    const packet = fixture()
    packet.selection = { reason: "explicit_anchor", anchorMessageId: "m1" }
    load.mockResolvedValue(packet)
    await startConversationNavigationWarmup(client, { ...target, anchorMessageId: "m1" })
    expect(load.mock.calls[0][0]).toBe("/api/community/channels/c1/messages?entry=1&anchor=m1")
    expect(client.getQueryData(key)).toBe(previous)
  })

  it.each([403, 404])("withdraws the target after an authoritative %s", async status => {
    const { client, registry } = await createCommunityQueryOwner()
    load.mockRejectedValue(new ApiError("denied", status))
    await startConversationNavigationWarmup(client, target)
    expect(registry.runtime.ws.actions.isChannelAccessRevoked("c1", "s1")).toBe(true)
    expect(load).toHaveBeenCalledOnce()
    expect(registry.collections.messages.get("m1")).toBeUndefined()
  })

  it("rejects decoded data after the original owner retires", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const request = deferred<ReturnType<typeof fixture>>()
    load.mockReturnValue(request.promise)
    const reading = startConversationNavigationWarmup(client, target)
    retireCommunityAccount(registry)
    request.resolve(fixture())
    await reading
    expect(registry.collections.messages.get("m1")).toBeUndefined()
  })
})
