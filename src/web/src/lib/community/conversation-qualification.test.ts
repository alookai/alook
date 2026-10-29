import { describe, expect, it } from "vitest"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { retireCommunityChannelReading } from "@/lib/community-db/sync"
import { retireCommunityAccount } from "./account-cache-lifecycle"
import { captureChannelMetadataToken, conversationListScopeKey, isChannelMetadataTokenCurrent } from "./conversation-qualification"

describe("conversation list lifetime identity", () => {
  it("keeps one lifetime stable while isolating accounts, channels and tags", async () => {
    const alice = await createCommunityQueryOwner("alice")
    const bob = await createCommunityQueryOwner("bob")
    const scope = { proof: captureChannelMetadataToken(alice.client, "A"), tag: null }
    const key = conversationListScopeKey(scope)
    const records = alice.client.getQueryCache().getAll().length
    expect(conversationListScopeKey({ ...scope, proof: captureChannelMetadataToken(alice.client, "A") })).toEqual(key)
    for (const other of [
      { ...scope, proof: captureChannelMetadataToken(bob.client, "A") },
      { ...scope, proof: captureChannelMetadataToken(alice.client, "B") },
      { ...scope, tag: "bug" },
    ]) expect(conversationListScopeKey(other)).not.toEqual(key)
    expect(alice.client.getQueryCache().getAll()).toHaveLength(records)
  })

  it("retires the original channel and account identity through the existing fences", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const scope = { proof: captureChannelMetadataToken(client, "A"), tag: null }
    retireCommunityChannelReading(registry, "A", { reason: "read-denied", serverId: null })
    const next = { ...scope, proof: captureChannelMetadataToken(client, "A") }
    expect(isChannelMetadataTokenCurrent(scope.proof)).toBe(false)
    expect(conversationListScopeKey(next)).not.toEqual(conversationListScopeKey(scope))
    retireCommunityAccount(registry)
    expect(isChannelMetadataTokenCurrent(next.proof)).toBe(false)
    expect(conversationListScopeKey({ ...scope, proof: captureChannelMetadataToken(client, "A") })).not.toEqual(conversationListScopeKey(next))
  })

  it("includes the captured parent access lifetime for a child list", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const scope = { proof: { ...captureChannelMetadataToken(client, "child"), channelLineage: { parentChannelId: "parent" } }, tag: null }
    retireCommunityChannelReading(registry, "parent", { reason: "read-denied", serverId: null })
    const next = { ...scope, proof: { ...captureChannelMetadataToken(client, "child"), channelLineage: { parentChannelId: "parent" } } }
    expect(conversationListScopeKey(next)).not.toEqual(conversationListScopeKey(scope))
  })
})
