import { afterEach, describe, expect, it } from "vitest"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
import { readCommunityResourceBundle } from "./attention-resources.server"

const fixtures: ReturnType<typeof createCommunitySqliteDb>[] = []
const stamp = "2026-10-28T00:00:00.000Z"
function fixture(count: number) {
  const result = createCommunitySqliteDb()
  fixtures.push(result)
  result.sqlite.prepare('INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt") VALUES (?,?,?,?,0,?,?)').run("viewer", "viewer@example.test", "Viewer", "0001", stamp, stamp)
  result.sqlite.prepare("INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES (?,?,?,?,?,?)").run("server", "Server", "0002", "", "viewer", stamp)
  result.sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('membership','server','viewer','owner')")
  const insert = result.sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at) VALUES (?,?,?,'text','',0,0,0,?)")
  const ids = Array.from({ length: count }, (_, index) => `channel-${index}`)
  for (const id of ids) insert.run(id, "server", id, stamp)
  return { ...result, ids }
}
afterEach(() => { for (const item of fixtures) item.sqlite.close(); fixtures.length = 0 })

describe("full resource hydrator with actual scoped SQL", () => {
  it.each([250, 500])("hydrates all %i public channels within the existing D1 invocation limit", async count => {
    const { db, record, ids } = fixture(count)
    const result = await readCommunityResourceBundle(db, "viewer", { channelIds: ids })
    expect(result.channels.map(row => row.id)).toEqual(ids)
    expect(result.memberships).toHaveLength(count)
    expect(result.profiles).toEqual([expect.objectContaining({ id: "viewer", name: "Viewer", avatar: null, avatarVersion: 0 })])
    console.info(JSON.stringify({ case: "actual-full-resource-sql", channels: count, invocations: record.invocations, statements: record.statements.length, batches: record.batches, maxBindings: Math.max(...record.statements.map(row => row.bindings.length)) }))
    expect(record.invocations).toBeLessThanOrEqual(1000)
    expect(record.statements.every(row => row.bindings.length <= 100)).toBe(true)
  })
})

it("uses one scoped SQL statement for a deduplicated collection, without hiding fanout in batch", async () => {
  const { queries } = await import("@alook/shared")
  const { db, record, ids } = fixture(500)
  expect(await queries.communityChannel.listReadableMessageChannelsForUser(db, "viewer", [])).toEqual([])
  expect(record.statements).toHaveLength(0)
  const result = await queries.communityChannel.listReadableMessageChannelsForUser(db, "viewer", [...ids, ids[0]!])
  expect(new Set(result.map(row => row.id))).toEqual(new Set(ids))
  expect(record.invocations).toBe(1)
  expect(record.statements).toHaveLength(1)
  expect(record.batches).toEqual([])
})

it.each([
  { name: "server owner has no private bypass", allowed: false },
  { name: "private creator", creator: "viewer", allowed: true },
  { name: "private access", relation: "access", allowed: true },
  { name: "private notify is not access", relation: "notify", allowed: false },
  { name: "creator still needs server membership", creator: "viewer", outsider: true, allowed: false },
  { name: "foreign server", foreign: true, allowed: false },
  { name: "child creator has no inherited access", child: true, creator: "viewer", allowed: false },
  { name: "child inherits anchor creator", child: true, parentCreator: "viewer", allowed: true },
  { name: "child inherits anchor access", child: true, parentRelation: "access", allowed: true },
  { name: "child notify is not anchor access", child: true, parentRelation: "notify", allowed: false },
  { name: "missing anchor", child: true, missingParent: true, allowed: false },
])("preserves scoped collection permissions: $name", async scenario => {
  const { sqlite, db } = fixture(1)
  sqlite.exec("INSERT INTO community_category (id,server_id,name,private) VALUES ('private','server','Private',1)")
  sqlite.prepare("INSERT INTO community_channel (id,server_id,category_id,name,type,topic,position,archived,message_count,created_at,creator_id,parent_channel_id) VALUES ('private-channel',?,'private','Private',?,'',0,0,0,?,?,?)")
    .run(scenario.foreign ? "other-server" : "server", scenario.child ? "thread" : "text", stamp, scenario.creator ?? null, scenario.child ? "anchor" : null)
  if (scenario.child && !scenario.missingParent) sqlite.prepare("INSERT INTO community_channel (id,server_id,category_id,name,type,topic,position,archived,message_count,created_at,creator_id) VALUES ('anchor','server','private','Anchor','text','',0,0,0,?,?)").run(stamp, scenario.parentCreator ?? null)
  if (scenario.relation) sqlite.prepare("INSERT INTO community_channel_member (id,channel_id,user_id,relation,source) VALUES ('private-roster','private-channel','viewer',?,'added')").run(scenario.relation)
  if (scenario.parentRelation) sqlite.prepare("INSERT INTO community_channel_member (id,channel_id,user_id,relation,source) VALUES ('anchor-roster','anchor','viewer',?,'added')").run(scenario.parentRelation)
  if (scenario.outsider) sqlite.exec("DELETE FROM community_server_member WHERE user_id='viewer'")
  const operation = readCommunityResourceBundle(db, "viewer", { channelIds: ["channel-0", "private-channel"] })
  if (scenario.allowed) {
    const result = await operation
    expect(result.channels.map(row => row.id)).toEqual(scenario.child ? ["channel-0", "private-channel", "anchor"] : ["channel-0", "private-channel"])
  } else await expect(operation).rejects.toThrow("Attention access changed")
})

it.each([
  { name: "valid pair", allowed: true },
  { name: "blocked by viewer", block: "viewer", allowed: false },
  { name: "blocked by peer", block: "peer", allowed: false },
  { name: "no peer access", noPeer: true, allowed: false },
  { name: "peer notify only", peerRelation: "notify", allowed: false },
  { name: "viewer notify only", viewerRelation: "notify", allowed: false },
])("retains DM message access: $name", async scenario => {
  const { sqlite, db } = fixture(1)
  sqlite.prepare("INSERT INTO community_channel (id,name,type,topic,position,archived,message_count,created_at) VALUES ('dm',NULL,'dm','',0,0,0,?)").run(stamp)
  const member = sqlite.prepare("INSERT INTO community_channel_member (id,channel_id,user_id,relation,source) VALUES (?,'dm',?,?,'added')")
  member.run("dm-viewer", "viewer", scenario.viewerRelation ?? "access")
  if (!scenario.noPeer) member.run("dm-peer", "peer", scenario.peerRelation ?? "access")
  if (scenario.block) sqlite.prepare("INSERT INTO community_friendship (id,requester_id,addressee_id,status) VALUES ('block',?,?,'blocked')").run(scenario.block, scenario.block === "viewer" ? "peer" : "viewer")
  const operation = readCommunityResourceBundle(db, "viewer", { channelIds: ["channel-0", "dm"] })
  if (scenario.allowed) expect((await operation).channels.map(row => row.id)).toEqual(["channel-0", "dm"])
  else await expect(operation).rejects.toThrow("Attention access changed")
})

it("rejects a missing item after valid items and preserves request order without duplicate resources", async () => {
  const { db } = fixture(2)
  await expect(readCommunityResourceBundle(db, "foreign-viewer", { channelIds: ["channel-0"] })).rejects.toThrow("Attention access changed")
  await expect(readCommunityResourceBundle(db, "viewer", { channelIds: ["channel-0", "missing"] })).rejects.toThrow("Attention access changed")
  expect((await readCommunityResourceBundle(db, "viewer", { channelIds: ["channel-1", "channel-0", "channel-1"] })).channels.map(row => row.id)).toEqual(["channel-1", "channel-0"])
})
