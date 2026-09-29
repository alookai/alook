import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { createLiveQueryCollection, eq } from "@tanstack/react-db"
import type { MemberOverlayEvent } from "@/hooks/community/use-server-members"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"

vi.mock("react", () => ({
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (initial: unknown) => [initial, () => {}],
}))

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type MutConfig<Args, Ctx> = {
  mutationFn?: (args: Args) => unknown
  onMutate?: (args: Args) => Promise<Ctx> | Ctx
  onSuccess?: (data: unknown, args: Args, ctx: Ctx) => unknown
  onError?: (err: unknown, args: Args, ctx: Ctx) => unknown
}

let capturedConfig: MutConfig<unknown, unknown> | null = null
let capturedQc: QueryClient
let registry: CommunityDbRegistry
let unregister: (() => void) | null = null
let memberView: ReturnType<typeof createLiveQueryCollection> | null = null

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQc,
    useMutation: (config: MutConfig<unknown, unknown>) => {
      capturedConfig = config
      return {}
    },
  }
})

async function load() {
  const mutations = await import("./members")
  const shared = await import("@/hooks/community/use-server-members")
  return { ...mutations, shared }
}

function seedMembership() {
  registry.collections.serverMemberships.utils.writeInsert({
    id: "srv_1:u_1",
    serverId: "srv_1",
    userId: "u_1",
    memberId: "mem_1",
    role: "member",
    viewer: false,
  })
}

beforeEach(async () => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue({
    members: [],
    hasMore: false,
    limit: 50,
    total: 0,
  })
  capturedConfig = null
  capturedQc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const collections = await import("@/lib/community-db/collections")
  registry = collections.createCommunityDbRegistry(capturedQc, "viewer")
  await registry.ensureCollectionReady("serverMemberships")
  unregister = collections.registerCommunityDbRegistry(registry)
  memberView = createLiveQueryCollection({
    query: (q) => q.from({ membership: registry.collections.serverMemberships })
      .where(({ membership }) => eq(membership.serverId, "srv_1"))
      .orderBy(({ membership }) => membership.id, "asc"),
  })
  await memberView.preload()
  seedMembership()
})

afterEach(async () => {
  await memberView?.cleanup()
  memberView = null
  unregister?.()
  unregister = null
  await registry.cleanup()
  capturedQc.clear()
})

describe("useSetMemberRole", () => {
  it("writes the canonical row optimistically and restores it on failure", async () => {
    const mod = await load()
    mod.useSetMemberRole()
    const cfg = capturedConfig as MutConfig<
      { serverId: string; memberId: string; role: "admin" },
      unknown
    >
    const args = { serverId: "srv_1", memberId: "mem_1", role: "admin" as const }

    const context = await cfg.onMutate!(args)
    expect(registry.collections.serverMemberships.get("srv_1:u_1")?.role).toBe("admin")
    cfg.onError!(new Error("failed"), args, context)
    expect(registry.collections.serverMemberships.get("srv_1:u_1")?.role).toBe("member")
  })

  it("notifies the active search overlay", async () => {
    const mod = await load()
    const received: MemberOverlayEvent[] = []
    const unsubscribe = mod.shared.subscribeMemberOverlayEvents((event) => received.push(event))
    mod.useSetMemberRole()
    const cfg = capturedConfig as MutConfig<
      { serverId: string; memberId: string; role: "admin" },
      unknown
    >
    await cfg.onMutate!({ serverId: "srv_1", memberId: "mem_1", role: "admin" })
    unsubscribe()
    expect(received).toContainEqual({
      type: "role",
      serverId: "srv_1",
      memberId: "mem_1",
      role: "admin",
    })
  })
})

describe("useKickMember", () => {
  it("deletes the canonical row optimistically and restores it on failure", async () => {
    const mod = await load()
    mod.useKickMember()
    const cfg = capturedConfig as MutConfig<
      { serverId: string; memberId: string },
      unknown
    >
    const args = { serverId: "srv_1", memberId: "mem_1" }

    const context = await cfg.onMutate!(args)
    expect(registry.collections.serverMemberships.has("srv_1:u_1")).toBe(false)
    cfg.onError!(new Error("failed"), args, context)
    expect(registry.collections.serverMemberships.get("srv_1:u_1")).toMatchObject({
      memberId: "mem_1",
      role: "member",
    })
  })

  it("notifies the active search overlay", async () => {
    const mod = await load()
    const received: MemberOverlayEvent[] = []
    const unsubscribe = mod.shared.subscribeMemberOverlayEvents((event) => received.push(event))
    mod.useKickMember()
    const cfg = capturedConfig as MutConfig<
      { serverId: string; memberId: string },
      unknown
    >
    await cfg.onMutate!({ serverId: "srv_1", memberId: "mem_1" })
    unsubscribe()
    expect(received).toContainEqual({
      type: "kick",
      serverId: "srv_1",
      memberId: "mem_1",
    })
  })
})
