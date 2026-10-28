import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION } from "./business-schema-version"
import { CommunityAcceptedFriendsReadSchema, CommunityBlockedFriendsReadSchema, CommunityPendingFriendsReadSchema } from "./community-friends"
import { CommunityResourceBundleSchema } from "./community-resources"

const resources = () => CommunityResourceBundleSchema.parse({ viewerId: "viewer", servers: [], serverMemberships: [], channels: [], memberships: [], messages: [], profiles: [{ id: "peer", name: "Peer", discriminator: null, avatar: null, avatarVersion: 0 }] })
const cases = [
  { bucket: "friends", schema: CommunityAcceptedFriendsReadSchema, row: { id: "relation", userId: "peer", sub: "detail" } },
  { bucket: "blocked", schema: CommunityBlockedFriendsReadSchema, row: { id: "block", userId: "peer" } },
  { bucket: "pending", schema: CommunityPendingFriendsReadSchema, row: { id: "request", userId: "peer", kind: "outgoing", needsOwnerApproval: "viewer" } },
] as const

describe("current named human friend reads", () => {
  it.each(cases)("separates $bucket relation identity from the complete profile", ({ bucket, schema, row }) => {
    const value = { contractVersion: BUSINESS_SCHEMA_VERSION, [bucket]: [row], resources: resources() }
    expect(schema.parse(value)).toEqual(value)
    expect(schema.safeParse({ ...value, [bucket]: [{ ...row, name: "second identity" }] }).success).toBe(false)
  })
  it.each(cases)("rejects absent/empty peer IDs and missing full profile for $bucket", ({ bucket, schema, row }) => {
    const value = { contractVersion: BUSINESS_SCHEMA_VERSION, [bucket]: [row], resources: resources() }
    const { userId: _userId, ...unkeyed } = row
    expect(schema.safeParse({ ...value, [bucket]: [unkeyed] }).success).toBe(false)
    expect(schema.safeParse({ ...value, [bucket]: [{ ...row, userId: "" }] }).success).toBe(false)
    expect(schema.safeParse({ ...value, resources: { ...resources(), profiles: [] } }).success).toBe(false)
    expect(schema.safeParse({ ...value, resources: { ...resources(), profiles: [{ id: "peer", name: "Peer", discriminator: null, avatarVersion: 0 }] } }).success).toBe(false)
  })
  it.each(cases)("keeps current stale $bucket explicit and empty", ({ bucket, schema }) => {
    const value = { contractVersion: BUSINESS_SCHEMA_VERSION, [bucket]: [], stale: true }
    expect(schema.parse(value)).toEqual(value)
    expect(schema.safeParse({ ...value, resources: resources() }).success).toBe(false)
    expect(schema.safeParse({ ...value, contractVersion: BUSINESS_SCHEMA_VERSION - 1 }).success).toBe(false)
  })
  it("rejects accepted/blocked states as pending direction and obsolete success envelopes", () => {
    const value = { contractVersion: BUSINESS_SCHEMA_VERSION, pending: [{ id: "request", userId: "peer", kind: "accepted" }], resources: resources() }
    expect(CommunityPendingFriendsReadSchema.safeParse(value).success).toBe(false)
    expect(CommunityAcceptedFriendsReadSchema.safeParse({ contractVersion: 1, friends: [], resources: resources() }).success).toBe(false)
    expect(CommunityAcceptedFriendsReadSchema.safeParse({ friends: [], resources: resources() }).success).toBe(false)
  })
})
