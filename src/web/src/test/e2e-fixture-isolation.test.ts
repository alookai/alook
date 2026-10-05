import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanupGeometryServers, seedGeometryRoutes } from "./e2e-ui/_fixtures/community-loading-geometry"
import { seedChannel, seedDm, seedForumThread, seedMessage, seedServer, seedThread } from "./e2e-ui/_fixtures/seed"

vi.mock("./e2e-ui/_fixtures/community-fixture", () => ({
  expect: {},
  sessionCookie: (key: string) => `fixture-user=${key}`,
  userId: (key: string) => `user-${key}`,
}))

vi.mock("./e2e-ui/_fixtures/seed", async (importOriginal) => ({
  ...await importOriginal<typeof import("./e2e-ui/_fixtures/seed")>(),
  seedServer: vi.fn(),
  seedChannel: vi.fn(),
  seedDm: vi.fn(),
  seedForumThread: vi.fn(),
  seedMessage: vi.fn(),
  seedThread: vi.fn(),
}))

describe("geometry fixture backend resource isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(seedChannel).mockResolvedValue("channel")
    vi.mocked(seedDm).mockResolvedValue("dm")
    vi.mocked(seedForumThread).mockResolvedValue("forum-post")
    vi.mocked(seedMessage).mockResolvedValue("message")
    vi.mocked(seedThread).mockResolvedValue("thread")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("retires only this fixture's twenty servers after the journey", async () => {
    const owned: string[] = []
    let nextId = 0
    vi.mocked(seedServer).mockImplementation(async () => `owned-${++nextId}`)
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", request)

    const routes = await seedGeometryRoutes(owned)
    await cleanupGeometryServers(owned)

    expect(routes).toHaveLength(9)
    expect(owned).toEqual(Array.from({ length: 20 }, (_, index) => `owned-${index + 1}`))
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(
      owned.map((id) => `/api/community/servers/${id}`),
    )
    expect(request.mock.calls.every(([, options]) => options.method === "DELETE"
      && options.headers.Cookie === "fixture-user=dave")).toBe(true)
  })

  it("keeps successful IDs available for teardown when later seeding fails", async () => {
    const owned: string[] = []
    vi.mocked(seedServer)
      .mockResolvedValueOnce("owned-first")
      .mockResolvedValueOnce("owned-second")
      .mockRejectedValueOnce(new Error("seed failed"))
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", request)

    await expect(seedGeometryRoutes(owned)).rejects.toThrow("seed failed")
    await cleanupGeometryServers(owned)

    expect(owned).toEqual(["owned-first", "owned-second"])
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/community/servers/owned-first",
      "/api/community/servers/owned-second",
    ])
  })

  it("attempts every owned ID and reports cleanup errors without treating 404 as failure", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockRejectedValueOnce(new Error("connection failed"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", request)

    const error = await cleanupGeometryServers(["failed", "disconnected", "already-gone", "remaining"])
      .catch((failure: AggregateError) => failure)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/community/servers/failed",
      "/api/community/servers/disconnected",
      "/api/community/servers/already-gone",
      "/api/community/servers/remaining",
    ])
  })
})
