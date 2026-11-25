import { afterEach, describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
import { resolveChannelRefTarget } from "./channel-ref-target"
import { readCommunityConversationEntry } from "./conversation-entry.server"
import { resolveMessageTarget } from "./message-door"
import { readCommunityMessageWindow } from "./message-window.server"
import { parseCommunityMessageWindow } from "./messages"
import { writeCommunityConversationEntryRead, writeCommunityMessagesRead } from "./read-contract"
import { decodeCommunityReadResponse } from "./read-response"

const stores: ReturnType<typeof createCommunitySqliteDb>[] = []
afterEach(() => {
  for (const store of stores) store.sqlite.close()
  stores.length = 0
})

function setupRefFixture() {
  const store = createCommunitySqliteDb()
  stores.push(store)
  const stamp = "2026-11-25T00:00:00.000Z"
  const insertUser = store.sqlite.prepare(
    'INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt") VALUES (?,?,?,?,0,?,?)',
  )
  insertUser.run("viewer", "viewer@example.test", "Viewer", "0001", stamp, stamp)
  insertUser.run("owner", "owner@example.test", "Owner", "0002", stamp, stamp)

  store.sqlite.prepare(
    "INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES (?,?,?,?,?,?)",
  ).run("srv_alook", "Alook", "5620", "Main server", "owner", stamp)
  store.sqlite.prepare(
    "INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES (?,?,?,?,?,?)",
  ).run("srv_secret", "Secret", "9999", "Unjoined server", "owner", stamp)

  // viewer is an admin in srv_alook (admins still have NO implicit access to private categories)
  store.sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('sm_v','srv_alook','viewer','admin')")
  store.sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('sm_o','srv_alook','owner','owner')")
  store.sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('sm_so','srv_secret','owner','owner')")

  store.sqlite.exec("INSERT INTO community_category (id,server_id,name,position,private,creator_id) VALUES ('cat_pub','srv_alook','Public',0,0,'owner')")
  store.sqlite.exec("INSERT INTO community_category (id,server_id,name,position,private,creator_id) VALUES ('cat_priv','srv_alook','Private',1,1,'owner')")

  const insertChannel = store.sqlite.prepare(
    "INSERT INTO community_channel (id,server_id,category_id,name,type,topic,position,parent_channel_id,parent_message_id,archived,message_count,created_at,creator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
  insertChannel.run("ch_dm", null, null, null, "dm", "", 0, null, null, 0, 3, stamp, null)
  store.sqlite.exec("INSERT INTO community_channel_member (id,channel_id,user_id,relation,source) VALUES ('dm_v','ch_dm','viewer','access','added')")
  store.sqlite.exec("INSERT INTO community_channel_member (id,channel_id,user_id,relation,source) VALUES ('dm_o','ch_dm','owner','access','added')")

  insertChannel.run("ch_fix", "srv_alook", "cat_pub", "fix", "forum", "Fixes", 0, null, null, 0, 2, stamp, "owner")
  insertChannel.run("ch_general", "srv_alook", "cat_pub", "general", "text", "General", 1, null, null, 0, 0, stamp, "owner")
  insertChannel.run("ch_priv", "srv_alook", "cat_priv", "vault", "forum", "Top Secret", 2, null, null, 0, 1, stamp, "owner")
  insertChannel.run("ch_other_srv", "srv_secret", null, "secret-room", "text", "", 0, null, null, 0, 0, stamp, "owner")

  const insertMsg = store.sqlite.prepare(
    "INSERT INTO community_message (id,author_id,content,type,channel_id,seq,created_at) VALUES (?,?,?,'default',?,?,?)",
  )
  insertMsg.run("m_open_active", "owner", "Active opener", "ch_fix", 381, "2026-11-25T00:01:00.000Z")
  insertMsg.run("m_open_archived", "owner", "Archived opener", "ch_fix", 259, "2026-11-25T00:01:01.000Z")
  insertMsg.run("m_open_no_thread", "owner", "No thread here", "ch_fix", 500, "2026-11-25T00:01:02.000Z")
  insertMsg.run("m_open_priv", "owner", "Private opener", "ch_priv", 7, "2026-11-25T00:01:03.000Z")

  insertChannel.run("post_381", "srv_alook", null, "Ref unification", "thread", "", 0, "ch_fix", "m_open_active", 0, 1, stamp, "owner")
  insertChannel.run("post_259", "srv_alook", null, "Archived fix", "thread", "", 0, "ch_fix", "m_open_archived", 1, 1, stamp, "owner")
  insertChannel.run("post_priv_7", "srv_alook", null, "Confidential Plan", "thread", "", 0, "ch_priv", "m_open_priv", 0, 1, stamp, "owner")

  // DM messages exercising deduplication, case folding, top-level, active post, archived post, private forbidden, missing, and code blocks
  insertMsg.run(
    "dm_m1",
    "owner",
    [
      "See /Alook#5620/fix/#381#12 and /ALOOK#5620/fix/#381#19 and /Alook#5620/general#4",
      "Archived: /Alook#5620/fix/#259",
      "Private channel: /Alook#5620/vault and private post: /Alook#5620/vault/#7#2",
      "Missing: /Secret#9999/secret-room /Alook#5620/nope /Alook#5620/fix/#500 /Alook#5620/fix/#999 /Alook#5620/fix/#0",
      "Inline code `/Alook#5620/fix/#777` must be ignored.",
      "```",
      "/Alook#5620/fix/#888",
      "```",
    ].join("\n"),
    "ch_dm",
    1,
    "2026-11-25T00:02:00.000Z",
  )

  return store
}

describe("message read opt-in includeRefs=1 batch resolution", () => {
  it("omits refs completely when includeRefs is false (strict backward compatibility)", async () => {
    const store = setupRefFixture()
    const resolved = await resolveMessageTarget(store.db, "viewer", { id: "ch_dm" }, "human")
    if (!resolved.ok) throw new Error(JSON.stringify(resolved))

    const entryResult = await readCommunityConversationEntry(store.db, {
      viewerId: "viewer",
      target: resolved.value,
      window: parseCommunityMessageWindow(new URLSearchParams()),
      preferTail: true,
    })
    if (!entryResult.ok) throw new Error(JSON.stringify(entryResult))
    const entryResponse = writeCommunityConversationEntryRead(entryResult.entry)
    const entryBody = await entryResponse.json() as Record<string, unknown>
    expect("refs" in entryBody).toBe(false)

    const pageResult = await readCommunityMessageWindow(store.db, {
      viewerId: "viewer",
      target: resolved.value,
      window: parseCommunityMessageWindow(new URLSearchParams()),
      contract: BUSINESS_SCHEMA_VERSION,
    })
    if (!pageResult.ok) throw new Error(JSON.stringify(pageResult))
    const pageResponse = writeCommunityMessagesRead("ch_dm", pageResult.page)
    const pageBody = await pageResponse.json() as Record<string, unknown>
    expect("refs" in pageBody).toBe(false)
  })

  it("batch-resolves deduplicated refs on entry=1 and window reads without leaking private or missing metadata", async () => {
    const store = setupRefFixture()
    const resolved = await resolveMessageTarget(store.db, "viewer", { id: "ch_dm" }, "human")
    if (!resolved.ok) throw new Error(JSON.stringify(resolved))

    const entryResult = await readCommunityConversationEntry(store.db, {
      viewerId: "viewer",
      target: resolved.value,
      window: parseCommunityMessageWindow(new URLSearchParams()),
      preferTail: true,
      includeRefs: true,
    })
    if (!entryResult.ok) throw new Error(JSON.stringify(entryResult))

    const entryResponse = writeCommunityConversationEntryRead(entryResult.entry)
    expect(entryResponse.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    const entryJson = await entryResponse.json() as Record<string, unknown>
    const decodedEntry = decodeCommunityReadResponse(
      "/api/community/channels/ch_dm/messages?entry=1&window=tail&includeRefs=1",
      "GET",
      entryResponse,
      entryJson,
    ) as typeof entryResult.entry

    const refs = decodedEntry.refs!
    expect(refs).toBeDefined()
    expect(refs.servers.map((s) => s.id)).toEqual(["srv_alook"])
    expect(refs.channels.map((c) => c.id).sort()).toEqual(["ch_fix", "ch_general", "post_259", "post_381"])
    const leakedResources = JSON.stringify({ servers: refs.servers, channels: refs.channels })
    expect(leakedResources).not.toContain("Confidential Plan")
    expect(leakedResources).not.toContain("Top Secret")
    expect(leakedResources).not.toContain("secret-room")
    expect(leakedResources).not.toContain("Unjoined server")
    expect(JSON.stringify(refs)).not.toContain("#777")
    expect(JSON.stringify(refs)).not.toContain("#888")

    expect(refs.resolvedRefs).toEqual([
      { ref: "/alook#5620/fix/#381", status: "ready", serverId: "srv_alook", channelId: "post_381" },
      { ref: "/alook#5620/general", status: "ready", serverId: "srv_alook", channelId: "ch_general" },
      { ref: "/alook#5620/fix/#259", status: "ready", serverId: "srv_alook", channelId: "post_259" },
      { ref: "/alook#5620/vault", status: "forbidden" },
      { ref: "/alook#5620/vault/#7", status: "forbidden" },
      { ref: "/secret#9999/secret-room", status: "missing" },
      { ref: "/alook#5620/nope", status: "missing" },
      { ref: "/alook#5620/fix/#500", status: "missing" },
      { ref: "/alook#5620/fix/#999", status: "missing" },
      { ref: "/alook#5620/fix/#0", status: "missing" },
    ])

    // Also verify ordinary paginated window + anchor read with includeRefs=1
    const pageResult = await readCommunityMessageWindow(store.db, {
      viewerId: "viewer",
      target: resolved.value,
      window: parseCommunityMessageWindow(new URLSearchParams({ anchor: "dm_m1" })),
      contract: BUSINESS_SCHEMA_VERSION,
      includeRefs: true,
    })
    if (!pageResult.ok) throw new Error(JSON.stringify(pageResult))
    const pageResponse = writeCommunityMessagesRead("ch_dm", pageResult.page)
    const decodedPage = decodeCommunityReadResponse(
      "/api/community/channels/ch_dm/messages?anchor=dm_m1&includeRefs=1",
      "GET",
      pageResponse,
      await pageResponse.json(),
    ) as { refs?: typeof refs }
    expect(decodedPage.refs).toEqual(refs)
  })

  it("returns canonical resources on fallback resolveChannelRefTarget and denies private targets", async () => {
    const store = setupRefFixture()
    const archived = await resolveChannelRefTarget(store.db, "viewer", "/Alook#5620/fix/#259#18")
    expect(archived).toMatchObject({
      target: { server: { id: "srv_alook", name: "Alook" }, channel: { id: "post_259", name: "Archived fix", parentChannelId: "ch_fix" } },
    })
    expect("resources" in archived && archived.resources?.servers.map((s) => s.id)).toEqual(["srv_alook"])
    expect("resources" in archived && archived.resources?.channels.map((c) => c.id)).toEqual(["ch_fix", "post_259"])

    expect(await resolveChannelRefTarget(store.db, "viewer", "/Alook#5620/vault/#7")).toEqual({ error: 403 })
    expect(await resolveChannelRefTarget(store.db, "viewer", "/Secret#9999/secret-room")).toEqual({ error: 404 })
  })
})
