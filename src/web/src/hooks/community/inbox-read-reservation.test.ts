import { serverDirectoryFixture, messageResourceFixture, channelResourceFixture, resourceBundleFixture } from "@/test/community-resource-fixtures"
import { QueryClient } from "@tanstack/react-query"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getCommunityDbRegistry, createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestServerDetail, ingestMessages, ingestAttentionSnapshot, captureCommunityLiveSnapshotToken, publishCommunityChannelFields, publishCommunityChannelMetadata } from "@/lib/community-db/sync"
import { activateInboxProjectionTicket, armInboxReadReservationCandidate, armThreadOpenerReservationHandoff, clearThreadOpenerReservationHandoff, completeThreadOpenerReservationHandoff, getThreadOpenerReservationHandoff, inboxChannelRowTarget, inboxDmRowTarget, inboxReadCandidateFingerprint, inboxThreadRowTarget, publishInboxProjectionGenerationTerminal, promoteInboxReadReservation, registerInboxProjectionTicket, registerThreadOpenerRouteLease, registerInboxReadReservationSurface, releaseThreadOpenerRouteLease, releaseInboxReadReservationSurface, cancelInboxProjectionTicket, settleInboxReadReservationGeneration, takeInboxReadReservationNegative, terminateThreadOpenerReservationHandoff, type InboxRowTarget } from "./inbox-read-reservation"

function client() {
  const value = createOwnedClient()
  return Object.assign(value, { cancelQueries: vi.spyOn(value, "cancelQueries"), invalidateQueries: vi.spyOn(value, "invalidateQueries") })
}

const ownedClients = new Set<QueryClient>()
function createOwnedClient() {
  const client = new QueryClient()
  registerCommunityDbRegistry(createCommunityDbRegistry(client, "user-1"))
  ownedClients.add(client)
  return client
}
afterEach(async () => {
  for (const client of ownedClients) { await getCommunityDbRegistry(client)?.cleanup(); client.clear() }
  ownedClients.clear()
})

async function seedProjection(queryClient: QueryClient, data: {
  servers: Array<{ serverId?: string; channels: Array<{ channelId: string; lastMessageAt: string; children?: Array<{ channelId: string; lastMessageAt: string; openerMessageId?: string; openerSeq?: number; openerUnread?: boolean }> }> }>
  dms: Array<{ channelId: string; lastMessageAt: string }>
}) {
  const registry = getCommunityDbRegistry(queryClient)!
  await registry.preload()
  const scopes: Array<{ scopeId: string; channelId: string; serverId: string; parentChannelId: string | null; ordinaryUnread: boolean; lastUnreadSeq: number; lastAttentionSeq: number | null; attentionCount: number }> = []
  const items: Array<{ id: string; kind: "forum_post"; sourceId: string; scopeId: string; childChannelId: string; messageId: string; openerSeq: number; readTarget: { channelId: string; seq: number }; createdAt: string }> = []
  for (const server of data.servers) {
    const serverId = server.serverId ?? "server"
    const channels = server.channels.flatMap((parent) => {
      scopes.push({ scopeId: parent.channelId, channelId: parent.channelId, serverId, parentChannelId: null, ordinaryUnread: true, lastUnreadSeq: 7, lastAttentionSeq: null, attentionCount: 0 })
      for (const child of parent.children ?? []) if (child.openerUnread && child.openerMessageId && child.openerSeq !== undefined) {
        ingestMessages(registry, parent.channelId, [messageResourceFixture({ id: child.openerMessageId, channelId: parent.channelId, authorId: "user-1", type: "chat", seq: child.openerSeq, createdAt: child.lastMessageAt })])
        items.push({ id: "forum:" + child.channelId, kind: "forum_post", sourceId: child.channelId, scopeId: parent.channelId, childChannelId: child.channelId, messageId: child.openerMessageId, openerSeq: child.openerSeq, readTarget: { channelId: parent.channelId, seq: child.openerSeq }, createdAt: child.lastMessageAt })
      }
      return [{ id: parent.channelId, name: parent.channelId, type: parent.children?.length ? "forum" as const : "text" as const, active: false, unread: true, lastMessageAt: parent.lastMessageAt }, ...(parent.children ?? []).map((child) => ({ id: child.channelId, name: child.channelId, type: "thread" as const, active: false, unread: true, lastMessageAt: child.lastMessageAt, parentChannelId: parent.channelId, parentMessageId: child.openerMessageId }))]
    })
    ingestServerDetail(registry, serverDirectoryFixture({ id: serverId, name: serverId, discriminator: "0001", description: "", icon: null, ownerId: "user-1", categories: [{ id: "category:" + serverId, name: "Category", channels: channels.filter(channel => !channel.parentChannelId) }] }))
    for (const channel of channels.filter(channel => channel.parentChannelId)) await publishCommunityChannelMetadata(queryClient, { metadata: channelResourceFixture({ id: channel.id, serverId, name: channel.name, type: "thread", parentChannelId: channel.parentChannelId, parentMessageId: channel.parentMessageId, lastMessageAt: channel.lastMessageAt }), proof: { token: captureCommunityLiveSnapshotToken(queryClient) } })
    for (const channel of channels) publishCommunityChannelFields(queryClient, channel.id, { lastMessageAt: channel.lastMessageAt }, { token: captureCommunityLiveSnapshotToken(queryClient) })
  }
  ingestAttentionSnapshot(registry, { resources: resourceBundleFixture({ viewerId: "user-1" }), scopes, items, limit: 100, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } })
}

function response(channelId = "focused", lastMessageAt = "2026-08-27T01:00:00.000Z") {
  return {
    servers: [{
      serverId: "server",
      channels: [{
        channelId,
        lastMessageAt,
        hasDirectUnread: true,
        children: [],
      }],
    }],
    dms: [{ channelId: "background-dm", lastMessageAt: "2026-08-27T02:00:00.000Z" }],
  }
}

describe("inbox read reservation", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = client()
  })

  it("carries the exact unread sequence boundary on reservable row targets", () => {
    const server = {
      serverId: "server",
      serverName: "Server",
      channels: [{
        channelId: "forum",
        channelName: "Forum",
        lastMessageAt: "2026-09-02T00:00:00.000Z",
        lastUnreadSeq: 4,
        hasDirectUnread: true,
        mentionCount: 0,
        children: [{
          channelId: "child",
          channelName: "Child",
          lastMessageAt: "2026-09-02T00:00:00.000Z",
          lastUnreadSeq: 7,
          mentionCount: 0,
        }],
      }],
    }
    const dm = {
      channelId: "dm",
      otherUserId: "peer",
      otherUserName: "Peer",
      otherUserDiscriminator: "0001",
      otherUserAvatar: "P",
      otherUserAvatarVersion: 0,
      lastMessageAt: "2026-09-02T00:00:00.000Z",
      lastUnreadSeq: 9,
    }

    expect(inboxChannelRowTarget(server, server.channels[0]!))
      .toMatchObject({ reservedThroughSeq: 4 })
    expect(inboxThreadRowTarget(
      server,
      server.channels[0]!,
      server.channels[0]!.children[0]!,
    )).toMatchObject({ reservedThroughSeq: 7 })
    expect(inboxDmRowTarget(dm)).toMatchObject({ reservedThroughSeq: 9 })
  })

  it("clears a committed-response discard when its route lease releases", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    promoteInboxReadReservation(lease, 16)
    await settleInboxReadReservationGeneration(queryClient, 16, true, "focused")

    releaseInboxReadReservationSurface(lease)

    await Promise.resolve()
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled()
  })

  it("clears as a no-op when no handoff is active", () => {
    expect(clearThreadOpenerReservationHandoff(queryClient)).toBe(false)
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled()
  })

  it("keeps a pending nonce across same-identity effect replay and terminates a true release once", async () => {
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-route",
      serverId: "server",
      parentChannelId: "parent",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    const first = registerThreadOpenerRouteLease(queryClient, "nonce-route", "server", "child")
    releaseThreadOpenerRouteLease(first)
    const replacement = registerThreadOpenerRouteLease(queryClient, "nonce-route", "server", "child")
    await Promise.resolve()
    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-route")).not.toBeNull()
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled()

    releaseThreadOpenerRouteLease(replacement)
    await Promise.resolve()
    await Promise.resolve()
    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-route")).toBeNull()
    await vi.waitFor(() => expect(queryClient.invalidateQueries).toHaveBeenCalledOnce())
  })

  it("keeps projection tickets dormant and emits success only for their bound generation", async () => {
    const data = {
      servers: [{
        serverId: "server",
        serverName: "Server",
        channels: [{
          channelId: "focused",
          channelName: "Focused",
          lastMessageAt: "2026-08-27T01:00:00.000Z",
          mentionCount: 0,
          hasDirectUnread: true,
          children: [],
        }],
      }],
      dms: [],
    }
    queryClient = client()
    await seedProjection(queryClient, data)
    const target: InboxRowTarget = {
      kind: "channel-direct",
      identity: JSON.stringify(["channel-direct", "server", "focused"]),
      fingerprint: inboxReadCandidateFingerprint({
        channelId: "focused",
        lastMessageAt: "2026-08-27T01:00:00.000Z",
        openerUnread: false,
      }),
      confirmationChannelId: "focused",
      serverId: "server",
      channelId: "focused",
    }
    const receipt = vi.fn()
    const ticket = registerInboxProjectionTicket(queryClient, 4, target, receipt)
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
    promoteInboxReadReservation(lease, 41)

    publishInboxProjectionGenerationTerminal(queryClient, 99, "success")
    expect(receipt).not.toHaveBeenCalled()
    activateInboxProjectionTicket(ticket)
    expect(receipt).not.toHaveBeenCalled()

    await settleInboxReadReservationGeneration(queryClient, 41, true, "focused")
    await seedProjection(queryClient, { servers: [], dms: [] })
    publishInboxProjectionGenerationTerminal(queryClient, 41, "success")
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      epoch: 4,
      terminal: "success",
      disposition: "retire",
      observedFingerprint: null,
    })))
  })

  it("freezes exact retention as rollback after an owned negative refetch", async () => {
    const data = response()
    queryClient = client()
    await seedProjection(queryClient, data)
    const target: InboxRowTarget = {
      kind: "channel-direct",
      identity: JSON.stringify(["channel-direct", "server", "focused"]),
      fingerprint: inboxReadCandidateFingerprint({
        channelId: "focused",
        lastMessageAt: "2026-08-27T01:00:00.000Z",
        openerUnread: false,
      }),
      confirmationChannelId: "focused",
      serverId: "server",
      channelId: "focused",
    }
    const receipt = vi.fn()
    activateInboxProjectionTicket(registerInboxProjectionTicket(
      queryClient,
      5,
      target,
      receipt,
    ))
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
    promoteInboxReadReservation(lease, 51)

    await settleInboxReadReservationGeneration(queryClient, 51, false, "focused")
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "negative",
      disposition: "rollback",
      observedFingerprint: target.fingerprint,
    })))
  })

  it("forces Mention-negative and deferred terminals to rollback without cache authority", async () => {
    queryClient = client()
    const mentionTarget: InboxRowTarget = {
      kind: "mention",
      identity: JSON.stringify(["mention", "mention-1"]),
      fingerprint: JSON.stringify(["mention-1", "message-1", 7]),
      confirmationChannelId: "focused",
      mentionId: "mention-1",
    }
    const negativeReceipt = vi.fn()
    activateInboxProjectionTicket(registerInboxProjectionTicket(
      queryClient,
      6,
      mentionTarget,
      negativeReceipt,
    ))
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
    promoteInboxReadReservation(lease, 61)
    await settleInboxReadReservationGeneration(queryClient, 61, false, "focused")
    await vi.waitFor(() => expect(negativeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "rollback",
      observedFingerprint: null,
    })))

    const deferredReceipt = vi.fn()
    const ticket = registerInboxProjectionTicket(
      queryClient,
      7,
      mentionTarget,
      deferredReceipt,
    )
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T03:00:00.000Z",
    })
    promoteInboxReadReservation(lease, 62)
    activateInboxProjectionTicket(ticket)
    publishInboxProjectionGenerationTerminal(queryClient, 62, "deferred")
    await vi.waitFor(() => expect(deferredReceipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "deferred",
      disposition: "rollback",
    })))
  })

  it("binds an exact child target to its opener-owned parent generation", async () => {
    const data = {
      servers: [{
        serverId: "server",
        channels: [{
          channelId: "forum",
          lastMessageAt: "2026-08-27T01:00:00.000Z",
          children: [{
            channelId: "child",
            lastMessageAt: "2026-08-27T01:00:00.000Z",
            openerMessageId: "opener-7",
            openerSeq: 7,
            openerUnread: true,
          }],
        }],
      }],
      dms: [],
    }
    queryClient = client()
    await seedProjection(queryClient, data)
    const target: InboxRowTarget = {
      kind: "thread",
      identity: JSON.stringify(["thread", "server", "forum", "child"]),
      fingerprint: inboxReadCandidateFingerprint({
        channelId: "child",
        lastMessageAt: "2026-08-27T01:00:00.000Z",
        openerMessageId: "opener-7",
        openerSeq: 7,
        openerUnread: true,
      }),
      confirmationChannelId: "forum",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
    }
    const receipt = vi.fn()
    activateInboxProjectionTicket(registerInboxProjectionTicket(
      queryClient,
      8,
      target,
      receipt,
    ))
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "projection-thread",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    completeThreadOpenerReservationHandoff(queryClient, "projection-thread", 81)
    await settleInboxReadReservationGeneration(queryClient, 81, true, "forum")
    await seedProjection(queryClient, { servers: [], dms: [] })
    publishInboxProjectionGenerationTerminal(queryClient, 81, "success")

    await vi.waitFor(() => expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "success",
      disposition: "retire",
    })))
  })

  it("attaches an activated same-href ticket to a just-settled exact generation", async () => {
    const data = response()
    queryClient = client()
    await seedProjection(queryClient, { servers: [], dms: [] })
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
    promoteInboxReadReservation(lease, 91)
    await settleInboxReadReservationGeneration(queryClient, 91, true, "focused")
    publishInboxProjectionGenerationTerminal(queryClient, 91, "success")

    const target: InboxRowTarget = {
      kind: "channel-direct",
      identity: JSON.stringify(["channel-direct", "server", "focused"]),
      fingerprint: inboxReadCandidateFingerprint({
        channelId: "focused",
        lastMessageAt: "2026-08-27T01:00:00.000Z",
        openerUnread: false,
      }),
      confirmationChannelId: "focused",
      serverId: "server",
      channelId: "focused",
    }
    const receipt = vi.fn()
    const ticket = registerInboxProjectionTicket(queryClient, 9, target, receipt)
    expect(receipt).not.toHaveBeenCalled()
    activateInboxProjectionTicket(ticket)
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "success",
      disposition: "retire",
    })))
  })
  function directTarget(lastMessageAt = "2026-08-27T01:00:00.000Z"): InboxRowTarget {
    return { kind: "channel-direct", identity: "focused", fingerprint: inboxReadCandidateFingerprint({ channelId: "focused", lastMessageAt, openerUnread: false }), confirmationChannelId: "focused", serverId: "server", channelId: "focused" }
  }
  const handoff = (nonce: string) => ({ nonce, serverId: "server", parentChannelId: "forum", childChannelId: "child", openerMessageId: "opener-7", openerSeq: 7 })
  function threadTarget(): InboxRowTarget {
    return { kind: "thread", identity: "child", fingerprint: inboxReadCandidateFingerprint({ channelId: "child", lastMessageAt: "2026-08-27T01:00:00.000Z", openerMessageId: "opener-7", openerSeq: 7, openerUnread: true }), confirmationChannelId: "forum", serverId: "server", parentChannelId: "forum", childChannelId: "child" }
  }

  it("admits only the current focused lease and deduplicates a sparse replay", () => {
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(queryClient, "focused", seen)
    expect(armInboxReadReservationCandidate(queryClient, { channelId: "background", lastMessageAt: "1" })).toBe(false)
    expect(armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "1", openerMessageId: "a", openerSeq: 1 })).toBe(true)
    expect(armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "1" })).toBe(false)
    expect(armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "1", openerMessageId: "b", openerSeq: 2 })).toBe(true)
    expect(seen).toHaveBeenCalledTimes(2)
    releaseInboxReadReservationSurface(lease)
    expect(armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2" })).toBe(false)
    expect(takeInboxReadReservationNegative(lease)).toBe(false)
  })

  it("does not clear a newer focus while an older committed settlement yields", async () => {
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(queryClient, "focused", seen)
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "old" })
    promoteInboxReadReservation(lease, 101)
    const settled = settleInboxReadReservationGeneration(queryClient, 101, true, "focused")
    const receipt = vi.fn()
    activateInboxProjectionTicket(registerInboxProjectionTicket(queryClient, 16, directTarget("new"), receipt))
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "new" })
    await settled
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ lastMessageAt: "new" }))
    expect(promoteInboxReadReservation(lease, 102)).toBe(true)
    publishInboxProjectionGenerationTerminal(queryClient, 102, "success")
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ terminal: "success" })))
  })

  it.each(["replacement", "generation"] as const)("fences a delayed focused negative after %s changes", async (change) => {
    let finish!: () => void
    vi.mocked(queryClient.invalidateQueries).mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const receipt = vi.fn(), replacementReceipt = vi.fn()
    const ticket = registerInboxProjectionTicket(queryClient, 10, directTarget(), receipt)
    activateInboxProjectionTicket(ticket)
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
    takeInboxReadReservationNegative(lease)
    if (change === "replacement") {
      cancelInboxProjectionTicket(ticket)
      activateInboxProjectionTicket(registerInboxProjectionTicket(queryClient, 11, directTarget(), replacementReceipt))
    } else {
      armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
      promoteInboxReadReservation(lease, 103)
    }
    await vi.waitFor(() => expect(queryClient.invalidateQueries).toHaveBeenCalledOnce())
    finish()
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(receipt).not.toHaveBeenCalled()
    expect(replacementReceipt).not.toHaveBeenCalled()
    if (change === "generation") {
      publishInboxProjectionGenerationTerminal(queryClient, 103, "success")
      await vi.waitFor(() => expect(receipt).toHaveBeenCalledOnce())
      expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ terminal: "success" }))
    }
  })

  it("replays a dormant negative once on activation", async () => {
    const receipt = vi.fn()
    const ticket = registerInboxProjectionTicket(queryClient, 12, directTarget(), receipt)
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
    takeInboxReadReservationNegative(lease)
    await vi.waitFor(() => expect(queryClient.invalidateQueries).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(receipt).not.toHaveBeenCalled()
    activateInboxProjectionTicket(ticket)
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledOnce())
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ terminal: "negative" }))
    expect(activateInboxProjectionTicket(ticket)).toBe(false)
    expect(receipt).toHaveBeenCalledOnce()
  })

  it("drops a stored dormant terminal when the same token binds a new generation", async () => {
    const receipt = vi.fn()
    const ticket = registerInboxProjectionTicket(queryClient, 13, directTarget(), receipt)
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
    takeInboxReadReservationNegative(lease)
    await vi.waitFor(() => expect(queryClient.invalidateQueries).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    armInboxReadReservationCandidate(queryClient, { channelId: "focused", lastMessageAt: "2026-08-27T01:00:00.000Z" })
    promoteInboxReadReservation(lease, 104)
    activateInboxProjectionTicket(ticket)
    await Promise.resolve()
    expect(receipt).not.toHaveBeenCalled()
    publishInboxProjectionGenerationTerminal(queryClient, 104, "success")
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ terminal: "success" })))
  })

  it("does not terminate a new same-thread ticket created before the old handoff clears", async () => {
    let finish!: () => void
    vi.mocked(queryClient.invalidateQueries).mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const oldReceipt = vi.fn(), newReceipt = vi.fn()
    const oldTicket = registerInboxProjectionTicket(queryClient, 14, threadTarget(), oldReceipt)
    activateInboxProjectionTicket(oldTicket)
    armThreadOpenerReservationHandoff(queryClient, handoff("old-nonce"))
    cancelInboxProjectionTicket(oldTicket)
    const next = registerInboxProjectionTicket(queryClient, 15, threadTarget(), newReceipt)
    activateInboxProjectionTicket(next)
    expect(terminateThreadOpenerReservationHandoff(queryClient, "old-nonce")).toBe(true)
    armThreadOpenerReservationHandoff(queryClient, handoff("new-nonce"))
    expect(completeThreadOpenerReservationHandoff(queryClient, "old-nonce", 105)).toBe(false)
    await vi.waitFor(() => expect(queryClient.invalidateQueries).toHaveBeenCalledOnce())
    finish()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(oldReceipt).not.toHaveBeenCalled()
    expect(newReceipt).not.toHaveBeenCalled()
    expect(completeThreadOpenerReservationHandoff(queryClient, "new-nonce", 106)).toBe(true)
    publishInboxProjectionGenerationTerminal(queryClient, 106, "success")
    await vi.waitFor(() => expect(newReceipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ terminal: "success" })))
  })

  it("clears a stored terminal when an owned handoff binds the same dormant ticket again", async () => {
    const receipt = vi.fn()
    const ticket = registerInboxProjectionTicket(queryClient, 17, threadTarget(), receipt)
    armThreadOpenerReservationHandoff(queryClient, handoff("first"))
    expect(completeThreadOpenerReservationHandoff(queryClient, "first", 107)).toBe(true)
    publishInboxProjectionGenerationTerminal(queryClient, 107, "error")
    armThreadOpenerReservationHandoff(queryClient, handoff("second"))
    expect(completeThreadOpenerReservationHandoff(queryClient, "second", 108)).toBe(true)
    activateInboxProjectionTicket(ticket)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(receipt).not.toHaveBeenCalled()
    publishInboxProjectionGenerationTerminal(queryClient, 108, "success")
    await vi.waitFor(() => expect(receipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ terminal: "success" })))
  })

})
