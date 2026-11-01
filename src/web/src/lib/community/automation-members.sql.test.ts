import { afterEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => state.db }))
import { readAutomationMembers } from "./automation-read.server"
const fixtures: ReturnType<typeof createCommunitySqliteDb>[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.sqlite.close() })
it("verifies persisted membership across pages without counting invited or deleted accounts", async () => {
  const fixture = createCommunitySqliteDb()
  fixtures.push(fixture)
  state.db = fixture.db
  const stamp = "2026-10-31T00:00:00.000Z"
  const user = fixture.sqlite.prepare('INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt","deletedAt") VALUES (?,?,?,?,0,?,?,?)')
  user.run("owner", "owner@test", "Owner", "0001", stamp, stamp, null)
  user.run("outsider", "outsider@test", "Outsider", "0001", stamp, stamp, null)
  user.run("invited", "invited@test", "Invited", "0001", stamp, stamp, null)
  user.run("deleted", "deleted@test", "Deleted", "0001", stamp, stamp, stamp)
  fixture.sqlite.prepare("INSERT INTO community_server (id,name,discriminator,description,owner_id) VALUES ('server','team','0042','','owner')").run()
  const member = fixture.sqlite.prepare("INSERT INTO community_server_member (id,server_id,user_id,role,joined_at) VALUES (?,'server',?,'member',?)")
  member.run("member-owner", "owner", stamp)
  member.run("member-deleted", "deleted", stamp)
  for (let index = 0; index < 101; index++) {
    const id = `bot-${index.toString().padStart(3, "0")}`
    user.run(id, `${id}@test`, id, "0001", stamp, stamp, null)
    member.run(`member-${id}`, id, stamp)
  }
  const ctx = { env: { DB: {} } as Env, userId: "owner", params: { id: "team#0042" }, beforeCreate: vi.fn(async (): Promise<Response | null> => null) }
  const first = await (await readAutomationMembers(new NextRequest("https://test/api/members"), ctx)).json()
  expect(first.members).toHaveLength(100)
  expect(first.hasMore).toBe(true)
  const second = await (await readAutomationMembers(new NextRequest(`https://test/api/members?${new URLSearchParams({ cursor: first.cursor })}`), ctx)).json()
  expect(second.hasMore).toBe(false)
  const handles = [...first.members, ...second.members].map((value: { handle: string }) => value.handle)
  expect(new Set(handles).size).toBe(102)
  expect(handles).toContain("Owner#0001")
  expect(handles).not.toContain("Invited#0001")
  expect(handles).not.toContain("Deleted#0001")
  expect((await readAutomationMembers(new NextRequest("https://test/api/members"), { ...ctx, userId: "outsider" })).status).toBe(404)
})
