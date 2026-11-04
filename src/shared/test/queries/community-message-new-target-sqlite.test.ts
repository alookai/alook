import { afterEach, expect, it } from "vitest"
import { communityWriteDb } from "../helpers/community-write-db"
import { getFirstPeerMessageAfterSeq } from "../../src/db/queries/community/message"

const stores: ReturnType<typeof communityWriteDb>[] = []
afterEach(() => { for (const store of stores) store.sqlite.close(); stores.length = 0 })

it("returns the first peer ID in the exact scoped sequence interval, with gaps and competing rows", async () => {
  const store = communityWriteDb(); stores.push(store)
  store.sqlite.exec("INSERT INTO community_channel (id,type,created_at) VALUES ('foreign','text','now'),('empty','text','now')")
  const insert = store.sqlite.prepare("INSERT INTO community_message (id,author_id,content,type,channel_id,seq,created_at) VALUES (?,?,'body','default',?,?,'same-time')")
  for (const [id, author, channel, seq] of [
    ["later-peer", "peer", "channel", 15], ["legacy", "peer", "channel", 0],
    ["already-read", "peer", "channel", 4], ["own", "author", "channel", 6],
    ["foreign-peer", "peer", "foreign", 7], ["first-peer", "peer", "channel", 9],
    ["later-own", "author", "channel", 12],
  ] as const) insert.run(id, author, channel, seq)
  const target = { channelId: "channel", viewerId: "author", afterSeq: 5, throughSeq: 20 }
  await expect(getFirstPeerMessageAfterSeq(store.db, { ...target, afterSeq: 0, throughSeq: 5 })).resolves.toEqual({ id: "already-read", channelId: "channel", seq: 4, authorId: "peer" })
  await expect(getFirstPeerMessageAfterSeq(store.db, target)).resolves.toEqual({ id: "first-peer", channelId: "channel", seq: 9, authorId: "peer" })
  await expect(getFirstPeerMessageAfterSeq(store.db, { ...target, throughSeq: 8 })).resolves.toBeNull()
  await expect(getFirstPeerMessageAfterSeq(store.db, { ...target, afterSeq: 9 })).resolves.toEqual({ id: "later-peer", channelId: "channel", seq: 15, authorId: "peer" })
  await expect(getFirstPeerMessageAfterSeq(store.db, { ...target, channelId: "empty" })).resolves.toBeNull()
  store.sqlite.prepare("DELETE FROM community_message WHERE id=?").run("first-peer")
  await expect(getFirstPeerMessageAfterSeq(store.db, target)).resolves.toEqual({ id: "later-peer", channelId: "channel", seq: 15, authorId: "peer" })
})
