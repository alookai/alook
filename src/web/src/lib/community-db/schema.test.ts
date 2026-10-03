import { describe, expect, it } from "vitest"
import { PARTICIPANT_SOURCE } from "@alook/shared/constants/community"
import {
  channelMembershipKey,
  channelMembershipSchema,
  communityCollectionSchemas,
  folderItemKey,
  notificationSettingKey,
  notificationSettingSchema,
  serverSchema,
  serverMembershipKey,
} from "./schema"

describe("community DB schemas", () => {
  it("defines the canonical collection families, including independent attention state", () => {
    expect(Object.keys(communityCollectionSchemas)).toEqual([
      "servers",
      "categories",
      "channels",
      "serverMemberships",
      "channelMemberships",
      "profiles",
      "messages",
      "friendships",
      "readStates",
      "readStateClock",
      "attentionScopes",
      "attentionItems",
      "folders",
      "folderItems",
      "notificationSettings",
    ])
  })

  it("uses stable relationship identities", () => {
    expect(serverMembershipKey("s1", "u1")).toBe("s1:u1")
    expect(channelMembershipKey("c1", "u1", "access")).toBe("c1:u1:access")
    expect(channelMembershipKey("c1", "u1", "notify")).toBe("c1:u1:notify")
    expect(folderItemKey("f1", "s1")).toBe("f1:s1")
    expect(notificationSettingKey({ serverId: "s1" })).toBe("server:s1")
    expect(notificationSettingKey({ channelId: "c1" })).toBe("channel:c1")
  })

  it("preserves access and notify provenance while rejecting unknown membership sources", () => {
    for (const source of ["explicit", "inherited", "admin"] as const) {
      const row = { id: "c:u:access", channelId: "c", userId: "u", relation: "access", source }
      expect(channelMembershipSchema.parse(row)).toEqual(row)
    }
    for (const source of Object.values(PARTICIPANT_SOURCE)) {
      const row = { id: "c:u:notify", channelId: "c", userId: "u", relation: "notify", source }
      expect(channelMembershipSchema.parse(row)).toEqual(row)
    }
    expect(channelMembershipSchema.safeParse({
      id: "c:u:notify", channelId: "c", userId: "u", relation: "notify", source: "unknown-wire-source",
    }).success).toBe(false)
  })

  it("rejects notification rows without exactly one target", () => {
    const base = { id: "setting", level: "all" }
    expect(notificationSettingSchema.safeParse(base).success).toBe(false)
    expect(notificationSettingSchema.safeParse({
      ...base,
      serverId: "s1",
      channelId: "c1",
    }).success).toBe(false)
    expect(notificationSettingSchema.safeParse({
      ...base,
      serverId: "s1",
      channelId: null,
    }).success).toBe(true)
    expect(() => notificationSettingKey({ serverId: null, channelId: null })).toThrow(
      "notification setting target missing",
    )
  })

  it("treats restored server identities without a detail marker as incomplete", () => {
    const parsed = serverSchema.parse({
      id: "s1",
      name: "Server",
      discriminator: "0001",
      description: "",
      ownerId: "owner",
      icon: null,
      official: false,
      isOwner: false,
      unread: false,
      mentions: 0,
    })
    expect(parsed.detailComplete).toBe(false)
    expect(parsed).not.toHaveProperty("position")
  })
})
