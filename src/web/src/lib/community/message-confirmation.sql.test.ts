import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, CommunityMessagePostedSchema, queries } from "@alook/shared"
import type { CommunityActorHandler } from "@/lib/middleware/community-actor"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"
import { projectPostedMessage } from "./message-wire"

const state = vi.hoisted(() => ({ db: null as unknown, dispatch: vi.fn() }))
vi.mock("@/lib/db", () => ({ getDb: () => state.db, getPrimaryDb: () => state.db }))
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: CommunityActorHandler) => (request: NextRequest, context: { params: Record<string, string> }) => handler(request, {
    env: { DB: {} } as Env,
    actor: { kind: "human", userId: "sender", email: "sender@example.test" },
    params: context.params,
  }),
}))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/community/message-dispatcher", () => ({ dispatchCommittedMessage: state.dispatch }))
vi.mock("@/lib/community/fanout", () => ({ fanOutToChannel: vi.fn(), fanOutToServerMembers: vi.fn(), broadcastToUserSafe: vi.fn() }))

import { POST } from "@/app/api/community/channels/[id]/messages/route"

const fixtures: ReturnType<typeof createCommunitySqliteDb>[] = []
const stamp = "2026-10-30T00:00:00.000Z"
const kinds = ["text", "dm", "thread", "forum"] as const

beforeEach(() => { state.dispatch.mockReset().mockResolvedValue(undefined) })
afterEach(() => { for (const fixture of fixtures) fixture.sqlite.close(); fixtures.length = 0 })

function fixture(kind: typeof kinds[number]) {
  const store = createCommunitySqliteDb()
  fixtures.push(store)
  state.db = store.db
  for (const id of ["sender", "peer"]) store.sqlite.prepare('INSERT INTO user (id,email,name,discriminator,"avatarVersion","createdAt","updatedAt","isBot") VALUES (?,?,?,?,0,?,?,0)')
    .run(id, `${id}@example.test`, id, id === "sender" ? "0001" : "0002", stamp, stamp)
  store.sqlite.prepare("INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES ('server','Server','0003','','sender',?)").run(stamp)
  store.sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('member','server','sender','owner')")
  store.sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at) VALUES ('scope',?,'Scope',?,'',0,0,0,?)")
    .run(kind === "dm" ? null : "server", kind, stamp)
  if (kind === "dm") {
    for (const id of ["sender", "peer"]) store.sqlite.prepare("INSERT INTO community_channel_member (id,channel_id,user_id,relation,source,added_by,added_at) VALUES (?,'scope',?,'access','added','sender',?)").run(`scope:${id}`, id, stamp)
    store.sqlite.prepare("INSERT INTO community_friendship (id,requester_id,addressee_id,status,created_at,updated_at) VALUES ('friendship','sender','peer','accepted',?,?)").run(stamp, stamp)
  }
  if (kind === "thread") {
    store.sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at) VALUES ('parent','server','Parent','text','',0,0,1,?)").run(stamp)
    store.sqlite.prepare("INSERT INTO community_message (id,author_id,content,type,channel_id,seq,created_at) VALUES ('anchor','peer','Anchor','default','parent',1,?)").run(stamp)
    store.sqlite.exec("UPDATE community_channel SET parent_channel_id='parent',parent_message_id='anchor' WHERE id='scope'")
  }
  return store
}

async function post(channelId: string, nonce: string) {
  const response = await POST(new NextRequest(`http://localhost/api/community/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
    body: JSON.stringify({ content: "A manual send", nonce }),
  }), { params: { id: channelId } })
  return { response, body: CommunityMessagePostedSchema.parse(await response.json()) }
}

describe("human POST confirmation with actual persisted SQL projections", () => {
  it.each(kinds)("confirms a fresh %s send without exposing its nonce through general reads", async kind => {
    const store = fixture(kind)
    const { response, body } = await post("scope", "fresh-nonce")
    expect(response.status).toBe(201)
    expect(store.sqlite.prepare("SELECT client_nonce AS nonce FROM community_message WHERE id=?").get(body.message.id)).toEqual({ nonce: "fresh-nonce" })
    expect(await queries.communityMessage.getMessage(store.db, body.message.id)).not.toHaveProperty("clientNonce")
    expect(projectPostedMessage(body.message, "fresh-nonce", "scope")).toMatchObject({ id: body.message.id, seq: 1, clientNonce: "fresh-nonce" })
    expect(() => projectPostedMessage(body.message, "wrong-nonce", "scope")).toThrow("Posted message confirmation mismatch")
    expect(() => projectPostedMessage(body.message, "fresh-nonce", "foreign-scope")).toThrow("Posted message confirmation mismatch")
    if (kind === "forum") expect(body.threadId).toEqual(expect.any(String))
  })

  it.each(kinds)("confirms a same-nonce %s retry as the original single committed send", async kind => {
    const store = fixture(kind)
    const first = await post("scope", "retry-nonce")
    expect(first.response.status).toBe(201)
    const batches = store.record.batches.length
    const deliveries = state.dispatch.mock.calls.length
    const replay = await post("scope", "retry-nonce")
    expect(replay.response.status).toBe(200)
    expect(replay.body.deduped).toBe(true)
    expect(replay.body.message.id).toBe(first.body.message.id)
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM community_message WHERE channel_id='scope'").get()).toEqual({ count: 1 })
    expect(store.sqlite.prepare("SELECT next_seq AS seq FROM community_message_seq WHERE channel_id='scope'").get()).toEqual({ seq: 1 })
    expect(store.record.batches).toHaveLength(batches)
    expect(state.dispatch).toHaveBeenCalledTimes(deliveries)
    expect(projectPostedMessage(replay.body.message, "retry-nonce", "scope")).toMatchObject({ id: first.body.message.id, seq: 1, clientNonce: "retry-nonce" })
    expect(await queries.communityMessage.getMessageByAuthorAndNonce(store.db, "peer", "retry-nonce")).toBeNull()
    if (kind === "forum") expect(replay.body.threadId).toBe(first.body.threadId)
  })
})
