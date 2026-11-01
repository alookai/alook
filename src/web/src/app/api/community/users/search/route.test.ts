import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, CommunityReadErrorSchema, CommunityUserSearchReadSchema, DEFAULT_USER_SEARCH_LIMIT, MIN_SEARCH_LENGTH, MAX_SEARCH_LENGTH } from "@alook/shared"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"

let database: ReturnType<typeof createCommunitySqliteDb>
vi.mock("@/lib/db", () => ({ getDb: () => database.db }))
vi.mock("@/lib/middleware/auth", async () => {
  const { protectCommunityJsonResponse } = await import("@/lib/middleware/response-cache")
  return { humanAuthPolicy: {
    resolve: async () => ({ context: { env: { DB: {} } as Env, userId: "viewer", email: "viewer@example.test" } }),
    respond: protectCommunityJsonResponse,
  } }
})
import { GET } from "./route"

function seed(id: string, name: string, discriminator = "0042", image: string | null = null, avatarVersion = 0, deletedAt: string | null = null) {
  database.sqlite.prepare('INSERT INTO user (id,name,email,discriminator,image,"avatarVersion","createdAt","updatedAt","deletedAt") VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, name, `${id}@example.test`, discriminator, image, avatarVersion, "2026-10-29T00:00:00Z", "2026-10-29T00:00:00Z", deletedAt)
}
async function request(query?: string) {
  const url = new URL("http://localhost/api/community/users/search")
  if (query !== undefined) url.searchParams.set("q", query)
  return GET(new NextRequest(url, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } }), {} as never)
}
async function result(query: string) {
  const response = await request(query)
  expect(response.status).toBe(200)
  expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
  return CommunityUserSearchReadSchema.parse(await response.json()).users
}

beforeEach(() => { database = createCommunitySqliteDb() })
afterEach(() => { database.sqlite.close() })

describe("GET user search through the real handler and Shared SQL", () => {
  it.each([undefined, "", "   ", "a".repeat(MIN_SEARCH_LENGTH - 1), "a".repeat(MAX_SEARCH_LENGTH + 1)])("rejects an invalid query before SQL (%s)", async query => {
    const response = await request(query)
    expect(response.status).toBe(400)
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    const error = CommunityReadErrorSchema.parse(await response.json())
    expect(error.error.message).toContain(query === undefined || !query.trim() ? "q is required" : query.length < MIN_SEARCH_LENGTH ? "at least" : "≤")
    expect(database.record.invocations).toBe(0)
  })

  it("accepts the minimum query length", async () => {
    const name = "a".repeat(MIN_SEARCH_LENGTH)
    seed("minimum", name)
    expect(await result(name)).toMatchObject([{ id: "minimum", name, discriminator: "0042", image: null, avatarVersion: 0 }])
  })

  it("accepts the maximum query length", async () => {
    const name = "a".repeat(MAX_SEARCH_LENGTH)
    seed("maximum", name)
    expect((await result(name)).map(user => user.id)).toEqual(["maximum"])
  })

  it("trims a substring query and excludes the viewer and actual deleted rows", async () => {
    seed("viewer", "Ada")
    seed("ada", "Ada")
    seed("adaline", "Adaline", "0063")
    seed("other", "Other")
    seed("deleted", "Ada", "0081", null, 0, "2026-10-28T00:00:00Z")
    expect(new Set((await result("  Ada  ")).map(user => user.id))).toEqual(new Set(["ada", "adaline"]))
  })

  it("matches an exact name and tag rather than a name substring or another tag", async () => {
    seed("viewer", "Ada", "0042")
    seed("exact", "Ada", "0042")
    seed("different-tag", "Ada", "0043")
    seed("longer-name", "Adaline", "0042")
    expect((await result("  Ada  #0042  ")).map(user => user.id)).toEqual(["exact"])
  })

  it("limits after viewer exclusion using the existing Shared search limit", async () => {
    seed("viewer", "Limit viewer")
    for (let index = 0; index < DEFAULT_USER_SEARCH_LIMIT + 4; index++) seed(`user-${index}`, `Limit ${index}`)
    const users = await result("Limit")
    expect(users).toHaveLength(DEFAULT_USER_SEARCH_LIMIT)
    expect(users.every(user => user.id.startsWith("user-"))).toBe(true)
    expect(users.some(user => user.id === "viewer")).toBe(false)
  })

  it("preserves a legitimate null image and canonicalizes only owned image URLs by the actual version", async () => {
    seed("null", "Avatar null", "0042", null, 0)
    seed("owned", "Avatar owned", "0043", "/api/community/users/owned/avatar", 7)
    seed("external", "Avatar external", "0044", "https://images.example.test/avatar.png", 3)
    const users = new Map((await result("Avatar")).map(user => [user.id, user]))
    expect(users.get("null")).toEqual({ id: "null", name: "Avatar null", discriminator: "0042", image: null, avatarVersion: 0 })
    expect(users.get("owned")).toMatchObject({ image: "/api/community/users/owned/avatar?v=7", avatarVersion: 7 })
    expect(users.get("external")).toMatchObject({ image: "https://images.example.test/avatar.png", avatarVersion: 3 })
  })

  it("returns the current Shared empty result when no user matches", async () => {
    seed("other", "Other")
    expect(await result("Absent")).toEqual([])
  })
})
