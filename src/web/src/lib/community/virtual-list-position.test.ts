import { describe, expect, it } from "vitest"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { captureChannelMetadataToken } from "./conversation-qualification"
import { retireCommunityAccount } from "./account-cache-lifecycle"
import { retireCommunityChannelReading } from "@/lib/community-db/sync"
import { shouldDehydrateCommunityQuery } from "@/lib/query-persister"
import { readVirtualListPosition, saveVirtualListPosition, virtualListLayoutFingerprint, virtualListPositionKey, type VirtualListPositionScope, type VirtualListPositionSnapshot } from "./virtual-list-position"

const snapshot = (fingerprint = "rows"): VirtualListPositionSnapshot => ({
  version: 1, fingerprint, offset: 300, width: 320, height: 500, paddingStart: 0, paddingEnd: 48,
  anchorKey: "m3", anchorOffset: -20, at: Date.now(), measurements: [{ key: "m3", index: 3, start: 280, end: 380, size: 100, lane: 0 }],
})

describe("account-owned virtual layout lifetime", () => {
  it("isolates accounts, conversations, list shapes and tags without storing message bodies", async () => {
    const alice = await createCommunityQueryOwner("alice")
    const bob = await createCommunityQueryOwner("bob")
    const base: VirtualListPositionScope = { proof: captureChannelMetadataToken(alice.client, "A"), kind: "messages", tag: null }
    const rows = [{ key: "m1", content: "Private message text", grouped: false }]
    const fingerprint = virtualListLayoutFingerprint(rows)
    saveVirtualListPosition(base, snapshot(fingerprint))
    expect(readVirtualListPosition(base, fingerprint)?.offset).toBe(300)
    for (const scope of [
      { ...base, proof: captureChannelMetadataToken(bob.client, "A") },
      { ...base, proof: captureChannelMetadataToken(alice.client, "B") },
      { ...base, kind: "forum" as const }, { ...base, tag: "bug" },
    ]) expect(readVirtualListPosition(scope, fingerprint)).toBeNull()
    expect(readVirtualListPosition(base, virtualListLayoutFingerprint([{ ...rows[0], grouped: true }]))).toBeNull()
    expect(JSON.stringify(alice.client.getQueryData(virtualListPositionKey(base)))).not.toContain("Private message text")
    const query = alice.client.getQueryCache().find({ queryKey: virtualListPositionKey(base), exact: true })!
    expect(shouldDehydrateCommunityQuery(query)).toBe(false)
  })

  it("expires layout records and bounds the number and size of retained lists", async () => {
    const { client } = await createCommunityQueryOwner()
    const scopes = Array.from({ length: 33 }, (_, index): VirtualListPositionScope => ({ proof: captureChannelMetadataToken(client, `c${index}`), kind: "messages", tag: null }))
    for (const scope of scopes) saveVirtualListPosition(scope, snapshot())
    expect(client.getQueryCache().findAll({ predicate: query => query.queryKey[3] === "virtual-position" })).toHaveLength(32)
    expect(readVirtualListPosition(scopes[0], "rows")).toBeNull()
    saveVirtualListPosition(scopes[32], { ...snapshot(), measurements: Array.from({ length: 2049 }, () => snapshot().measurements[0]) })
    expect(readVirtualListPosition(scopes[32], "rows")).toBeNull()
    saveVirtualListPosition(scopes[0], { ...snapshot(), measurements: Array.from({ length: 2049 }, () => snapshot().measurements[0]) })
    expect(readVirtualListPosition(scopes[0], "rows")).toBeNull()
    saveVirtualListPosition(scopes[0], { ...snapshot(), at: Date.now() - 300001 })
    expect(readVirtualListPosition(scopes[0], "rows")).toBeNull()
  })

  it("uses the existing account and channel retirement fences for stale capture callbacks", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const scope: VirtualListPositionScope = { proof: captureChannelMetadataToken(client, "A"), kind: "messages", tag: null }
    saveVirtualListPosition(scope, snapshot())
    retireCommunityChannelReading(registry, "A", { reason: "read-denied", serverId: null })
    expect(client.getQueryData(virtualListPositionKey(scope))).toBeUndefined()
    saveVirtualListPosition(scope, snapshot())
    expect(readVirtualListPosition(scope, "rows")).toBeNull()
    retireCommunityAccount(registry)
    saveVirtualListPosition(scope, snapshot())
    expect(client.getQueryData(virtualListPositionKey(scope))).toBeUndefined()
  })
})
