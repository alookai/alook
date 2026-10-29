/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, CommunityForumSidebarEnvelopeSchema, CommunityForumSidebarChannelSummarySchema, ClaimedTaskRowSchema, createDb, queries, schema } from "@alook/shared"
import { bindCacheKV, businessCacheKey, cacheKeys } from "@/lib/cache"
import { TaskPayloadBuilder } from "@/lib/services/task-payload-builder"
import { hydrateAttentionResources, readCommunityResourceBundle } from "@/lib/community/attention-resources.server"

const runtimeEnv = env as unknown as CloudflareEnv
const worker = (exports as unknown as {
  default: { fetch(request: Request): Promise<Response> }
}).default

describe("Web workerd runtime", () => {
  it("hydrates an actual unread DM projection into full current scoped resources", async () => {
    const db = createDb(runtimeEnv.DB)
    const sender = await queries.user.createUser(db, { name: "AttentionSender", email: `${crypto.randomUUID()}@runtime.test` })
    const viewer = await queries.user.createUser(db, { name: "AttentionViewer", email: `${crypto.randomUUID()}@runtime.test` })
    const dm = await queries.communityDm.createOrGetDM(db, { userId1: sender.id, userId2: viewer.id })
    const message = await queries.communityMessage.createMessage(db, { channelId: dm.id, authorId: sender.id, authorKind: "human", content: "Current unread resource", clientNonce: "private-sender-nonce" })
    const projection = await queries.communityAttention.getAccountAttentionProjection(db, viewer.id)
    const snapshot = await hydrateAttentionResources(db, viewer.id, projection)
    expect(snapshot.scopes.some(row => row.channelId === dm.id && row.ordinaryUnread)).toBe(true)
    expect(snapshot.resources.viewerId).toBe(viewer.id)
    expect(snapshot.resources.channels.find(row => row.id === dm.id)).toMatchObject({ type: "dm", serverId: null, categoryId: null, topic: "", messageCount: 1 })
    const actual = await readCommunityResourceBundle(db, viewer.id, { channelIds: [dm.id], messageIds: [message.id] })
    expect(actual.messages).toHaveLength(1)
    expect(actual.messages[0]).toMatchObject({ channelId: dm.id, id: message.id, replyToId: null, clientNonce: null, attachments: [] })
    const authorRead = await readCommunityResourceBundle(db, sender.id, { channelIds: [dm.id], messageIds: [message.id] })
    expect(authorRead.messages[0]).toMatchObject({ id: message.id, authorId: sender.id, clientNonce: "private-sender-nonce" })
    expect(actual.profiles.find(row => row.id === sender.id)).toMatchObject({ name: "AttentionSender", avatar: null, avatarVersion: 0 })
    expect(actual.memberships).toEqual([{ channelId: dm.id, userId: viewer.id, relation: "access", source: "added" }])
    expect(Object.keys(actual.messages[0])).not.toContain("resourceComplete")
  })

  it("rejects unauthorized resource scope before a faulted message D1 table is opened", async () => {
    const db = createDb(runtimeEnv.DB)
    const [sender, peer, stranger] = await Promise.all(["Sender", "Peer", "Stranger"].map(name => queries.user.createUser(db, { name, email: `${crypto.randomUUID()}@runtime.test` })))
    const dm = await queries.communityDm.createOrGetDM(db, { userId1: sender.id, userId2: peer.id })
    await runtimeEnv.DB.prepare("ALTER TABLE community_message RENAME TO community_message_resource_unavailable").run()
    try {
      await expect(readCommunityResourceBundle(db, stranger.id, { channelIds: [dm.id], messageIds: ["missing"] })).rejects.toThrow("Attention access changed")
      const failure = await readCommunityResourceBundle(db, peer.id, { channelIds: [dm.id], messageIds: ["missing"] }).then(
        () => { throw new Error("Expected message-table failure") },
        error => error as unknown,
      )
      const causes: string[] = []
      const seen = new Set<unknown>()
      for (let cause: unknown = failure; cause && typeof cause === "object" && !seen.has(cause);) {
        seen.add(cause)
        if ("message" in cause && typeof cause.message === "string") causes.push(cause.message)
        cause = "cause" in cause ? cause.cause : undefined
      }
      expect(causes.join("\n")).toContain("no such table: community_message")
    } finally {
      await runtimeEnv.DB.prepare("ALTER TABLE community_message_resource_unavailable RENAME TO community_message").run()
    }
    await expect(readCommunityResourceBundle(db, peer.id, { channelIds: [dm.id], messageIds: ["missing"] })).rejects.toThrow("Requested message resource missing from scope")
  })

  it("closes actual Forum sidebar references over full D1 resources and notify membership", async () => {
    const db = createDb(runtimeEnv.DB)
    const viewer = await queries.user.createUser(db, { name: "ForumViewer", email: `${crypto.randomUUID()}@runtime.test` })
    const { server, ownerMember } = await queries.communityServer.createServer(db, { name: "Current Forum", ownerId: viewer.id })
    const forum = await queries.communityChannel.createChannel(db, { serverId: server.id, name: "Forum", type: "forum", creatorId: viewer.id })
    const threadId = crypto.randomUUID()
    const opener = await queries.communityMessage.createMessage(db, { channelId: forum.id, authorId: viewer.id, authorKind: "human", content: "Full opener",
      forumThread: { id: threadId, serverId: server.id, name: "Current post" } })
    const now = Date.now()
    const projection = await queries.communityThread.listParticipatingForumThreads(db, { parentChannelIds: [forum.id], userId: viewer.id, activeAfter: new Date(now - 72 * 60 * 60 * 1000).toISOString(), limitPerParent: 5 })
    expect(projection.canonical.map(row => row.id)).toEqual([threadId])
    const resources = await readCommunityResourceBundle(db, viewer.id, { channelIds: [forum.id, threadId], messageIds: [opener.id], serverIds: [server.id] })
    const canonicalChannels = projection.canonical.map(row => CommunityForumSidebarChannelSummarySchema.strip().parse({ ...row, unread: false, expiresAt: new Date(Date.parse(row.activityAt) + 72 * 60 * 60 * 1000).toISOString() }))
    const value = { schemaVersion: BUSINESS_SCHEMA_VERSION, serverId: server.id, channels: canonicalChannels, canonicalChannels,
      retainedChannel: null, retainedDisposition: null, resources, serverNow: new Date(now).toISOString() }
    expect(CommunityForumSidebarEnvelopeSchema.parse(value)).toEqual(value)
    expect(resources.serverMemberships).toEqual([{ serverId: server.id, userId: viewer.id, memberId: ownerMember.id, role: "owner" }])
    expect(resources.memberships).toContainEqual({ channelId: threadId, userId: viewer.id, relation: "notify", source: "spoke" })
    expect(resources.messages[0]).toMatchObject({ id: opener.id, channelId: forum.id, attachments: [], replyToId: null })
    for (const broken of [
      { ...value, schemaVersion: BUSINESS_SCHEMA_VERSION - 1 },
      { ...value, resources: { ...resources, messages: [] } },
      { ...value, resources: { ...resources, memberships: resources.memberships.filter(row => row.relation !== "notify") } },
    ]) expect(CommunityForumSidebarEnvelopeSchema.safeParse(broken).success).toBe(false)
  })

  it.each(["hit", "wrong-version", "bad-json", "missing-field", "wrong-scope", "wrong-value-identity", "unversioned"])(
    "uses actual TaskPayloadBuilder D1/KV inputs for a %s cache value",
    async mode => {
      const db = createDb(runtimeEnv.DB)
      bindCacheKV(runtimeEnv.CACHE_KV)
      const owner = await queries.user.createUser(db, { name: "D1 Owner", email: `${crypto.randomUUID()}@runtime.test` })
      const [workspace] = await db.insert(schema.workspace).values({ name: "Runtime workspace", slug: crypto.randomUUID() }).returning()
      const [runtime] = await db.insert(schema.agentRuntime).values({ workspaceId: workspace.id, daemonId: crypto.randomUUID(), provider: "codex" }).returning()
      await queries.member.createMember(db, { workspaceId: workspace.id, userId: owner.id, role: "owner" })
      await queries.member.updateMemberGlobalInstruction(db, owner.id, workspace.id, "D1 instructions")
      const agent = await queries.agent.createAgent(db, { workspaceId: workspace.id, name: "Runtime agent", ownerId: owner.id, runtimeId: runtime.id })
      const conversation = await queries.conversation.createConversation(db, { workspaceId: workspace.id, agentId: agent.id, userId: owner.id, title: "Runtime conversation" })
      const row = await queries.task.createTask(db, { workspaceId: workspace.id, agentId: agent.id, runtimeId: runtime.id, conversationId: conversation.id, prompt: "Runtime cache check" })
      await queries.emailAccount.createEmailAccount(db, {
        workspaceId: workspace.id, agentId: agent.id, emailAddress: "d1@runtime.test",
        imapHost: "imap.runtime.test", imapUsername: "fixture", imapPassword: "fixture-unused",
        smtpHost: "smtp.runtime.test", smtpUsername: "fixture", smtpPassword: "fixture-unused",
      })
      const values = [
        [cacheKeys.allEmailAccounts(workspace.id), [{ workspaceId: workspace.id, agentId: agent.id, emailAddress: "cached@runtime.test" }]],
        [cacheKeys.member(workspace.id, owner.id), { workspaceId: workspace.id, userId: owner.id, globalInstruction: "Cached instructions" }],
        [cacheKeys.user(owner.id), { id: owner.id, name: "Cached Owner", email: owner.email }],
      ] as const
      for (const [key, value] of values) {
        let cacheKey: string = key
        let payload: unknown = value
        if (mode === "missing-field") payload = Array.isArray(value) ? [{}] : {}
        if (mode === "wrong-scope") cacheKey = `other:${key}`
        if (mode === "wrong-value-identity") {
          if (Array.isArray(value)) payload = value.map(row => ({ ...row, workspaceId: "other-workspace" }))
          else if ("userId" in value) payload = { ...value, userId: "other-user", workspaceId: "other-workspace" }
          else payload = { ...value, id: "other-user" }
        }
        const body = mode === "unversioned" ? payload : {
          schemaVersion: mode === "wrong-version" ? BUSINESS_SCHEMA_VERSION - 1 : BUSINESS_SCHEMA_VERSION,
          cacheKey, value: payload,
        }
        await runtimeEnv.CACHE_KV.put(businessCacheKey(key), mode === "bad-json" ? "not-json" : JSON.stringify(body))
      }
      try {
        const [payload] = await new TaskPayloadBuilder(db).buildFullPayloads([ClaimedTaskRowSchema.parse(row)], workspace.id)
        expect(payload.agent?.user_name).toBe(mode === "hit" ? "Cached Owner" : "D1 Owner")
        expect(payload.agent?.instructions).toBe(mode === "hit" ? "Cached instructions" : "D1 instructions")
        expect(payload.agent?.email_addresses).toEqual([mode === "hit" ? "cached@runtime.test" : "d1@runtime.test"])
        expect(payload.sender?.name).toBe(mode === "hit" ? "Cached Owner" : "D1 Owner")
        for (const [key] of values) {
          const saved = JSON.parse((await runtimeEnv.CACHE_KV.get(businessCacheKey(key)))!)
          expect(saved).toMatchObject({ schemaVersion: BUSINESS_SCHEMA_VERSION, cacheKey: key })
          expect(Object.keys(saved).sort()).toEqual(["cacheKey", "schemaVersion", "value"])
          expect(JSON.stringify(saved.value)).not.toContain("fixture-unused")
        }
      } finally {
        await Promise.all(values.map(([key]) => runtimeEnv.CACHE_KV.delete(businessCacheKey(key))))
        bindCacheKV(null)
      }
    },
  )

  it("loads production migrations and local storage bindings", async () => {
    const schema = await runtimeEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).bind("community_machine").first<{ name: string }>()
    expect(schema?.name).toBe("community_machine")

    const r2Key = `runtime/${crypto.randomUUID()}`
    await runtimeEnv.COMMUNITY_MEDIA.put(r2Key, "runtime media")
    await expect((await runtimeEnv.COMMUNITY_MEDIA.get(r2Key))!.text()).resolves.toBe("runtime media")
    await runtimeEnv.COMMUNITY_MEDIA.delete(r2Key)

    const kvKey = `runtime:${crypto.randomUUID()}`
    await runtimeEnv.CACHE_KV.put(kvKey, "runtime cache")
    await expect(runtimeEnv.CACHE_KV.get(kvKey)).resolves.toBe("runtime cache")
    await runtimeEnv.CACHE_KV.delete(kvKey)
  })

  it.each(["/", "/pricing", "/privacy", "/templates", "/templates/example"])(
    "adds browser and CDN revalidation headers to public route %s",
    async (pathname) => {
      const publicResponse = await worker.fetch(new Request(`https://worker.test${pathname}`))
      expect(await publicResponse.text()).toBe(`open-next:${pathname}`)
      expect(publicResponse.headers.get("x-open-next")).toBe("test-entry")
      expect(publicResponse.headers.get("Cache-Control")).toBe(
        "public, max-age=0, must-revalidate",
      )
      expect(publicResponse.headers.get("CDN-Cache-Control")).toBe(
        "public, s-maxage=3600, stale-while-revalidate=86400",
      )
    },
  )

  it.each(["/w/one", "/workspaces", "/dashboard/one", "/invite/one", "/api/one", "/_next/one", "/c", "/c/me", "/c/channels/s1/c1", "/c/invite/token", "/sign-in", "/device", "/auth/native/start", "/apiary", "/unknown"])(
    "does not add public cache headers to private route %s",
    async (pathname) => {
      const privateResponse = await worker.fetch(new Request(`https://worker.test${pathname}`))
      expect(await privateResponse.text()).toBe(`open-next:${pathname}`)
      expect(privateResponse.headers.get("Cache-Control")).toBeNull()
      expect(privateResponse.headers.get("CDN-Cache-Control")).toBeNull()
    },
  )

  it("returns a non-200 public response unchanged", async () => {
    const response = await worker.fetch(new Request("https://worker.test/missing"))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("open-next:/missing")
    expect(response.headers.get("Cache-Control")).toBeNull()
    expect(response.headers.get("CDN-Cache-Control")).toBeNull()
  })

  it.each(["/api/ws", "/api/ws/socket"])(
    "forwards WebSocket upgrade %s through the configured service binding",
    async (pathname) => {
      const response = await worker.fetch(new Request(`https://worker.test${pathname}`, {
        headers: { Upgrade: "websocket" },
      }))

      expect(response.status).toBe(101)
      expect(response.headers.get("x-runtime-pathname")).toBe(pathname)
      expect(response.headers.get("x-runtime-upgrade")).toBe("websocket")
      expect(response.webSocket).not.toBeNull()
      const client = response.webSocket!
      client.accept()
      const closed = new Promise<CloseEvent>((resolve) => {
        client.addEventListener("close", resolve, { once: true })
      })
      client.close(1000, "runtime test complete")
      await expect(closed).resolves.toMatchObject({
        code: 1000,
        reason: "runtime test complete",
        wasClean: true,
      })
    },
  )

  it.each([
    ["plain token request", "/api/ws/token", undefined],
    ["upgrade outside the ws route", "/socket", { Upgrade: "websocket" }],
  ])("keeps %s in the OpenNext path", async (_name, pathname, headers) => {
    const response = await worker.fetch(new Request(`https://worker.test${pathname}`, { headers }))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(`open-next:${pathname}`)
    expect(response.headers.get("x-open-next")).toBe("test-entry")
  })

  it("exposes the production asset and Durable Object bindings locally", async () => {
    const asset = await runtimeEnv.ASSETS.fetch(new Request("https://assets.test/fixture.txt"))
    expect(asset.status).toBe(200)
    expect((await asset.text()).trim()).toBe("workerd asset fixture")

    const id = runtimeEnv.NEXT_CACHE_DO_QUEUE.idFromName(`runtime-${crypto.randomUUID()}`)
    const stub = runtimeEnv.NEXT_CACHE_DO_QUEUE.get(id)
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("runtime", "durable")
      await expect(state.storage.get("runtime")).resolves.toBe("durable")
    })
  })
})
