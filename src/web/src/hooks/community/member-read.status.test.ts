import { afterEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { membersPageQueryFn } from "./use-server-members"

const state = vi.hoisted(() => ({ db: null as unknown, wire: null as unknown }))
vi.mock("@/lib/db", () => ({ getDb: () => state.db }))
vi.mock("@/lib/middleware/community-actor", () => ({ withCommunityActor: (handler: (req: NextRequest, ctx: unknown) => Promise<Response>) => (req: NextRequest) => handler(req, { env: {}, actor: { kind: "human", userId: "viewer" }, params: { id: "server" } }) }))
vi.mock("@/lib/api/client", () => ({ apiFetch: async () => {
  const response = await GET(new NextRequest("https://app.example.test/api/community/servers/server/members"), {} as never)
  if (!response.ok) throw new Error(`Actual member producer refused ${response.status}`)
  state.wire = await response.json()
  return state.wire
}, toastApiError: vi.fn() }))
import { GET } from "@/app/api/community/servers/[id]/members/route"

const fixtures: ReturnType<typeof createCommunitySqliteDb>[] = []
afterEach(() => { for (const fixture of fixtures) fixture.sqlite.close(); fixtures.length = 0 })
it("preserves real SQL NULL member status through the actual producer, query and warm canonical profile", async () => {
  const fixture = createCommunitySqliteDb(); fixtures.push(fixture); state.db = fixture.db
  const { sqlite } = fixture
  const stamp = "2026-10-28T00:00:00Z"
  for (const id of ["viewer", "peer"]) sqlite.prepare('INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt") VALUES (?,?,?,?,0,?,?)').run(id, `${id}@example.test`, id, "0042", stamp, stamp)
  sqlite.prepare("INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES ('server','Server','0042','','viewer',?)").run(stamp)
  for (const id of ["viewer", "peer"]) sqlite.prepare("INSERT INTO community_server_member (id,server_id,user_id,role,joined_at) VALUES (?,'server',?,'member',?)").run(`member-${id}`, id, stamp)
  sqlite.exec("INSERT INTO community_user_profile (user_id,status_text,status_emoji) VALUES ('peer',NULL,NULL)")
  expect(sqlite.prepare("SELECT status_text FROM community_user_profile WHERE user_id='peer'").get()).toEqual({ status_text: null })
  const { client, registry } = await createCommunityQueryOwner()
  registry.collections.profiles.utils.writeUpsert({ id: "peer", name: "peer", discriminator: "0042", avatar: null, avatarVersion: 0, statusText: "Stale cached status" })
  await client.query({ queryKey: communityKeys.members("server"), queryFn: ({ signal }) => membersPageQueryFn("server")({ pageParam: null, client, signal }) })
  const wire = state.wire as { members: Array<{ userId: string; statusText: string | null }> }
  expect({ wire: wire.members.find(row => row.userId === "peer")?.statusText, canonical: registry.collections.profiles.get("peer")?.statusText }).toEqual({ wire: null, canonical: null })
})
