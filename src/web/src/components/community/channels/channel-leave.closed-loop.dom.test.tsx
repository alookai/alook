import { createRequire } from "node:module"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite"

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType
}
import React, { useState } from "react"
import { NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, CommunityMembersReadSchema } from "@alook/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { channelMembershipKey } from "@/lib/community-db/schema"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityChannelMembersSnapshot,
  publishCommunityChannelMetadata,
  retireCommunityChannelReading,
  setCanonicalCommunityChannelMember,
} from "@/lib/community-db/sync"

let activeD1!: D1Database
let broadcastHook: ((userId: string, event: Record<string, unknown>) => Promise<void> | void) | null = null
const apiFetchMock = vi.fn()
const toastApiErrorMock = vi.fn()

vi.mock("@/lib/middleware/community-actor", () => ({
  communityActorPolicy: () => ({
    resolve: async () => ({
      context: {
        env: { DB: activeD1 },
        actor: { kind: "human" as const, userId: "viewer", email: "viewer@test.local" },
      },
    }),
  }),
}))

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: async (userId: string, event: Record<string, unknown>) => {
    await broadcastHook?.(userId, event)
  },
}))

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client")
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    toastApiError: (...args: unknown[]) => toastApiErrorMock(...args),
  }
})

function createMigratedSqliteD1() {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON;")
  const migrationsDir = resolve(import.meta.dirname, "../../../../migrations")
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"))
  }

  const makeStmt = (sql: string, bound: SQLInputValue[] = []) => ({
    bind: (...values: unknown[]) => makeStmt(sql, values as SQLInputValue[]),
    all: async () => {
      const stmt = sqlite.prepare(sql)
      const results = stmt.all(...bound)
      return { success: true, meta: {}, results }
    },
    run: async () => {
      const stmt = sqlite.prepare(sql)
      const info = stmt.run(...bound)
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }
    },
    first: async (col?: string) => {
      const row = sqlite.prepare(sql).get(...bound) as Record<string, unknown> | undefined
      if (!row) return null
      return col ? (row[col] ?? null) : row
    },
    raw: async () => {
      const stmt = sqlite.prepare(sql)
      stmt.setReturnArrays(true)
      return stmt.all(...bound)
    },
  })

  const d1 = {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts: Array<{ all: () => Promise<unknown> }>) => {
      const out = []
      for (const s of stmts) out.push(await s.all())
      return out
    },
    exec: async (sql: string) => {
      sqlite.exec(sql)
      return { count: 1, duration: 0 }
    },
    withSession: () => d1,
  } as unknown as D1Database

  return { sqlite, d1 }
}

describe("Channel & Thread Leave — real SQLite + Next DELETE route + UI closed loop", () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    toastApiErrorMock.mockReset()
    broadcastHook = null
  })

  it("completes private text channel, private forum, and joined thread self-leave end-to-end across WS-first, HTTP-first, route-exit, and retry", async () => {
    const { sqlite, d1 } = createMigratedSqliteD1()
    activeD1 = d1
    const now = "2026-11-16T00:00:00.000Z"
    sqlite.prepare(`INSERT INTO user (id, name, email, emailVerified, discriminator, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)`).run("alice", "Alice", "alice@test.local", "0001", now, now)
    sqlite.prepare(`INSERT INTO user (id, name, email, emailVerified, discriminator, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)`).run("viewer", "Viewer", "viewer@test.local", "0002", now, now)
    sqlite.prepare(`INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES (?, ?, ?, ?, ?)`).run("s1", "Alook", "5620", "alice", now)
    sqlite.prepare(`INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)`).run("sm_alice", "s1", "alice", "owner", now)
    sqlite.prepare(`INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)`).run("sm_viewer", "s1", "viewer", "member", now)
    sqlite.prepare(`INSERT INTO community_category (id, server_id, name, position, private) VALUES (?, ?, ?, 0, 0)`).run("cat_pub", "s1", "Public")
    sqlite.prepare(`INSERT INTO community_category (id, server_id, name, position, private) VALUES (?, ?, ?, 1, 1)`).run("cat_priv", "s1", "Private")
    sqlite.prepare(`INSERT INTO community_channel (id, server_id, category_id, name, type, creator_id, created_at) VALUES (?, ?, ?, ?, 'text', ?, ?)`).run("pub-text", "s1", "cat_pub", "general", "alice", now)
    sqlite.prepare(`INSERT INTO community_channel (id, server_id, category_id, name, type, creator_id, created_at) VALUES (?, ?, ?, ?, 'text', ?, ?)`).run("priv-text", "s1", "cat_priv", "secret-text", "alice", now)
    sqlite.prepare(`INSERT INTO community_channel (id, server_id, category_id, name, type, creator_id, created_at) VALUES (?, ?, ?, ?, 'forum', ?, ?)`).run("priv-forum", "s1", "cat_priv", "secret-forum", "alice", now)
    sqlite.prepare(`INSERT INTO community_channel (id, server_id, category_id, name, type, creator_id, created_at) VALUES (?, ?, ?, ?, 'text', ?, ?)`).run("priv-stale", "s1", "cat_priv", "secret-stale", "alice", now)
    sqlite.prepare(`INSERT INTO community_channel (id, server_id, category_id, name, type, parent_channel_id, creator_id, created_at) VALUES (?, ?, NULL, ?, 'thread', ?, ?, ?)`).run("thread-1", "s1", "design-thread", "pub-text", "alice", now)

    for (const ch of ["priv-text", "priv-forum", "priv-stale"]) {
      sqlite.prepare(`INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, 'alice', 'access', 'added', ?)`).run(`cm_${ch}_alice`, ch, now)
      sqlite.prepare(`INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, 'viewer', 'access', 'added', ?)`).run(`cm_${ch}_viewer`, ch, now)
    }
    sqlite.prepare(`INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES ('cm_t1_alice', 'thread-1', 'alice', 'notify', 'spoke', ?)`).run(now)
    sqlite.prepare(`INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES ('cm_t1_viewer', 'thread-1', 'viewer', 'notify', 'spoke', ?)`).run(now)

    const { DELETE: deleteMemberRoute } = await import("@/app/api/community/channels/[id]/members/[userId]/route")
    const { DELETE: deleteParticipantRoute } = await import("@/app/api/community/channels/[id]/participants/[userId]/route")
    const { ChannelHeader } = await import("./channel-header")
    const { useChannelMemberViewModel } = await import("../members/channel-member-view-model")

    const createSeededOwner = async (id: string, type: "text" | "forum" | "thread", parentChannelId: string | null = null) => {
      const owner = await createCommunityQueryOwner()
      const token = captureCommunityLiveSnapshotToken(owner.client)
      await publishCommunityChannelMetadata(owner.client, {
        metadata: {
          id, serverId: "s1", categoryId: parentChannelId ? null : "cat_priv", name: id, type,
          topic: "", position: 0, messageCount: 0, parentChannelId, parentMessageId: null,
          creatorId: "alice", archived: false, lastMessageAt: null, createdAt: now,
        },
        proof: { token },
      })
      const relation = type === "thread" ? "notify" : "access"
      await publishCommunityChannelMembersSnapshot(
        owner.client, "s1", id, relation,
        [
          { channelId: id, userId: "alice", relation, source: "explicit", role: "owner", memberId: "sm_alice", isCreator: true },
          { channelId: id, userId: "viewer", relation, source: "explicit", role: "member", memberId: "sm_viewer", isCreator: false },
        ],
        { token },
        [
          { id: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 },
          { id: "viewer", name: "Viewer", discriminator: "0002", avatar: "V", avatarVersion: 0 },
        ],
      )
      return owner
    }

    const deleteStatuses: Array<{ path: string; status: number }> = []
    let lastDeleteSignal: AbortSignal | undefined
    let failNextDelete = false
    let gateNextDelete: Promise<void> | null = null
    apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; signal?: AbortSignal; assertActive?: () => void }) => {
      const qualify = () => {
        init?.assertActive?.()
        if (init?.signal?.aborted) throw new DOMException("Cancelled request", "AbortError")
      }
      qualify()
      if (init?.method === "DELETE") {
        lastDeleteSignal = init.signal
        if (gateNextDelete) {
          const waitGate = gateNextDelete
          gateNextDelete = null
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              try { qualify() } catch (err) { reject(err); return }
              reject(new DOMException("Cancelled request", "AbortError"))
            }
            init.signal?.addEventListener("abort", onAbort, { once: true })
            void waitGate.then(() => {
              init.signal?.removeEventListener("abort", onAbort)
              resolve()
            })
          })
          qualify()
        }
        if (failNextDelete) {
          failNextDelete = false
          const err = Object.assign(new Error("Internal failure"), { status: 500 })
          throw err
        }
        const memberMatch = path.match(/^\/api\/community\/channels\/([^/]+)\/members\/([^/]+)$/)
        if (memberMatch) {
          const [, id, userId] = memberMatch
          const res = await deleteMemberRoute(new NextRequest(`http://localhost${path}`, { method: "DELETE" }), { params: { id, userId } })
          deleteStatuses.push({ path, status: res.status })
          qualify()
          if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`)
          return undefined
        }
        const partMatch = path.match(/^\/api\/community\/channels\/([^/]+)\/participants\/([^/]+)$/)
        if (partMatch) {
          const [, id, userId] = partMatch
          const res = await deleteParticipantRoute(new NextRequest(`http://localhost${path}`, { method: "DELETE" }), { params: { id, userId } })
          deleteStatuses.push({ path, status: res.status })
          qualify()
          if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`)
          return undefined
        }
      }
      if (path.includes("/members?relation=")) {
        const [, id, rel] = path.match(/^\/api\/community\/channels\/([^/]+)\/members\?relation=(access|notify)$/)!
        const rows = sqlite.prepare(`SELECT user_id FROM community_channel_member WHERE channel_id = ? AND relation = ?`).all(id, rel) as Array<{ user_id: string }>
        return CommunityMembersReadSchema.parse({
          contractVersion: BUSINESS_SCHEMA_VERSION,
          channelId: id,
          relation: rel,
          members: rows.map((r) => ({
            channelId: id, userId: r.user_id, relation: rel, source: "explicit",
            role: r.user_id === "alice" ? "owner" : "member", memberId: `sm_${r.user_id}`, isCreator: r.user_id === "alice",
          })),
          profiles: [
            { id: "alice", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 },
            { id: "viewer", name: "Viewer", discriminator: "0002", avatar: "V", avatarVersion: 0 },
          ],
        })
      }
      if (path.includes("/servers/s1/members")) {
        return { members: [], nextCursor: null }
      }
      throw new Error(`Unhandled path: ${path}`)
    })

    const navigatedTo: string[] = []
    const serverModel = {
      categories: [
        { private: false, channels: [{ id: "pub-text", type: "text" }] },
        { private: true, channels: [{ id: "priv-text", type: "text" }, { id: "priv-forum", type: "forum" }, { id: "priv-stale", type: "text" }] },
      ],
    }

    function LiveSurface({ initialChannelId, kind, parentId }: { initialChannelId: string; kind: "text" | "forum" | "thread"; parentId?: string }) {
      const [accessAllowed, setAccessAllowed] = useState(true)
      const [routeActive, setRouteActive] = useState(true)
      ;(globalThis as Record<string, unknown>).__setRouteState = { setAccessAllowed, setRouteActive }
      const vm = useChannelMemberViewModel({
        serverId: "s1",
        channelId: initialChannelId,
        channelName: initialChannelId,
        currentServer: serverModel,
        channelInServer: parentId ? null : { creatorId: "alice" },
        currentChannelMeta: parentId ? { name: initialChannelId, parentChannelId: parentId, creatorId: "alice" } : null,
        isChildChannel: Boolean(parentId),
        isNotifyUnit: Boolean(parentId),
        currentUser: { id: "viewer" },
        accessAllowed,
        routeActive,
      })
      const targetUrl = parentId ? `/c/channels/s1/${parentId}` : "/c/channels/s1"
      return (
        <ChannelHeader
          channel={initialChannelId}
          kind={kind === "text" ? undefined : kind}
          rightPanel={null}
          onToggle={() => {}}
          tools={{ threads: false, pinned: false }}
          onLeave={vm.onLeaveChannel ? async () => {
            await vm.onLeaveChannel!()
            navigatedTo.push(targetUrl)
          } : undefined}
        />
      )
    }

    const user = setupUser()

    // 1. Private text channel: WS revocation arrives synchronously inside DELETE route BEFORE HTTP 204 returns, plus 500 error retry first!
    const textOwner = await createSeededOwner("priv-text", "text")
    broadcastHook = (uid, event) => {
      if (uid === "viewer" && event.relation === "access" && event.present === false) {
        setCanonicalCommunityChannelMember(textOwner.client, String(event.channelId), "viewer", "access", false, { event: true })
        retireCommunityChannelReading(textOwner.registry, String(event.channelId), { reason: "read-denied", serverId: "s1" })
        queueMicrotask(() => {
          ;((globalThis as Record<string, unknown>).__setRouteState as { setAccessAllowed: (v: boolean) => void }).setAccessAllowed(false)
        })
      }
    }

    const textView = render(
      <CommunityTestProvider client={textOwner.client}>
        <LiveSurface initialChannelId="priv-text" kind="text" />
      </CommunityTestProvider>,
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "More channel options" })).toBeVisible())
    await user.click(screen.getByRole("button", { name: "More channel options" }))
    await user.click(await screen.findByRole("menuitem", { name: "Leave" }))
    expect(await screen.findByText("Leave /priv-text?")).toBeVisible()

    // Simulate transient 500 failure first -> stays on current page, SQL row intact, dialog stays open & retryable
    failNextDelete = true
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    await waitFor(() => expect(toastApiErrorMock).toHaveBeenCalledOnce())
    expect(navigatedTo).toEqual([])
    expect(sqlite.prepare(`SELECT count(*) AS c FROM community_channel_member WHERE channel_id = 'priv-text' AND user_id = 'viewer'`).get()).toEqual({ c: 1 })
    await waitFor(() => expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled())

    // Retry -> real SQLite DELETE + WS-before-HTTP-204 -> retires cache and navigates to /c/channels/s1!
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    await waitFor(() => expect(navigatedTo).toEqual(["/c/channels/s1"]))
    expect(deleteStatuses).toContainEqual({ path: "/api/community/channels/priv-text/members/viewer", status: 204 })
    expect(sqlite.prepare(`SELECT count(*) AS c FROM community_channel_member WHERE channel_id = 'priv-text' AND user_id = 'viewer'`).get()).toEqual({ c: 0 })
    expect(textOwner.registry.collections.channels.has("priv-text")).toBe(false)
    expect(textOwner.registry.collections.channelMemberships.has(channelMembershipKey("priv-text", "viewer", "access"))).toBe(false)
    expect(textOwner.registry.runtime.ws.actions.isChannelAccessRevoked("priv-text", "s1")).toBe(true)
    textView.unmount()

    // 2. Private forum channel: HTTP 204 confirms first (no WS arrival before HTTP 204) -> onConfirmed retires reading & navigates to /c/channels/s1!
    broadcastHook = null
    const forumOwner = await createSeededOwner("priv-forum", "forum")
    const forumView = render(
      <CommunityTestProvider client={forumOwner.client}>
        <LiveSurface initialChannelId="priv-forum" kind="forum" />
      </CommunityTestProvider>,
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "More channel options" })).toBeVisible())
    await user.click(screen.getByRole("button", { name: "More channel options" }))
    await user.click(await screen.findByRole("menuitem", { name: "Leave" }))
    fireEvent.click(await screen.findByRole("button", { name: "Leave" }))
    await waitFor(() => expect(navigatedTo).toEqual(["/c/channels/s1", "/c/channels/s1"]))
    expect(deleteStatuses).toContainEqual({ path: "/api/community/channels/priv-forum/members/viewer", status: 204 })
    expect(sqlite.prepare(`SELECT count(*) AS c FROM community_channel_member WHERE channel_id = 'priv-forum' AND user_id = 'viewer'`).get()).toEqual({ c: 0 })
    expect(forumOwner.registry.collections.channels.has("priv-forum")).toBe(false)
    expect(forumOwner.registry.runtime.ws.actions.isChannelAccessRevoked("priv-forum", "s1")).toBe(true)
    forumView.unmount()

    // 3. Joined thread: DELETE /participants/viewer -> 204, SQLite notify row deleted, navigates to parent /c/channels/s1/pub-text!
    const threadOwner = await createSeededOwner("thread-1", "thread", "pub-text")
    const threadView = render(
      <CommunityTestProvider client={threadOwner.client}>
        <LiveSurface initialChannelId="thread-1" kind="thread" parentId="pub-text" />
      </CommunityTestProvider>,
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "More channel options" })).toBeVisible())
    await user.click(screen.getByRole("button", { name: "More channel options" }))
    await user.click(await screen.findByRole("menuitem", { name: "Leave" }))
    expect(await screen.findByText("You'll stop receiving notifications for new replies.")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    await waitFor(() => expect(navigatedTo).toEqual(["/c/channels/s1", "/c/channels/s1", "/c/channels/s1/pub-text"]))
    expect(deleteStatuses).toContainEqual({ path: "/api/community/channels/thread-1/participants/viewer", status: 204 })
    expect(sqlite.prepare(`SELECT count(*) AS c FROM community_channel_member WHERE channel_id = 'thread-1' AND user_id = 'viewer' AND relation = 'notify'`).get()).toEqual({ c: 0 })
    expect(threadOwner.registry.collections.channelMemberships.has(channelMembershipKey("thread-1", "viewer", "notify"))).toBe(false)
    threadView.unmount()

    // 4. User navigates away while DELETE is in flight: signal aborts in-flight DELETE immediately, rolls back optimistic state without fake 204 confirmation, suppresses error toast, and never navigates!
    const staleOwner = await createSeededOwner("priv-stale", "text")
    gateNextDelete = new Promise<void>(() => {})
    const staleView = render(
      <CommunityTestProvider client={staleOwner.client}>
        <LiveSurface initialChannelId="priv-stale" kind="text" />
      </CommunityTestProvider>,
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "More channel options" })).toBeVisible())
    await user.click(screen.getByRole("button", { name: "More channel options" }))
    await user.click(await screen.findByRole("menuitem", { name: "Leave" }))
    fireEvent.click(await screen.findByRole("button", { name: "Leave" }))
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/priv-stale/members/viewer",
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal), assertActive: expect.any(Function) }),
    ))
    expect(lastDeleteSignal?.aborted).toBe(false)
    await act(async () => {
      ;((globalThis as Record<string, unknown>).__setRouteState as { setRouteActive: (v: boolean) => void }).setRouteActive(false)
    })
    expect(lastDeleteSignal?.aborted).toBe(true)
    await waitFor(() => expect(staleOwner.registry.collections.channelMemberships.has(channelMembershipKey("priv-stale", "viewer", "access"))).toBe(true))
    expect(staleOwner.registry.collections.channels.has("priv-stale")).toBe(true)
    expect(staleOwner.registry.runtime.ws.actions.isChannelAccessRevoked("priv-stale", "s1")).toBe(false)
    expect(deleteStatuses).not.toContainEqual(expect.objectContaining({ path: "/api/community/channels/priv-stale/members/viewer" }))
    expect(toastApiErrorMock).toHaveBeenCalledTimes(1)
    expect(navigatedTo).toEqual(["/c/channels/s1", "/c/channels/s1", "/c/channels/s1/pub-text"])
    staleView.unmount()

    sqlite.close()
  })
})
