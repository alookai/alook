import { afterEach, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { resolveMessageTarget } from "./message-door"
import { parseCommunityMessageWindow } from "./messages"
import { readCommunityConversationEntry } from "./conversation-entry.server"
import { currentConversationReadState, publishConversationEntry } from "./conversation-entry"
import { decodeCommunityReadResponse } from "./read-response"
import { writeCommunityConversationEntryRead } from "./read-contract"
import type { MessageWindowData } from "./message-window"

const stores: ReturnType<typeof createCommunitySqliteDb>[] = []
afterEach(() => { for (const store of stores) store.sqlite.close(); stores.length = 0 })

function fixture() {
  const store = createCommunitySqliteDb(); stores.push(store)
  const stamp = "2026-11-04T00:00:00.000Z"
  const insertUser = store.sqlite.prepare('INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt") VALUES (?,?,?,?,0,?,?)')
  for (const id of ["viewer", "peer"]) insertUser.run(id, `${id}@example.test`, id, id === "viewer" ? "0001" : "0002", stamp, stamp)
  store.sqlite.prepare("INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES ('server','Server','0003','','viewer',?)").run(stamp)
  store.sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('member','server','viewer','owner')")
  store.sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at,creator_id) VALUES ('channel','server','Channel','text','',0,0,99,?,'viewer')").run(stamp)
  const insert = store.sqlite.prepare("INSERT INTO community_message (id,author_id,content,type,channel_id,seq,created_at) VALUES (?,?,?,'default','channel',?,?)")
  for (let seq = 1; seq <= 100; seq++) if (seq !== 8) insert.run(`message-${seq}`, seq <= 7 ? "viewer" : "peer", `Body ${seq}`, seq, new Date(Date.parse(stamp) + seq * 1000).toISOString())
  store.sqlite.prepare("INSERT INTO community_read_state (id,user_id,channel_id,last_read_at,last_read_message_id,last_read_seq) VALUES ('read','viewer','channel',?,'message-5',5)").run(new Date(Date.parse(stamp) + 5000).toISOString())
  store.sqlite.exec("INSERT INTO community_read_state_revision (user_id,revision) VALUES ('viewer',1)")
  return store
}

it("carries the original exact New target outside the newest window through real SQL, decoder and first publication after an ACK", async () => {
  const store = fixture()
  const resolved = await resolveMessageTarget(store.db, "viewer", { id: "channel" }, "human")
  if (!resolved.ok) throw new Error(JSON.stringify(resolved))
  store.sqlite.prepare("UPDATE community_read_state SET last_read_message_id='message-80', last_read_seq=80, last_read_at=?").run("2026-11-04T00:01:20.000Z")
  store.sqlite.exec("UPDATE community_read_state_revision SET revision=2")
  const result = await readCommunityConversationEntry(store.db, { viewerId: "viewer", target: resolved.value,
    window: parseCommunityMessageWindow(new URLSearchParams()), preferTail: true, newAfterSeq: 5 })
  if (!result.ok) throw new Error(JSON.stringify(result))
  expect(result.entry.selection).toEqual({ reason: "tail", anchorMessageId: null })
  expect(result.entry.readState.lastReadSeq).toBe(80)
  expect(result.entry.newBoundary).toEqual({ afterSeq: 5, target: { id: "message-9", channelId: "channel", seq: 9, authorId: "peer" } })
  expect(result.entry.messages.at(-1)?.id).toBe("message-100")
  expect(result.entry.messages.some(message => message.id === "message-9")).toBe(false)
  const response = writeCommunityConversationEntryRead(result.entry)
  expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
  const body = await response.json()
  expect(decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1&window=tail&newAfterSeq=5", "GET", response, body)).toEqual(result.entry)
  expect(() => decodeCommunityReadResponse("/api/community/channels/channel/messages?entry=1&newAfterSeq=6", "GET", response, body)).toThrow("New snapshot mismatch")
  const { client, registry } = await createCommunityQueryOwner("viewer")
  const target = { channelId: "channel", serverId: "server", preferTail: true, newAfterSeq: 5 }
  const proof = { token: captureCommunityLiveSnapshotToken(client, "channel") }
  expect(() => publishConversationEntry(client, { ...target, newAfterSeq: 6 }, result.entry, proof)).toThrow("target mismatch")
  expect(registry.collections.channels.size).toBe(0)
  expect(registry.collections.messages.size).toBe(0)
  const resource = await publishConversationEntry(client, target, result.entry, proof)
  expect(resource.newBoundaryAtEntry).toEqual(result.entry.newBoundary)
  expect(currentConversationReadState(client, "channel")?.lastReadSeq).toBe(80)
  const window = client.getQueryData<MessageWindowData>(resource.windowKey)!
  expect(window.pages[0].messages.at(-1)?.id).toBe("message-100")
  expect(registry.collections.messages.has("message-9")).toBe(false)
})

it("keeps an explicit anchor, handles a deleted read pointer, and rejects a cursor beyond the real receipt", async () => {
  const store = fixture()
  const resolved = await resolveMessageTarget(store.db, "viewer", { id: "channel" }, "human")
  if (!resolved.ok) throw new Error(JSON.stringify(resolved))
  store.sqlite.exec("DELETE FROM community_message WHERE id='message-5'; UPDATE community_channel SET message_count=98 WHERE id='channel'")
  const base = { viewerId: "viewer", target: resolved.value, preferTail: true }
  const explicit = await readCommunityConversationEntry(store.db, { ...base,
    window: parseCommunityMessageWindow(new URLSearchParams({ anchor: "message-20" })) })
  if (!explicit.ok) throw new Error(JSON.stringify(explicit))
  expect(explicit.entry.selection).toEqual({ reason: "explicit_anchor", anchorMessageId: "message-20" })
  expect(explicit.entry.newBoundary.target?.id).toBe("message-9")
  const tail = await readCommunityConversationEntry(store.db, { ...base, window: parseCommunityMessageWindow(new URLSearchParams()) })
  if (!tail.ok) throw new Error(JSON.stringify(tail))
  expect(tail.entry.selection.reason).toBe("tail")
  expect(tail.entry.newBoundary.target?.id).toBe("message-9")
  await expect(readCommunityConversationEntry(store.db, { ...base,
    window: parseCommunityMessageWindow(new URLSearchParams()), newAfterSeq: 101 })).resolves.toMatchObject({ ok: false, status: 400 })
})
