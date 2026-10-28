import { describe, expect, it } from "vitest"
import { CommunityResourceProfileSchema } from "../src/community-resources"
import { CommunitySelfProfileReadSchema, CommunityServerMemberReadSchema, CommunityUserSearchReadSchema, parseCommunitySelfProfileRead, parseCommunityUserCardRead, parseCommunityServerMembersRead } from "../src/community-profile-reads"

const self = { id: "viewer", name: "Viewer", discriminator: "0042", avatar: null, avatarVersion: 0, aboutMe: "", bannerColor: null, statusEmoji: null, statusText: null }
const { avatar, ...core } = self
const card = { ...core, image: avatar, mutualServers: 0, kind: "human" }
const member = { id: "membership", userId: "viewer", name: "Viewer", discriminator: "0042", avatar: null, avatarVersion: 0, role: "member", sub: "", status: "online", statusEmoji: null, statusText: "" }
const page = { viewerId: "viewer", serverId: "server", members: [member], hasMore: false, limit: 50, total: 1 }

describe("named complete and subset profile reads", () => {
  it("derives field validators from the unique profile resource", () => {
    expect(CommunitySelfProfileReadSchema.shape.avatarVersion.unwrap()).toBe(CommunityResourceProfileSchema.shape.avatarVersion)
    expect(CommunityServerMemberReadSchema.shape.avatar.unwrap()).toBe(CommunityResourceProfileSchema.shape.avatar)
    expect(parseCommunitySelfProfileRead(self, "viewer")).toEqual(self)
    expect(parseCommunityUserCardRead(card, "viewer", "other")).toEqual(card)
    expect(parseCommunityServerMembersRead(page, "server", "viewer", false)).toEqual(page)
    const { total: _total, ...search } = page
    expect(parseCommunityServerMembersRead(search, "server", "viewer", true)).toEqual(search)
    expect(CommunityUserSearchReadSchema.parse({ users: [{ id: "viewer", name: "Viewer", discriminator: "0042", image: null, avatarVersion: 0 }] }).users[0]!.image).toBeNull()
  })
  it.each(Object.keys(self))("requires complete self field %s", key => {
    const input: Record<string, unknown> = { ...self }; delete input[key]
    expect(() => parseCommunitySelfProfileRead(input, "viewer")).toThrow()
  })
  it("binds self and card identity plus viewer-relative bot ownership", () => {
    expect(() => parseCommunitySelfProfileRead(self, "foreign")).toThrow()
    expect(() => parseCommunityUserCardRead(card, "foreign", "viewer")).toThrow()
    const bot = { ...card, kind: "bot", ownerProfile: { id: "owner", handle: "Owner#0042" }, ownedByViewer: true }
    expect(parseCommunityUserCardRead(bot, "viewer", "owner")).toEqual(bot)
    expect(() => parseCommunityUserCardRead(bot, "viewer", "foreign")).toThrow()
    expect(() => parseCommunityUserCardRead({ ...bot, ownerProfile: { id: "owner" } }, "viewer", "owner")).toThrow()
  })
  it.each(["server", "viewer", "later-core", "duplicate-member", "duplicate-user", "cursor", "owned-bot", "oversized"])("refuses the entire member page for %s", defect => {
    const input = structuredClone(page)
    if (defect === "server") input.serverId = "foreign"
    if (defect === "viewer") input.viewerId = "foreign"
    if (defect === "later-core") input.members.push({ ...member, id: "second", userId: "second", avatarVersion: undefined } as never)
    if (defect === "duplicate-member") input.members.push({ ...member, userId: "second" })
    if (defect === "duplicate-user") input.members.push({ ...member, id: "second" })
    if (defect === "cursor") input.hasMore = true
    if (defect === "owned-bot") Object.assign(input.members[0]!, { isBot: true, ownerUserId: "foreign" })
    if (defect === "oversized") input.limit = 0
    expect(() => parseCommunityServerMembersRead(input, "server", "viewer", false)).toThrow()
  })
})

it("keeps bot catalog identity summaries distinct from valid partial command fields", async () => {
  const { CommunityBotProfileSummarySchema, parseCommunityBotsProfileRead } = await import("../src/community-profile-reads")
  const patch = { id: "bot", name: "Bot", image: null, avatarVersion: 1 }
  expect(CommunityBotProfileSummarySchema.parse(patch)).toEqual(patch)
  const row = { ...patch, discriminator: "0042", description: "Actual instruction", presence: "offline", ownerUserId: "viewer" }
  expect(parseCommunityBotsProfileRead({ bots: [row], plan: { id: "free" } }, "viewer")).toEqual({ bots: [row] })
  for (const value of [{ bots: [row, row] }, { bots: [{ ...row, ownerUserId: "foreign" }] }, { bots: [patch] }, { bots: [{ ...row, image: undefined }] }]) expect(() => parseCommunityBotsProfileRead(value, "viewer")).toThrow()
})

it("binds the named reaction actor subset to the actual requested message scope", async () => {
  const { parseCommunityReactionDetailsRead } = await import("../src/community-profile-reads")
  const scope = { kind: "server", serverId: "server", channelId: "channel" } as const
  const profile = { id: "actor", name: "Actor", discriminator: "0042", avatar: null, avatarVersion: 0 }
  const value = { messageId: "message", scope, actors: [{ userId: "actor", profile }, { userId: "deleted", profile: null }] }
  expect(parseCommunityReactionDetailsRead(value, "message", scope)).toEqual(value)
  for (const changed of [{ messageId: "foreign" }, { scope: { ...scope, serverId: "foreign" } }, { scope: { ...scope, channelId: "foreign" } }, { scope: { kind: "dm", channelId: "channel" } }, { actors: [{ userId: "foreign", profile }] }, { actors: [{ userId: "actor", profile }, { userId: "actor", profile }] }]) expect(() => parseCommunityReactionDetailsRead({ ...value, ...changed }, "message", scope)).toThrow()
  const dm = { kind: "dm", channelId: "dm" } as const
  expect(parseCommunityReactionDetailsRead({ ...value, scope: dm }, "message", dm).scope).toEqual(dm)
})
