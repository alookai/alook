import { QueryClient } from "@tanstack/react-query"
import {
  DbClient,
  collectionOptions,
  createLiveQueryCollection,
  eq,
} from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { afterEach, describe, expect, it, vi } from "vitest"
import { apiFetch } from "@/lib/api/client"
import type { Member } from "@/lib/community/models/people"
import {
  createServerMembersCollectionDescriptor,
  readServerMembersState,
  type ServerMembersEnvelope,
} from "./server-members-resource"
import { serverMembershipSchema } from "./schema"

vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn() }))

const apiFetchMock = vi.mocked(apiFetch)
const cleanups: Array<() => Promise<void>> = []

function member(index: number, role: Member["role"] = "member"): Member {
  return {
    id: `membership-${index}`,
    userId: `user-${index}`,
    name: `Member ${index}`,
    discriminator: String(index).padStart(4, "0"),
    avatar: `avatar-${index}`,
    avatarVersion: 1,
    status: "offline",
    sub: "",
    role,
  }
}

function envelope(
  members: Member[],
  options: { cursor?: string; total?: number } = {},
): ServerMembersEnvelope {
  return {
    members,
    hasMore: options.cursor !== undefined,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    limit: 50,
    total: options.total ?? members.length,
  }
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const dbClient = new DbClient({ queryClient })
  const descriptor = createServerMembersCollectionDescriptor(queryClient, "viewer")
  const options = queryCollectionOptions({
    id: "server-members-resource-test",
    queryClient,
    queryKey: descriptor.queryKey,
    queryFn: descriptor.queryFn,
    schema: serverMembershipSchema,
    getKey: (row) => row.id,
    syncMode: "on-demand",
    staleTime: Infinity,
  })
  const memberships = dbClient.collection(collectionOptions(
    "server-members-resource-test",
    () => options,
  ))
  descriptor.bindRows(() => memberships.values())
  const views: Array<ReturnType<typeof createLiveQueryCollection>> = []
  const view = (limit: number) => {
    const created = createLiveQueryCollection({
      query: (q) => q.from({ membership: memberships })
        .where(({ membership }) => eq(membership.serverId, "server"))
        .orderBy(({ membership }) => membership.id, "asc")
        .limit(limit),
    })
    views.push(created)
    return created
  }
  return {
    descriptor,
    memberships,
    queryClient,
    view,
    cleanup: async () => {
      await Promise.all(views.map((created) => created.cleanup()))
      await dbClient.cleanup()
      queryClient.clear()
    },
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  apiFetchMock.mockReset()
})

describe("server member QueryCollection resource", () => {
  it("uses the unscoped row key when no subset is supplied", () => {
    const runtime = setup()
    cleanups.push(runtime.cleanup)

    expect(runtime.descriptor.queryKey()).toEqual([
      "community", "db", "viewer", "server-members-resource", "rows",
    ])
    expect(runtime.descriptor.queryKey({
      where: {
        type: "func",
        name: "eq",
        args: [
          { type: "ref", path: ["serverId"] },
          { type: "val", value: 42 },
        ],
      },
    } as never)).toEqual([
      "community", "db", "viewer", "server-members-resource", "rows",
    ])
  })

  it("rejects a continuation page that omits its cursor", async () => {
    apiFetchMock.mockResolvedValue({
      members: [member(1)],
      hasMore: true,
      limit: 50,
      total: 2,
    })
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const lease = runtime.descriptor.acquire("server", 50)
    const roster = runtime.view(50)

    await expect(roster.preload()).rejects.toThrow(
      "Member page declared continuation without a cursor",
    )
    await lease.release()
  })

  it("raises the shared high-water mark when a larger second lease arrives", async () => {
    apiFetchMock.mockResolvedValue(envelope([]))
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const refresh = vi.spyOn(runtime.queryClient, "invalidateQueries").mockResolvedValue(undefined)
    const first = runtime.descriptor.acquire("server", 50)
    const second = runtime.descriptor.acquire("server", 100)

    expect(refresh).toHaveBeenCalledWith({
      queryKey: ["community", "db", "viewer", "server-members-resource", "rows", "server"],
      exact: true,
      refetchType: "active",
    })
    await first.release()
    await second.release()
  })

  it.each([0, 1])("activates a direct roster with %i rows", async (count) => {
    apiFetchMock.mockResolvedValue(envelope(count === 0 ? [] : [member(1)]))
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const lease = runtime.descriptor.acquire("server", 50)
    const roster = runtime.view(50)

    await roster.preload()

    expect([...roster.values()].map((row) => row.userId)).toEqual(
      count === 0 ? [] : ["user-1"],
    )
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/servers/server/members",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await lease.release()
  })

  it("grows a roster from the shared page prefix without refetching page one", async () => {
    apiFetchMock.mockImplementation(async (url) => String(url).includes("cursor=next-50")
      ? envelope(Array.from({ length: 25 }, (_, index) => member(index + 51)), { total: 75 })
      : envelope(Array.from({ length: 50 }, (_, index) => member(index + 1)), {
          cursor: "next-50",
          total: 75,
        }))
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const lease = runtime.descriptor.acquire("server", 50)
    const roster = runtime.view(100)
    await roster.preload()

    await lease.update(100)
    await vi.waitFor(() => expect(runtime.memberships.size).toBe(75))

    expect(apiFetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/community/servers/server/members",
      "/api/community/servers/server/members?cursor=next-50",
    ])
    expect(readServerMembersState(runtime.queryClient, "viewer", "server")).toMatchObject({
      hasMore: false,
      loadedRows: 75,
      total: 75,
    })
  })

  it("keeps exact role and delete writes while loading another cached page", async () => {
    apiFetchMock.mockImplementation(async (url) => String(url).includes("cursor=next-50")
      ? envelope([member(51)], { total: 51 })
      : envelope(Array.from({ length: 50 }, (_, index) => member(index + 1)), {
          cursor: "next-50",
          total: 51,
        }))
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const lease = runtime.descriptor.acquire("server", 50)
    const roster = runtime.view(100)
    await roster.preload()

    runtime.descriptor.markChanged("server", "server:user-1")
    runtime.memberships.utils.writeUpdate({ id: "server:user-1", role: "admin" })
    runtime.descriptor.markChanged("server", "server:user-2", true)
    runtime.memberships.utils.writeDelete("server:user-2")
    await lease.update(100)
    await vi.waitFor(() => expect(runtime.memberships.has("server:user-51")).toBe(true))

    expect(runtime.memberships.get("server:user-1")?.role).toBe("admin")
    expect(runtime.memberships.has("server:user-2")).toBe(false)
  })

  it("lets an explicit reconciliation replace prior exact-write overlays", async () => {
    apiFetchMock.mockResolvedValue(envelope([member(1)]))
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    runtime.descriptor.acquire("server", 50)
    const roster = runtime.view(50)
    await roster.preload()
    runtime.descriptor.markChanged("server", "server:user-1", true)
    runtime.memberships.utils.writeDelete("server:user-1")
    expect(runtime.memberships.has("server:user-1")).toBe(false)

    await runtime.descriptor.reconcile("server")

    await vi.waitFor(() => expect(runtime.memberships.has("server:user-1")).toBe(true))
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })
})
