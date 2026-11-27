import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BUSINESS_SCHEMA_VERSION,
  COMMUNITY_FOCUS_SET_EVENT,
  WS_EVENTS,
} from "@alook/shared"
import { createMockCtx, createMockWebSocket } from "../__mocks__/cf"
import { createCountingSqliteD1, seedServerWithMembers } from "../test/sqlite-d1"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const { WebSocketDurableObject } = await import("../ws-durable")

const openDbs: Array<{ close: () => void }> = []

afterEach(() => {
  for (const sqlite of openDbs) sqlite.close()
  openDbs.length = 0
})

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe("scope room coordination", () => {
  it("routes auth presence and channel typing through O(1) scope rooms with a single batched presence snapshot", async () => {
    const db = createCountingSqliteD1(openDbs as never)
    seedServerWithMembers(db.sqlite, 1200)
    const now = "2026-11-26T00:00:00.000Z"
    const insertFriend = db.sqlite.prepare(
      "INSERT INTO community_friendship (id, requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?)",
    )
    for (let i = 1; i <= 5; i++) {
      insertFriend.run(`fr-${i}`, "user-0", `user-${i}`, now, now)
    }

    const fetchedTargets: Array<{ id: string; path: string }> = []
    const roomInstances = new Map<string, InstanceType<typeof WebSocketDurableObject>>()
    const userDeliveries: Array<{ userId: string; body: Record<string, unknown> }> = []

    const env = {
      DB: db.d1,
      WS_DO: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((id: string) => ({
          fetch: vi.fn(async (request: Request) => {
            const url = new URL(request.url)
            fetchedTargets.push({ id, path: url.pathname })
            if (id.startsWith("room:")) {
              let roomDo = roomInstances.get(id)
              if (!roomDo) {
                const { ctx } = createMockCtx()
                roomDo = new WebSocketDurableObject(ctx, env)
                roomInstances.set(id, roomDo)
              }
              return roomDo.fetch(request)
            }
            if (url.pathname === "/check-user-online") {
              const online = id === "user:user-1" || id === "user:user-2" || id === "user:user-3"
              return Response.json({ online })
            }
            if (url.pathname === "/community-broadcast") {
              userDeliveries.push({ userId: id, body: await request.clone().json() as Record<string, unknown> })
              return Response.json({ sent: 1 })
            }
            return Response.json({ ok: true })
          }),
        })),
      },
    } as unknown as Env

    const { ctx } = createMockCtx()
    const durable = new WebSocketDurableObject(ctx, env)
    const ws = createMockWebSocket()
    ws.serializeAttachment({
      type: "user",
      userId: "",
      targetUserId: "user-0",
      authenticated: false,
    })

    await durable.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ type: "auth", token: "token-0", communityContract: BUSINESS_SCHEMA_VERSION }),
    )
    await flush()

    const roomPresenceFetches = fetchedTargets.filter((t) => t.id === "room:server:srv-1" && t.path === "/room/presence-change")
    const friendCheckFetches = fetchedTargets.filter((t) => t.path === "/check-user-online")
    const friendBroadcastFetches = fetchedTargets.filter((t) => t.path === "/community-broadcast")

    expect(roomPresenceFetches).toHaveLength(1)
    expect(friendCheckFetches).toHaveLength(5)
    expect(friendBroadcastFetches).toHaveLength(5)
    expect(fetchedTargets.length).toBeLessThan(20)

    const sentFrames = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string; onlineUserIds?: string[] })
    const snapshotFrames = sentFrames.filter((f) => f.type === WS_EVENTS.PRESENCE_SNAPSHOT)
    const individualPresenceFrames = sentFrames.filter((f) => f.type === WS_EVENTS.PRESENCE_UPDATE)
    expect(snapshotFrames).toHaveLength(1)
    expect(snapshotFrames[0]!.onlineUserIds?.sort()).toEqual(["user-1", "user-2", "user-3"])
    expect(individualPresenceFrames).toHaveLength(0)

    const viewerWs = createMockWebSocket()
    viewerWs.serializeAttachment({
      type: "user",
      userId: "user-9",
      targetUserId: "user-9",
      authenticated: true,
      communityContract: BUSINESS_SCHEMA_VERSION,
      sessionId: "sess-9",
      sessionValidUntil: Date.now() + 60_000,
    })
    await durable.webSocketMessage(
      viewerWs as unknown as WebSocket,
      JSON.stringify({
        type: COMMUNITY_FOCUS_SET_EVENT,
        serverId: "srv-1",
        channelIds: ["ch-1"],
        schemaVersion: BUSINESS_SCHEMA_VERSION,
      }),
    )
    await flush()

    fetchedTargets.length = 0
    userDeliveries.length = 0
    await durable.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ type: WS_EVENTS.TYPING_START, channelId: "ch-1", schemaVersion: BUSINESS_SCHEMA_VERSION }),
    )
    await flush()

    const channelRoomFetches = fetchedTargets.filter((t) => t.id === "room:channel:ch-1" && t.path === "/room/typing")
    expect(channelRoomFetches).toHaveLength(1)
    expect(userDeliveries.map((d) => d.userId)).toEqual(["user:user-9"])
    expect(userDeliveries[0]!.body).toMatchObject({
      type: WS_EVENTS.TYPING_START,
      channelId: "ch-1",
      userId: "user-0",
    })
  })

  it("persists active viewers and online users across DO eviction and renews TTL past 30m on connection.ping", async () => {
    const db = createCountingSqliteD1(openDbs as never)
    seedServerWithMembers(db.sqlite, 2)
    let nowMs = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs)
    try {
      const roomStores = new Map<string, Map<string, unknown>>()
      const deliveredToUsers: string[] = []

      const makePersistedRoomDo = (roomId: string) => {
        let backing = roomStores.get(roomId)
        if (!backing) {
          backing = new Map<string, unknown>()
          roomStores.set(roomId, backing)
        }
        const { ctx } = createMockCtx()
        const sharedStorage = {
          get: vi.fn(async (key: string) => backing!.get(key)),
          put: vi.fn(async (key: string, val: unknown) => { backing!.set(key, val) }),
          delete: vi.fn(async (key: string) => { backing!.delete(key) }),
        }
        const roomCtx = { ...ctx, storage: sharedStorage } as unknown as DurableObjectState
        return new WebSocketDurableObject(roomCtx, env)
      }

      const env = {
        DB: db.d1,
        WS_DO: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn((id: string) => ({
            fetch: vi.fn(async (request: Request) => {
              if (id.startsWith("room:")) {
                return makePersistedRoomDo(id).fetch(request)
              }
              deliveredToUsers.push(id)
              return Response.json({ sent: 1 })
            }),
          })),
        },
      } as unknown as Env

      const { ctx: userCtx } = createMockCtx()
      const userDo = new WebSocketDurableObject(userCtx, env)
      const viewerWs = createMockWebSocket()
      viewerWs.serializeAttachment({
        type: "user",
        userId: "user-1",
        targetUserId: "user-1",
        authenticated: true,
        communityContract: BUSINESS_SCHEMA_VERSION,
        sessionId: "sess-1",
        sessionValidUntil: nowMs + 60 * 60_000,
        focusRenewedAt: nowMs,
      })

      await userDo.webSocketMessage(
        viewerWs as unknown as WebSocket,
        JSON.stringify({
          type: COMMUNITY_FOCUS_SET_EVENT,
          serverId: "srv-1",
          channelIds: ["ch-1"],
          schemaVersion: BUSINESS_SCHEMA_VERSION,
        }),
      )
      await makePersistedRoomDo("room:server:srv-1").fetch(new Request("http://internal/room/presence-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-1", online: true }),
      }))

      deliveredToUsers.length = 0
      await makePersistedRoomDo("room:channel:ch-1").fetch(new Request("http://internal/room/typing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderUserId: "user-0",
          event: { type: WS_EVENTS.TYPING_START, channelId: "ch-1", userId: "user-0" },
        }),
      }))
      expect(deliveredToUsers).toEqual(["user:user-1"])

      nowMs += 12 * 60_000
      await userDo.webSocketMessage(
        viewerWs as unknown as WebSocket,
        JSON.stringify({ type: "connection.ping", nonce: "n-1" }),
      )
      await flush()

      nowMs += 23 * 60_000
      deliveredToUsers.length = 0
      await makePersistedRoomDo("room:channel:ch-1").fetch(new Request("http://internal/room/typing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderUserId: "user-0",
          event: { type: WS_EVENTS.TYPING_START, channelId: "ch-1", userId: "user-0" },
        }),
      }))
      expect(deliveredToUsers).toEqual(["user:user-1"])

      const snapshotResp = await makePersistedRoomDo("room:server:srv-1").fetch(new Request("http://internal/room/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-2", active: true, includeSnapshot: true }),
      }))
      expect(await snapshotResp.json()).toEqual({ ok: true, onlineUserIds: ["user-1"] })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("relays to 500 room viewers and 500 friends within <= 400 subrequests per hop and bounded server fan-out concurrency", async () => {
    const db = createCountingSqliteD1(openDbs as never)
    seedServerWithMembers(db.sqlite, 500)
    const now = "2026-11-26T00:00:00.000Z"
    const insertFriend = db.sqlite.prepare(
      "INSERT INTO community_friendship (id, requester_id, addressee_id, status, created_at, updated_at) VALUES (?, 'user-0', ?, 'accepted', ?, ?)",
    )
    const insertServer = db.sqlite.prepare(
      "INSERT INTO community_server (id, name, discriminator, description, owner_id, created_at) VALUES (?, ?, '0001', '', 'user-0', ?)",
    )
    const insertMember = db.sqlite.prepare(
      "INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, ?, 'user-0', 'owner', ?)",
    )
    db.sqlite.exec("BEGIN")
    for (let i = 1; i <= 500; i++) {
      insertFriend.run(`fr-big-${i}`, `user-${i}`, now, now)
    }
    for (let s = 2; s <= 85; s++) {
      insertServer.run(`srv-${s}`, `Srv${s}`, now)
      insertMember.run(`mem-s-${s}`, `srv-${s}`, now)
    }
    db.sqlite.exec("COMMIT")

    const deliveredViewers = new Set<string>()
    const subrequestsByCaller = new Map<string, number>()
    const roomInstances = new Map<string, InstanceType<typeof WebSocketDurableObject>>()
    let activeServerFetches = 0
    let maxConcurrentServerFetches = 0

    const makeEnvForCaller = (callerId: string): Env => ({
      DB: db.d1,
      WS_DO: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((targetId: string) => ({
          fetch: vi.fn(async (request: Request) => {
            subrequestsByCaller.set(callerId, (subrequestsByCaller.get(callerId) ?? 0) + 1)
            const url = new URL(request.url)
            if (targetId.startsWith("room:server:")) {
              activeServerFetches += 1
              maxConcurrentServerFetches = Math.max(maxConcurrentServerFetches, activeServerFetches)
              await Promise.resolve()
              activeServerFetches -= 1
              return Response.json({ ok: true, notified: 0 })
            }
            if (targetId.startsWith("room:")) {
              let roomDo = roomInstances.get(targetId)
              if (!roomDo) {
                const { ctx } = createMockCtx()
                roomDo = new WebSocketDurableObject(ctx, makeEnvForCaller(targetId))
                roomInstances.set(targetId, roomDo)
              }
              return await roomDo.fetch(request)
            }
            if (url.pathname === "/check-user-online") {
              return Response.json({ online: true })
            }
            deliveredViewers.add(targetId)
            return Response.json({ sent: 1 })
          }),
        })),
      },
    } as unknown as Env)

    const { ctx: roomCtx } = createMockCtx()
    const channelRoom = new WebSocketDurableObject(roomCtx, makeEnvForCaller("room:channel:ch-500"))
    for (let i = 1; i <= 500; i++) {
      await channelRoom.fetch(new Request("http://internal/room/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: `user-${i}`, active: true }),
      }))
    }
    const typingRes = await channelRoom.fetch(new Request("http://internal/room/typing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senderUserId: "user-0",
        event: { type: WS_EVENTS.TYPING_START, channelId: "ch-500", userId: "user-0" },
      }),
    }))
    expect(typingRes.status).toBe(200)
    expect(await typingRes.json()).toEqual({ ok: true, notified: 500 })
    expect(deliveredViewers.size).toBe(500)
    expect(subrequestsByCaller.get("room:channel:ch-500")).toBe(400)
    expect(subrequestsByCaller.get("room:relay:broadcast:1")).toBe(101)

    subrequestsByCaller.clear()
    deliveredViewers.clear()
    const { ctx: userCtx } = createMockCtx()
    const userDo = new WebSocketDurableObject(userCtx, makeEnvForCaller("user:user-0"))
    const ws = createMockWebSocket()
    ws.serializeAttachment({
      type: "user",
      userId: "",
      targetUserId: "user-0",
      authenticated: false,
    })
    await userDo.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ type: "auth", token: "token-0", communityContract: BUSINESS_SCHEMA_VERSION }),
    )
    await flush()

    expect(maxConcurrentServerFetches).toBeLessThanOrEqual(40)
    expect(deliveredViewers.size).toBe(500)
    const snapshotFrame = ws.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; onlineUserIds?: string[] })
      .find((f) => f.type === WS_EVENTS.PRESENCE_SNAPSHOT)
    expect(snapshotFrame?.onlineUserIds).toHaveLength(500)
    expect(subrequestsByCaller.get("room:relay:broadcast:1")).toBe(101)
    expect(subrequestsByCaller.get("room:relay:presence:1")).toBe(101)
  })

  it("includes unfriended DM peers (and excludes blocked peers) in presence snapshots and live updates", async () => {
    const db = createCountingSqliteD1(openDbs as never)
    seedServerWithMembers(db.sqlite, 2)
    const now = "2026-11-26T00:00:00.000Z"
    db.sqlite.exec("BEGIN")
    db.sqlite.prepare(
      "INSERT INTO community_channel (id, server_id, name, type, topic, position, archived, message_count, created_at, creator_id) VALUES ('dm-1', NULL, 'dm-1', 'dm', '', 0, 0, 0, ?, 'user-0')",
    ).run(now)
    db.sqlite.prepare(
      "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES ('cm-0', 'dm-1', 'user-0', 'access', 'dm', ?)",
    ).run(now)
    db.sqlite.prepare(
      "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES ('cm-1', 'dm-1', 'user-1', 'access', 'dm', ?)",
    ).run(now)
    db.sqlite.prepare(
      "INSERT INTO community_channel (id, server_id, name, type, topic, position, archived, message_count, created_at, creator_id) VALUES ('dm-blocked', NULL, 'dm-blocked', 'dm', '', 0, 0, 0, ?, 'user-0')",
    ).run(now)
    db.sqlite.prepare(
      "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES ('cm-b0', 'dm-blocked', 'user-0', 'access', 'dm', ?)",
    ).run(now)
    db.sqlite.prepare(
      "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES ('cm-b2', 'dm-blocked', 'user-2', 'access', 'dm', ?)",
    ).run(now)
    db.sqlite.prepare(
      "INSERT INTO community_friendship (id, requester_id, addressee_id, status, created_at, updated_at) VALUES ('fr-block', 'user-0', 'user-2', 'blocked', ?, ?)",
    ).run(now, now)
    db.sqlite.exec("COMMIT")

    const delivered: Array<{ id: string; body: Record<string, unknown> }> = []
    const env = {
      DB: db.d1,
      WS_DO: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((id: string) => ({
          fetch: vi.fn(async (request: Request) => {
            const url = new URL(request.url)
            if (id.startsWith("room:")) return Response.json({ ok: true, notified: 0 })
            if (url.pathname === "/check-user-online") {
              return Response.json({ online: id === "user:user-1" || id === "user:user-2" })
            }
            if (url.pathname === "/community-broadcast") {
              delivered.push({ id, body: await request.clone().json() as Record<string, unknown> })
              return Response.json({ sent: 1 })
            }
            return Response.json({ ok: true })
          }),
        })),
      },
    } as unknown as Env

    const { ctx } = createMockCtx()
    const userDo = new WebSocketDurableObject(ctx, env)
    const ws = createMockWebSocket()
    ws.serializeAttachment({
      type: "user",
      userId: "",
      targetUserId: "user-0",
      authenticated: false,
    })

    await userDo.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ type: "auth", token: "token-0", communityContract: BUSINESS_SCHEMA_VERSION }),
    )
    await flush()

    const snapshotFrame = ws.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; onlineUserIds?: string[] })
      .find((f) => f.type === WS_EVENTS.PRESENCE_SNAPSHOT)
    expect(snapshotFrame?.onlineUserIds).toEqual(["user-1"])
    expect(delivered.map((d) => d.id)).toEqual(["user:user-1"])
    expect(delivered[0]!.body).toMatchObject({
      type: WS_EVENTS.PRESENCE_UPDATE,
      userId: "user-0",
      online: true,
    })
  })

  it("refuses to overwrite persisted room maps when hydration fails and recovers once storage is healthy", async () => {
    const nowMs = Date.now()
    const backing = new Map<string, unknown>([
      ["scope-room:active-viewers", { "user-1": nowMs }],
      ["scope-room:online-users", { "user-1": nowMs, "user-2": nowMs }],
    ])
    let failGet = true
    const storage = {
      get: vi.fn(async (key: string) => {
        if (failGet) throw new Error("transient storage failure")
        return backing.get(key)
      }),
      put: vi.fn(async (key: string, val: unknown) => {
        backing.set(key, val)
      }),
      delete: vi.fn(async (key: string) => {
        backing.delete(key)
      }),
    }
    const { ctx } = createMockCtx()
    const roomCtx = { ...ctx, storage } as unknown as DurableObjectState
    const env = {
      WS_DO: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ sent: 1 })) })),
      },
    } as unknown as Env
    const roomDo = new WebSocketDurableObject(roomCtx, env)

    const failedFocus = await roomDo.fetch(new Request("http://internal/room/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-3", active: true, includeSnapshot: true }),
    }))
    expect(failedFocus.status).toBe(503)
    expect(storage.put).not.toHaveBeenCalled()
    expect(backing.get("scope-room:active-viewers")).toEqual({ "user-1": nowMs })
    expect(backing.get("scope-room:online-users")).toEqual({ "user-1": nowMs, "user-2": nowMs })

    failGet = false
    const recoveredFocus = await roomDo.fetch(new Request("http://internal/room/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-3", active: true, includeSnapshot: true }),
    }))
    expect(recoveredFocus.status).toBe(200)
    const body = await recoveredFocus.json() as { ok: boolean; onlineUserIds?: string[] }
    expect(body.ok).toBe(true)
    expect(body.onlineUserIds?.sort()).toEqual(["user-1", "user-2"])
    expect(Object.keys(backing.get("scope-room:active-viewers") as Record<string, number>).sort()).toEqual(["user-1", "user-3"])
  })
})
