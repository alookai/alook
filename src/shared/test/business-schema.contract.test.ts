import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_BOT_ACTOR_HEADER, COMMUNITY_CONTRACT_HEADER, requestedCommunityContract } from "../src/index"
import { CommunityMessageResourceSchema } from "../src/community-resources"
import { communityCollectionSchemas } from "../src/community-cache"
import { encodeCommunityBrowserEvent, decodeCommunityBrowserEvent } from "../src/community-ws-events"
import { computeCommunityDeliveryDigestFromBodies, prepareCommunityDeliveryEvents, encodePreparedCommunityBrowserEventBatch, admitCommunityBrowserEventBatch } from "../src/community-ws-bundle"

const message = () => CommunityMessageResourceSchema.parse({ id: "message", channelId: "channel", seq: 5, authorId: "author", createdAt: "2026-10-28T00:00:00Z", type: "chat", content: "current", replyToId: null, clientNonce: null, attachments: [], authorName: "Author", authorAvatar: null, authorAvatarVersion: 0 })
const event = () => ({ type: "community:message.create" as const, channelId: "channel", message: message(), profiles: [{ id: "author", name: "Author", discriminator: "0042", avatar: null, avatarVersion: 0 }] })

describe("one current business resource protocol", () => {
  it("rejects missing and old request versions while accepting the shared current version", () => {
    for (const version of [null, "1", "2", "3", "6", String(BUSINESS_SCHEMA_VERSION + 1)]) {
      const headers = new Headers(version === null ? {} : { [COMMUNITY_CONTRACT_HEADER]: version })
      expect(requestedCommunityContract(headers)).toBeNull()
    }
    expect(requestedCommunityContract(new Headers({ [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) }))).toBe(BUSINESS_SCHEMA_VERSION)
  })

  it("admits complete nullable facts without markers and rejects partial or marker-shaped cached entities", () => {
    expect(communityCollectionSchemas.messages.parse(message())).toEqual(message())
    for (const invalid of [{ id: "message", type: "chat" }, { ...message(), resourceComplete: true }]) expect(communityCollectionSchemas.messages.safeParse(invalid).success).toBe(false)
    expect(communityCollectionSchemas.profiles.safeParse({ id: "author", name: "Author", identityComplete: true }).success).toBe(false)
    expect(communityCollectionSchemas.profiles.parse({ id: "author", name: "Author", discriminator: "0042", avatar: null, avatarVersion: 0 })).toMatchObject({ avatar: null, discriminator: "0042" })
    expect(communityCollectionSchemas.profiles.safeParse({ id: "author", name: "Author", discriminator: null, avatar: null, avatarVersion: 0 }).success).toBe(false)
  })

  it("validates full inner resources and requires an explicit current version at the wire boundary", () => {
    const encoded = encodeCommunityBrowserEvent(event())
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error("Current event rejected")
    expect(decodeCommunityBrowserEvent(JSON.parse(encoded.body))).toEqual({ ok: true, event: event() })
    for (const invalid of [event(), { ...encoded.envelope, schemaVersion: 3 }, { ...encoded.envelope, message: { id: "message", type: "chat" } }]) expect(decodeCommunityBrowserEvent(invalid).ok).toBe(false)
    expect(encodeCommunityBrowserEvent({ ...event(), message: { id: "message", type: "chat" } }).ok).toBe(false)
  })

  it("binds current batch frames to their full resource bytes and rejects downgraded names or tampering", async () => {
    const prepared = await prepareCommunityDeliveryEvents([event()])
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error("Current delivery rejected")
    const encoded = encodePreparedCommunityBrowserEventBatch({ operationId: `message:${"a".repeat(43)}`, operationDigest: prepared.prepared.digest, sourceDigest: prepared.prepared.digest, prepared: prepared.prepared })
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error("Current batch rejected")
    expect((await admitCommunityBrowserEventBatch(JSON.parse(encoded.body))).ok).toBe(true)
    expect((await admitCommunityBrowserEventBatch({ ...encoded.batch, type: "community:events.batch.v3" })).ok).toBe(false)
    expect((await admitCommunityBrowserEventBatch({ ...encoded.batch, events: [{ ...encoded.batch.events[0], message: { ...message(), content: "tampered" } }] })).ok).toBe(false)
  })
  it.each(["operation-only", "wire-rehashed"] as const)("rejects current %s digest tampering", async mode => {
    const prepared = await prepareCommunityDeliveryEvents([event()])
    if (!prepared.ok) throw new Error("Current event rejected")
    const encoded = encodePreparedCommunityBrowserEventBatch({ operationId: `message:${"b".repeat(43)}`, operationDigest: prepared.prepared.digest, prepared: prepared.prepared })
    if (!encoded.ok) throw new Error("Current batch rejected")
    const frame = JSON.parse(encoded.body)
    if (mode === "operation-only") frame.operationDigest = "0".repeat(64)
    else {
      frame.events[0].message.content = "Changed bytes"
      frame.wireDigest = await computeCommunityDeliveryDigestFromBodies(frame.events.map((row: unknown) => JSON.stringify(row)))
    }
    expect((await admitCommunityBrowserEventBatch(frame)).ok).toBe(false)
  })

})

it("keeps bot selection independent from current business version admission", () => {
  const headers = new Headers({ [COMMUNITY_BOT_ACTOR_HEADER]: "selected-bot" })
  expect(requestedCommunityContract(headers)).toBeNull()
  for (const version of ["2", "3"]) {
    headers.set(COMMUNITY_CONTRACT_HEADER, version)
    expect(requestedCommunityContract(headers)).toBeNull()
  }
  headers.set(COMMUNITY_CONTRACT_HEADER, String(BUSINESS_SCHEMA_VERSION))
  expect(requestedCommunityContract(headers)).toBe(BUSINESS_SCHEMA_VERSION)
})
