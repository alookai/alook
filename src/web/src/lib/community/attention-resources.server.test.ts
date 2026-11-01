import { beforeEach, describe, expect, it, vi } from "vitest"
import { AttentionIncludedChannelSchema, type AccountAttentionProjection, type Database } from "@alook/shared"
import { channelResourceFixture } from "@/test/community-resource-fixtures"

const mocks = vi.hoisted(() => ({ access: vi.fn(), memberships: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: {
    ...actual.queries,
    communityMessage: { ...actual.queries.communityMessage, getMessagesByIdsInChannels: vi.fn(async () => []) },
    communityChannel: { ...actual.queries.communityChannel, listReadableMessageChannelsForUser: (...args: unknown[]) => mocks.access(...args), listChannelMembershipsForUserInChannels: (...args: unknown[]) => mocks.memberships(...args) },
    communityServer: { ...actual.queries.communityServer, listUserServers: vi.fn(async () => [{ id: "s1", name: "Server", discriminator: "0001", description: "", ownerId: "viewer", icon: null, official: false, role: "owner", memberId: "member" }]) },
    user: { ...actual.queries.user, getUsersByIds: vi.fn(async () => [{ id: "viewer", name: "Viewer", discriminator: "0001", image: null, avatarVersion: 0 }]) },
    communityUserProfile: { ...actual.queries.communityUserProfile, getResourceProfiles: vi.fn(async () => [{ id: "viewer", name: "Viewer", discriminator: "0001", avatar: null, avatarVersion: 0 }]), getProfilesByUserIds: vi.fn(async () => []) },
  } }
})
import { hydrateAttentionResources, readCommunityResourceBundle } from "./attention-resources.server"

const db = {} as Database
const parent = channelResourceFixture({ id: "parent", serverId: "s1" })
const child = channelResourceFixture({ id: "child", serverId: "s1", type: "thread", parentChannelId: parent.id, parentMessageId: "opener" })
const access = [parent, child].map(channel => ({ channelId: channel.id, userId: "viewer", relation: "access", source: "explicit" }))
const notify = { channelId: "child", userId: "viewer", relation: "notify", source: "spoke" }
const projection: AccountAttentionProjection = {
  scopes: [], items: [], limit: 100, truncated: false,
  included: { servers: [{ id: "s1", name: "Server", discriminator: "0001" }], channels: [parent, child].map(channel => AttentionIncludedChannelSchema.strip().parse(channel)), dms: [], profiles: [], messages: [] },
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockImplementation(async (_db, _viewer, ids: string[]) => ids.map(id => id === "parent" ? parent : child))
})

describe("current attention resource producer", () => {
  it.each([false, true])("hydrates a schema-valid full attention snapshot with viewer notify=%s", async hasNotify => {
    mocks.memberships.mockResolvedValue([...access, ...(hasNotify ? [notify] : [])])
    const result = await hydrateAttentionResources(db, "viewer", projection)
    expect(result.resources.memberships).toEqual(access)
    expect(result.resources.channels).toEqual([parent, child])
    expect(mocks.memberships).toHaveBeenCalledExactlyOnceWith(db, "viewer", ["parent", "child"])
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith(db, "viewer", ["parent", "child"])
  })

  it("preserves notify in the separate generic complete resource bundle", async () => {
    mocks.memberships.mockResolvedValue([...access, notify])
    const result = await readCommunityResourceBundle(db, "viewer", { channelIds: ["parent", "child"] })
    expect(result.memberships).toEqual([...access, notify])
  })
})
