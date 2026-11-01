import { describe, expect, it } from "vitest"
import { CommunityPresenceReadSchema, CommunityPresenceResultSchema } from "./community-presence"
import { profileSchema } from "./community-cache"
import { CommunityResourceProfileSchema } from "./community-profile-resource"

describe("confirmed presence", () => {
  it("preserves only explicitly confirmed online and offline results", () => {
    const data = { online: ["online"], offline: ["offline"] }
    expect(CommunityPresenceResultSchema.parse(data)).toEqual(data)
    expect(CommunityPresenceReadSchema.parse({ ...data, truncated: true, limit: 1000 })).toEqual({ ...data, truncated: true, limit: 1000 })
  })
  it.each([{ online: [] }, { online: ["peer"], offline: ["peer"] }, { online: [true], offline: [] }, { online: [], offline: [""] }])("rejects incomplete or conflicting facts %j", data => {
    expect(CommunityPresenceResultSchema.safeParse(data).success).toBe(false)
  })
  it("stores last-known presence as local user data without adding it to partial API profile resources", () => {
    const row = { id: "peer", name: "Peer", discriminator: "0042", avatar: null, avatarVersion: 0, presence: "online" }
    expect(profileSchema.parse(row)).toEqual(row)
    expect(CommunityResourceProfileSchema.safeParse(row).success).toBe(false)
    expect(profileSchema.safeParse({ ...row, presence: "unknown" }).success).toBe(false)
  })
})
