import { afterEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
import { assertCaseProfileBaseline } from "@/test/e2e-ui/_fixtures/case-profile-baseline"

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/db", () => ({ getDb: () => state.db }))
vi.mock("@/lib/auth", () => ({ getAuth: vi.fn() }))
vi.mock("@/lib/community/fanout", () => ({ fanOutProfileUpdate: vi.fn(), fanOutStatusUpdate: vi.fn() }))
vi.mock("@/lib/middleware/community-actor", () => ({ communityActorPolicy: () => ({ resolve: async (req: NextRequest) => ({ context: { env: {}, actor: { kind: "human", userId: "new-user" } } }) }) }))
import { GET } from "@/app/api/community/users/me/profile/route"

const fixtures: ReturnType<typeof createCommunitySqliteDb>[] = []
afterEach(() => { for (const fixture of fixtures) fixture.sqlite.close(); fixtures.length = 0 })
it("accepts the actual new-user DB facts through the current self GET and case baseline", async () => {
  const fixture = createCommunitySqliteDb(); fixtures.push(fixture); state.db = fixture.db
  fixture.sqlite.exec(`INSERT INTO user (id,email,name,discriminator,"avatarVersion") VALUES ('new-user','new@example.test','New User','0042',0)`)
  expect(fixture.sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id=?").get("new-user")).toBeUndefined()
  const response = await GET(new NextRequest("https://app.example.test/api/community/users/me/profile"), {} as never)
  expect(response.status).toBe(200)
  const profile = await response.json()
  expect(profile).toEqual({ id: "new-user", name: "New User", discriminator: "0042", avatar: null, avatarVersion: 0, aboutMe: "", bannerColor: null, statusEmoji: null, statusText: null })
  expect(() => assertCaseProfileBaseline(profile, { userId: "new-user", name: "New User" }, "viewer")).not.toThrow()
})
