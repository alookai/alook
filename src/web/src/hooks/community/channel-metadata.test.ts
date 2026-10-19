import { beforeEach, describe, expect, it, vi } from "vitest"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture as fixture, dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { channelMetadataOptions } from "./channel-metadata"
import { conversationEntryOptions } from "@/lib/community/conversation-entry"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })

describe("channel resource options use the common entry", () => {
  it.each(["text", "forum", "thread", "dm"] as const)("loads a scoped %s through the canonical entry door", async type => {
    const { client, registry } = await createCommunityQueryOwner()
    const packet = type === "dm" ? dmConversationEntryFixture() : fixture()
    packet.channel.type = type
    packet.surfaceReceipt.surfaceKind = type === "text" ? "channel" : type
    if (type === "thread") {
      packet.channel.parentChannelId = "parent"
      packet.channel.parentMessageId = "opener"
    }
    load.mockResolvedValue(packet)
    const serverId = type === "dm" ? null : "s1"
    const metadata = channelMetadataOptions(client, serverId, "c1")
    expect(metadata.queryKey).toEqual(conversationEntryOptions(client, { channelId: "c1", serverId }).queryKey)
    await client.query({ ...metadata, select: undefined })
    expect(load.mock.calls.map(([path]) => path)).toEqual(["/api/community/channels/c1/messages?entry=1"])
    expect(registry.collections.channels.get("c1")).toMatchObject({ id: "c1", type, serverId, resourceComplete: true })
  })

  it("validates scope before exposing identity or body", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    load.mockResolvedValue({ ...fixture(), viewerId: "foreign" })
    await expect(client.query({ ...channelMetadataOptions(client, "s1", "c1"), retry: false, select: undefined })).rejects.toThrow("target mismatch")
    expect(registry.collections.channels.get("c1")).toBeUndefined()
    expect(registry.collections.messages.get("m1")).toBeUndefined()
  })
})
