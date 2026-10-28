import { CancelledError } from "@tanstack/react-query"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, CommunityInvitesReadSchema } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { invitesReadFixture } from "@/test/community-resource-fixtures"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createElement, type PropsWithChildren } from "react"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"

const mocks = vi.hoisted(() => ({ list: vi.fn(), users: vi.fn(), profiles: vi.fn(), servers: vi.fn(), api: vi.fn(), member: vi.fn(), db: {} }))
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db }))
vi.mock("@/lib/middleware/auth", () => ({ withAuth: (handler: (request: NextRequest, context: unknown) => Promise<Response>) => (request: NextRequest) => handler(request, { userId: "viewer", env: { DB: mocks.db }, params: { id: "s1" } }) }))
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }))
vi.mock("@alook/shared", async original => {
  const actual = await original<typeof import("@alook/shared")>()
  return { ...actual, queries: { ...actual.queries,
    communityInvite: { ...actual.queries.communityInvite, listServerInvites: (...args: unknown[]) => mocks.list(...args) },
    communityMember: { ...actual.queries.communityMember, getMember: (...args: unknown[]) => mocks.member(...args) },
    communityMessage: { ...actual.queries.communityMessage, getMessagesByIdsInChannels: vi.fn(async () => []) },
    communityChannel: { ...actual.queries.communityChannel, listChannelMembershipsForUserInChannels: vi.fn(async () => []) },
    communityServer: { ...actual.queries.communityServer, listUserServers: (...args: unknown[]) => mocks.servers(...args) },
    user: { ...actual.queries.user, getUsersByIds: (...args: unknown[]) => mocks.users(...args) },
    communityUserProfile: { ...actual.queries.communityUserProfile, getProfilesByUserIds: (...args: unknown[]) => mocks.profiles(...args) },
  } }
})
import { GET } from "@/app/api/community/servers/[id]/invites/route"
import { invitesQueryFn, useInvites } from "@/hooks/community/use-server-panels"
const request = () => new NextRequest("https://alook.test/api/community/servers/s1/invites")
beforeEach(() => {
  vi.clearAllMocks()
  mocks.member.mockResolvedValue({ id: "member-viewer", role: "member" })
  mocks.list.mockResolvedValue([{ id: "invite", serverId: "s1", token: "token", uses: 0, maxUses: null, expiresAt: null, createdAt: "2026-10-01T00:00:00Z", creatorId: "creator", creatorName: "Alice", creatorEmail: "private@example.test", creatorImage: null, creatorAvatarVersion: 2 }])
  mocks.users.mockImplementation(async (_db, ids: string[]) => ids.map(id => ({ id, name: id === "creator" ? "Alice" : "Viewer", discriminator: "0042", image: null, avatarVersion: 2 })))
  mocks.profiles.mockImplementation(async (_db, ids: string[]) => ids.map(userId => ({ userId, aboutMe: "About", bannerColor: null, statusEmoji: null, statusText: null })))
  mocks.servers.mockResolvedValue([{ id: "s1", name: "Server", discriminator: "0042", description: "", ownerId: "owner", icon: null, official: false, role: "member", memberId: "member-viewer" }])
  mocks.api.mockImplementation(async (path: string, options: { authenticationAccount?: string }) => {
    expect(path).toBe("/api/community/servers/s1/invites")
    expect(options.authenticationAccount).toBe("viewer")
    const response = await GET(request())
    expect(response.status).toBe(200)
    return response.json()
  })
})
it("publishes a cold real creator profile and renders the creator name through the actual invite query", async () => {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const hook = renderHook(() => useInvites("s1"), { wrapper })
  try {
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(hook.result.current.invites[0]?.by).toBe("Alice")
    expect(owner.registry.collections.profiles.get("creator")).toMatchObject({ name: "Alice", discriminator: "0042", avatar: null, avatarVersion: 2 })
  } finally { hook.unmount(); await owner.registry.cleanup(); owner.client.clear() }
})

it("produces scoped descriptors with full resources and no creator email or second identity", async () => {
  const response = await GET(request())
  expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
  const data = CommunityInvitesReadSchema.parse(await response.json())
  expect(data.invites).toEqual([{ id: "invite", token: "token", uses: 0, maxUses: null, expiresAt: null, createdAt: "2026-10-01T00:00:00Z", creatorId: "creator" }])
  expect(data.resources.profiles.find(row => row.id === "creator")).toMatchObject({ name: "Alice", discriminator: "0042", avatar: null, avatarVersion: 2, aboutMe: "About" })
  expect(JSON.stringify(data)).not.toContain("private@example.test")
  expect(mocks.member).toHaveBeenCalledExactlyOnceWith(mocks.db, "s1", "viewer")
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith(mocks.db, "s1")
  expect(mocks.users).toHaveBeenCalledExactlyOnceWith(mocks.db, ["viewer", "creator"])
  expect(mocks.servers).toHaveBeenCalledExactlyOnceWith(mocks.db, "viewer")
})
it("retains an explicitly null deleted creator without a fabricated profile", async () => {
  const rows = await mocks.list()
  mocks.list.mockResolvedValue([{ ...rows[0], creatorId: null, creatorName: null }])
  const data = CommunityInvitesReadSchema.parse(await (await GET(request())).json())
  expect(data.invites[0].creatorId).toBeNull()
  expect(data.resources.profiles.map(row => row.id)).toEqual(["viewer"])
})
it("gates membership before reading invite or creator resources", async () => {
  mocks.member.mockResolvedValue(null)
  expect((await GET(request())).status).toBe(403)
  expect(mocks.list).not.toHaveBeenCalled()
  expect(mocks.users).not.toHaveBeenCalled()
})
it("rejects a missing creator full resource without publishing the descriptor", async () => {
  mocks.users.mockResolvedValue([{ id: "viewer", name: "Viewer", discriminator: "0042", image: null, avatarVersion: 2 }])
  const owner = await createCommunityQueryOwner()
  try {
    await expect(owner.client.query({ queryKey: communityKeys.invites("s1"), queryFn: invitesQueryFn("s1"), retry: false })).rejects.toThrow("Invite creator profile resource missing")
    expect(owner.registry.collections.profiles.size).toBe(0)
  } finally { await owner.registry.cleanup(); owner.client.clear() }
})
it.each(["list", "users", "profiles"] as const)("propagates original %s errors without a false empty result", async query => {
  const failure = new Error("unavailable")
  mocks[query].mockRejectedValue(failure)
  await expect(GET(request())).rejects.toBe(failure)
})
const item = { id: "invite", token: "token", uses: 0, maxUses: null, expiresAt: null, createdAt: "now", creatorId: "creator" }
const creator = { id: "creator", name: "Alice", discriminator: "0042", avatar: null, avatarVersion: 2 }
it.each(["missing core", "missing creator", "old version", "wrong viewer", "wrong server", "duplicate summary"] as const)("rejects raw %s before any canonical profile publication", async variant => {
  const data = invitesReadFixture(variant === "wrong server" ? "foreign" : "s1", [item], [creator], variant === "wrong viewer" ? "foreign" : "viewer")
  const raw = structuredClone(data)
  if (variant === "missing core") Reflect.deleteProperty(raw.resources.profiles[0], "avatar")
  if (variant === "missing creator") raw.resources.profiles = []
  if (variant === "old version") Reflect.set(raw, "contractVersion", BUSINESS_SCHEMA_VERSION - 1)
  if (variant === "duplicate summary") Reflect.set(raw.invites[0], "creatorName", "Untrusted")
  mocks.api.mockResolvedValue(raw)
  const owner = await createCommunityQueryOwner()
  try {
    await expect(owner.client.query({ queryKey: communityKeys.invites("s1"), queryFn: invitesQueryFn("s1"), retry: false })).rejects.toThrow()
    expect(owner.registry.collections.profiles.size).toBe(0)
  } finally { await owner.registry.cleanup(); owner.client.clear() }
})
it.each(["retired owner", "newer identity"] as const)("preserves the originating owner and field revision after a held response: %s", async variant => {
  const owner = await createCommunityQueryOwner()
  owner.registry.collections.profiles.utils.writeUpsert({ ...creator, name: "Before" })
  let release!: (value: unknown) => void
  let originalSignal: AbortSignal | undefined
  let other: Awaited<ReturnType<typeof createCommunityQueryOwner>> | undefined
  mocks.api.mockImplementationOnce((_path, options: { signal?: AbortSignal }) => { originalSignal = options.signal; return new Promise(resolve => { release = resolve }) })
  const result = owner.client.query({ queryKey: communityKeys.invites("s1"), queryFn: invitesQueryFn("s1"), retry: false }).then(value => value, error => error)
  try {
    await waitFor(() => expect(release).toBeTypeOf("function"))
    if (variant === "retired owner") {
      retireCommunityAccount(owner.registry)
      other = await createCommunityQueryOwner("other")
      other.registry.collections.profiles.utils.writeUpsert({ ...creator, name: "Other owner" })
    }
    else projectCommunityWsEventToDb(owner.client, { type: "community:profile.update", userId: "creator", name: "Newer" })
    release(invitesReadFixture("s1", [item], [creator]))
    const outcome = await result
    if (variant === "retired owner") { expect(outcome).toBeInstanceOf(CancelledError); expect(originalSignal?.aborted).toBe(true); expect(other!.registry.collections.profiles.get("creator")?.name).toBe("Other owner") }
    else { expect(outcome).toMatchObject({ invites: [{ creatorId: "creator" }] }); expect(owner.registry.collections.profiles.get("creator")?.name).toBe("Newer") }
    expect(owner.registry.collections.profiles.get("creator")?.name).not.toBe("Alice")
  } finally { await owner.registry.cleanup(); owner.client.clear(); await other?.registry.cleanup(); other?.client.clear() }
})
