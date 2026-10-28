import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION } from "./business-schema-version"
import { CommunityInviteCreateSchema } from "./community-ws-events"
import { CommunityInvitesReadSchema, CommunityInviteListItemSchema } from "./community-invites"

const invite = { id: "invite", token: "token", maxUses: null, uses: 0, expiresAt: null, createdAt: "now", creatorId: "creator" }
const profile = { id: "creator", name: "Creator", discriminator: "0042", avatar: null, avatarVersion: 0 }
const value = () => ({ contractVersion: BUSINESS_SCHEMA_VERSION, serverId: "server", invites: [invite], resources: { viewerId: "viewer", servers: [{ id: "server", name: "Server", discriminator: "0042", description: "", ownerId: "owner", icon: null, position: 0, official: false, isOwner: false }], serverMemberships: [{ serverId: "server", userId: "viewer", memberId: "member", role: "member" }], channels: [], memberships: [], messages: [], profiles: [profile] } })
describe("current named invite reads", () => {
  it("derives invite descriptor fields from the existing unique invite-create declaration", () => {
    for (const key of ["id", "token", "createdAt"] as const) expect(CommunityInviteListItemSchema.shape[key]).toBe(CommunityInviteCreateSchema.shape.invite.shape[key])
    expect(CommunityInvitesReadSchema.parse(value())).toEqual(value())
  })
  it("requires actual nullable descriptor facts and full creator core", () => {
    const v = value()
    for (const key of ["creatorId", "maxUses", "uses", "expiresAt"]) {
      const row: Record<string, unknown> = { ...invite }; delete row[key]
      expect(CommunityInvitesReadSchema.safeParse({ ...v, invites: [row] }).success).toBe(false)
    }
    expect(CommunityInvitesReadSchema.safeParse({ ...v, resources: { ...v.resources, profiles: [] } }).success).toBe(false)
    const { avatar: _avatar, ...incomplete } = profile
    expect(CommunityInvitesReadSchema.safeParse({ ...v, resources: { ...v.resources, profiles: [incomplete] } }).success).toBe(false)
  })
  it("permits an explicitly deleted creator without inventing a profile", () => {
    const v = value()
    expect(CommunityInvitesReadSchema.parse({ ...v, invites: [{ ...invite, creatorId: null }], resources: { ...v.resources, profiles: [] } }).invites[0].creatorId).toBeNull()
  })
  it("rejects duplicate IDs, foreign server resources, PII hints and invalid use counts", () => {
    const v = value()
    expect(CommunityInvitesReadSchema.safeParse({ ...v, invites: [invite, invite] }).success).toBe(false)
    expect(CommunityInvitesReadSchema.safeParse({ ...v, serverId: "foreign" }).success).toBe(false)
    for (const key of ["creatorName", "creatorEmail", "creatorImage"]) expect(CommunityInvitesReadSchema.safeParse({ ...v, invites: [{ ...invite, [key]: "duplicate identity" }] }).success).toBe(false)
    for (const uses of [-1, null, 0.5]) expect(CommunityInvitesReadSchema.safeParse({ ...v, invites: [{ ...invite, uses }] }).success).toBe(false)
  })
  it.each([1, 2, 3])("refuses old source version%s", contractVersion => {
    expect(CommunityInvitesReadSchema.safeParse({ ...value(), contractVersion }).success).toBe(false)
  })
})
