import type { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  activateInboxProjectionTicket,
  armInboxReadReservationCandidate,
  armThreadOpenerReservationHandoff,
  clearThreadOpenerReservationHandoff,
  completeThreadOpenerReservationHandoff,
  disposeInboxReadReservation,
  getThreadOpenerReservationHandoff,
  inboxChannelRowTarget,
  inboxDmRowTarget,
  inboxReadCandidateFingerprint,
  inboxThreadRowTarget,
  publishInboxProjectionGenerationTerminal,
  promoteInboxReadReservation,
  registerInboxProjectionTicket,
  registerThreadOpenerRouteLease,
  registerInboxReadReservationSurface,
  releaseThreadOpenerRouteLease,
  releaseInboxReadReservationSurface,
  reserveInboxUnreadsResponse,
  settleInboxReadReservationGeneration,
  takeInboxReadReservationNegative,
  terminateThreadOpenerReservationHandoff,
  type InboxRowTarget,
} from "./inbox-read-reservation"

function client() {
  return {
    cancelQueries: vi.fn().mockResolvedValue(undefined),
    refetchQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryClient
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

function openerResponse() {
  return {
    servers: [{
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

  it("passes unrelated responses through and holds a focused response unchanged", async () => {
    const seen = vi.fn()
    registerInboxReadReservationSurface(queryClient, "focused", seen)
    const unrelated = response("other")
    await expect(reserveInboxUnreadsResponse(queryClient, unrelated)).resolves.toBe(unrelated)

    seen.mockClear()
    const focused = response()
    const pending = reserveInboxUnreadsResponse(queryClient, focused)
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    }))
    disposeInboxReadReservation(queryClient)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("classifies and fingerprints a focused DM response", async () => {
    const seen = vi.fn()
    registerInboxReadReservationSurface(queryClient, "background-dm", seen)
    const pending = reserveInboxUnreadsResponse(queryClient, response())
    void pending.catch(() => undefined)

    expect(seen).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "background-dm",
      lastMessageAt: "2026-08-27T02:00:00.000Z",
      openerUnread: false,
      fingerprint: expect.stringContaining("background-dm"),
    }))
    disposeInboxReadReservation(queryClient)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("promotes the held epoch to the exact committed generation", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    const pending = reserveInboxUnreadsResponse(queryClient, response())
    void pending.catch(() => undefined)

    expect(promoteInboxReadReservation(lease, 11)).toBe(true)
    await settleInboxReadReservationGeneration(queryClient, 10, true, "focused")
    expect((queryClient.cancelQueries as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()

    await settleInboxReadReservationGeneration(queryClient, 11, true, "focused")
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(queryClient.cancelQueries).toHaveBeenCalledTimes(1)
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
  })

  it("keeps a focused WS candidate classified when the response arrives later", async () => {
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(queryClient, "focused", seen)

    expect(armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })).toBe(true)
    expect(promoteInboxReadReservation(lease, 12)).toBe(true)
    seen.mockClear()
    const pending = reserveInboxUnreadsResponse(queryClient, response())
    void pending.catch(() => undefined)

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    }))
    await settleInboxReadReservationGeneration(queryClient, 12, true, "focused")
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("discards an exact response that arrives after its committed generation", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    promoteInboxReadReservation(lease, 13)

    await settleInboxReadReservationGeneration(queryClient, 13, true, "focused")

    await expect(reserveInboxUnreadsResponse(queryClient, response())).rejects.toMatchObject({
      name: "AbortError",
    })
    const later = reserveInboxUnreadsResponse(
      queryClient,
      response("focused", "2026-08-27T01:00:01.000Z"),
    )
    let laterSettled = false
    void later.then(() => { laterSettled = true }, () => { laterSettled = true })
    await Promise.resolve()
    expect(laterSettled).toBe(false)
    disposeInboxReadReservation(queryClient)
    await expect(later).rejects.toMatchObject({ name: "AbortError" })
  })

  it("grants a negative permit only to the exact armed identity", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    const exact = response()
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })

    expect(takeInboxReadReservationNegative(lease)).toBe(true)
    await Promise.resolve()
    await expect(reserveInboxUnreadsResponse(queryClient, exact)).resolves.toBe(exact)

    const later = response("focused", "2026-08-27T01:00:01.000Z")
    const held = reserveInboxUnreadsResponse(queryClient, later)
    void held.catch(() => undefined)
    await Promise.resolve()
    disposeInboxReadReservation(queryClient)
    await expect(held).rejects.toMatchObject({ name: "AbortError" })
  })

  it("supersedes an old permit and ignores unfocused or released arms", async () => {
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(queryClient, "focused", seen)
    expect(armInboxReadReservationCandidate(queryClient, {
      channelId: "other",
      lastMessageAt: "t-other",
    })).toBe(false)
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    takeInboxReadReservationNegative(lease)
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:01.000Z",
    })

    const stale = reserveInboxUnreadsResponse(queryClient, response())
    void stale.catch(() => undefined)
    await Promise.resolve()
    releaseInboxReadReservationSurface(lease)
    expect(armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:02.000Z",
    })).toBe(false)
    await expect(stale).rejects.toMatchObject({ name: "AbortError" })
  })

  it("cancels a held armed identity when a newer focused candidate supersedes it", async () => {
    registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    const stale = reserveInboxUnreadsResponse(queryClient, response())
    void stale.catch(() => undefined)

    expect(armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:01.000Z",
    })).toBe(true)

    await expect(stale).rejects.toMatchObject({ name: "AbortError" })
    disposeInboxReadReservation(queryClient)
  })

  it("discards a late superseded response without rebinding the newer focused generation", async () => {
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(queryClient, "focused", seen)
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    promoteInboxReadReservation(lease, 18)
    await settleInboxReadReservationGeneration(queryClient, 18, true, "focused")

    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:01.000Z",
    })
    seen.mockClear()

    await expect(reserveInboxUnreadsResponse(queryClient, response())).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(seen).not.toHaveBeenCalled()

    const current = reserveInboxUnreadsResponse(
      queryClient,
      response("focused", "2026-08-27T01:00:01.000Z"),
    )
    void current.catch(() => undefined)
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:01.000Z",
    }))
    expect(promoteInboxReadReservation(lease, 19)).toBe(true)

    await settleInboxReadReservationGeneration(queryClient, 18, true, "focused")
    let settled = false
    void current.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await settleInboxReadReservationGeneration(queryClient, 19, true, "focused")
    await expect(current).rejects.toMatchObject({ name: "AbortError" })
  })

  it("adopts a newer response as the active identity without inheriting the older generation", async () => {
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(queryClient, "focused", seen)
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:01.000Z",
    })
    const previous = reserveInboxUnreadsResponse(
      queryClient,
      response("focused", "2026-08-27T01:00:01.000Z"),
    )
    void previous.catch(() => undefined)
    promoteInboxReadReservation(lease, 20)
    seen.mockClear()

    const current = reserveInboxUnreadsResponse(
      queryClient,
      response("focused", "2026-08-27T01:00:02.000Z"),
    )
    void current.catch(() => undefined)

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:02.000Z",
    }))
    await expect(previous).rejects.toMatchObject({ name: "AbortError" })

    await settleInboxReadReservationGeneration(queryClient, 20, true, "focused")
    let settled = false
    void current.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    expect(promoteInboxReadReservation(lease, 21)).toBe(true)
    await settleInboxReadReservationGeneration(queryClient, 21, true, "focused")
    await expect(current).rejects.toMatchObject({ name: "AbortError" })
  })

  it("keeps an enriched thread response through a sparse replay of the same WS identity", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "child",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    const pending = reserveInboxUnreadsResponse(queryClient, openerResponse())
    void pending.catch(() => undefined)
    expect(promoteInboxReadReservation(lease, 22)).toBe(true)

    expect(armInboxReadReservationCandidate(queryClient, {
      channelId: "child",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })).toBe(false)

    await settleInboxReadReservationGeneration(queryClient, 22, true, "child")
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("supersedes an enriched thread identity when opener metadata conflicts", async () => {
    registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "child",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    const pending = reserveInboxUnreadsResponse(queryClient, openerResponse())
    void pending.catch(() => undefined)

    expect(armInboxReadReservationCandidate(queryClient, {
      channelId: "child",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
      openerMessageId: "opener-8",
      openerSeq: 8,
    })).toBe(true)

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    disposeInboxReadReservation(queryClient)
  })

  it("lets a newer identity revoke a committed-response discard", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
      openerMessageId: "opener-old",
      openerSeq: 7,
    })
    promoteInboxReadReservation(lease, 14)
    await settleInboxReadReservationGeneration(queryClient, 14, true, "focused")

    expect(armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:01.000Z",
    })).toBe(true)
    const stale = reserveInboxUnreadsResponse(queryClient, response())
    void stale.catch(() => undefined)
    await Promise.resolve()
    disposeInboxReadReservation(queryClient)
    await expect(stale).rejects.toMatchObject({ name: "AbortError" })
  })

  it("grants an exact permit when an armed generation fails before its response", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    promoteInboxReadReservation(lease, 15)

    await settleInboxReadReservationGeneration(queryClient, 15, false, "focused")

    const exact = response()
    await expect(reserveInboxUnreadsResponse(queryClient, exact)).resolves.toBe(exact)
    expect(queryClient.refetchQueries).toHaveBeenCalledOnce()
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
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
  })

  it("clears an armed generation after its matching held response fails", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    const pending = reserveInboxUnreadsResponse(queryClient, response())
    void pending.catch(() => undefined)
    promoteInboxReadReservation(lease, 17)

    await settleInboxReadReservationGeneration(queryClient, 17, false, "focused")

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(queryClient.refetchQueries).toHaveBeenCalledOnce()
  })

  it("consumes a handoff negative permit and clears its matching focused identity", async () => {
    registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    armInboxReadReservationCandidate(queryClient, {
      channelId: "child",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
    })
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-focused-negative",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    const data = openerResponse()
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)

    expect(terminateThreadOpenerReservationHandoff(
      queryClient,
      "nonce-focused-negative",
    )).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await expect(reserveInboxUnreadsResponse(queryClient, data)).resolves.toBe(data)
  })

  it("publishes only one matching authoritative response after a negative decision", async () => {
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    const data = response()
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)

    expect(takeInboxReadReservationNegative(lease)).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1)
    await expect(reserveInboxUnreadsResponse(queryClient, data)).resolves.toBe(data)

    const heldAgain = reserveInboxUnreadsResponse(queryClient, data)
    let settled = false
    void heldAgain.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    disposeInboxReadReservation(queryClient)
  })

  it("publishes the next focused response when failure settles before the payload arrives", async () => {
    registerInboxReadReservationSurface(queryClient, "focused", vi.fn())

    await settleInboxReadReservationGeneration(queryClient, 17, false, "focused")
    expect(queryClient.cancelQueries).toHaveBeenCalledOnce()
    expect(queryClient.refetchQueries).toHaveBeenCalledOnce()

    const data = response()
    await expect(reserveInboxUnreadsResponse(queryClient, data)).resolves.toBe(data)
    const heldAgain = reserveInboxUnreadsResponse(queryClient, data)
    let settled = false
    void heldAgain.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    disposeInboxReadReservation(queryClient)
  })

  it("reclassifies a held account payload under a same-commit route replacement", async () => {
    const oldSeen = vi.fn()
    const nextSeen = vi.fn()
    const oldLease = registerInboxReadReservationSurface(queryClient, "old", oldSeen)
    const data = {
      servers: [{ channels: [
        { channelId: "old", lastMessageAt: "t-old", hasDirectUnread: true, children: [] },
        { channelId: "next", lastMessageAt: "t-next", hasDirectUnread: true, children: [] },
      ] }],
      dms: [],
    }
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)
    releaseInboxReadReservationSurface(oldLease)
    registerInboxReadReservationSurface(queryClient, "next", nextSeen)
    await Promise.resolve()

    expect(nextSeen).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "next",
      lastMessageAt: "t-next",
    }))
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
    disposeInboxReadReservation(queryClient)
  })

  it("negatively releases a held payload when its replacement surface has no candidate", async () => {
    const oldLease = registerInboxReadReservationSurface(queryClient, "old", vi.fn())
    const pending = reserveInboxUnreadsResponse(queryClient, response("old", "t-old"))
    void pending.catch(() => undefined)

    releaseInboxReadReservationSurface(oldLease)
    registerInboxReadReservationSurface(queryClient, "missing", vi.fn())
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()

    expect(queryClient.refetchQueries).toHaveBeenCalledOnce()
  })

  it("reclassifies old-to-target under an exact route lease before awaiting the claim", async () => {
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-reclassify",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    const oldLease = registerInboxReadReservationSurface(queryClient, "old", vi.fn())
    const data = {
      servers: [{ channels: [
        { channelId: "old", lastMessageAt: "t-old", hasDirectUnread: true, children: [] },
        ...openerResponse().servers[0]!.channels,
        { channelId: "unrelated", lastMessageAt: "t-new", hasDirectUnread: true, children: [] },
      ] }],
      dms: [],
    }
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)
    registerThreadOpenerRouteLease(queryClient, "nonce-reclassify", "server", "child")

    releaseInboxReadReservationSurface(oldLease)
    const childLease = registerInboxReadReservationSurface(queryClient, "child", vi.fn())

    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-reclassify")?.phase)
      .toBe("awaiting-opener-claim")
    expect(takeInboxReadReservationNegative(childLease)).toBe(false)
    expect(completeThreadOpenerReservationHandoff(
      queryClient,
      "nonce-reclassify",
      41,
    )).toBe(true)
    await settleInboxReadReservationGeneration(queryClient, 41, true, "forum")
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
  })

  it("blocks child negative release until an exact opener claim transfers ownership", async () => {
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-1",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    const lease = registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    const pending = reserveInboxUnreadsResponse(queryClient, openerResponse())
    void pending.catch(() => undefined)

    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-1")?.phase)
      .toBe("armed")
    registerThreadOpenerRouteLease(queryClient, "nonce-1", "server", "child")
    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-1")?.phase)
      .toBe("awaiting-opener-claim")
    expect(takeInboxReadReservationNegative(lease)).toBe(false)
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
    expect(completeThreadOpenerReservationHandoff(queryClient, "nonce-1", 23)).toBe(true)
    expect(promoteInboxReadReservation(lease, 24)).toBe(true)

    await settleInboxReadReservationGeneration(queryClient, 23, true, "forum")
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
  })

  it("awaits a claim when the exact route lease exists before the response", async () => {
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-lease-first",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    const lease = registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    registerThreadOpenerRouteLease(queryClient, "nonce-lease-first", "server", "child")
    const pending = reserveInboxUnreadsResponse(queryClient, openerResponse())
    void pending.catch(() => undefined)

    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-lease-first")?.phase)
      .toBe("awaiting-opener-claim")
    expect(takeInboxReadReservationNegative(lease)).toBe(false)
    disposeInboxReadReservation(queryClient)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("removes an aborted held response exactly once", async () => {
    registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    const controller = new AbortController()
    const pending = reserveInboxUnreadsResponse(queryClient, response(), controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    disposeInboxReadReservation(queryClient)
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
  })

  it("clears as a no-op when no handoff is active", () => {
    expect(clearThreadOpenerReservationHandoff(queryClient)).toBe(false)
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
  })

  it("does not let an orphaned nonce gate a later direct visit to the same child", async () => {
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-orphan",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    const lease = registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    const data = openerResponse()
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)

    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-orphan")?.phase)
      .toBe("armed")
    expect(takeInboxReadReservationNegative(lease)).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()
    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-orphan")).toBeNull()
    expect(queryClient.refetchQueries).toHaveBeenCalledOnce()
    await expect(reserveInboxUnreadsResponse(queryClient, data)).resolves.toBe(data)
  })

  it("binds a matching response that arrives after the opener claim to the parent generation", async () => {
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-after-claim",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    const lease = registerInboxReadReservationSurface(queryClient, "child", vi.fn())

    expect(completeThreadOpenerReservationHandoff(
      queryClient,
      "nonce-after-claim",
      23,
    )).toBe(true)
    const pending = reserveInboxUnreadsResponse(queryClient, openerResponse())
    void pending.catch(() => undefined)

    expect(takeInboxReadReservationNegative(lease)).toBe(true)
    expect(promoteInboxReadReservation(lease, 24)).toBe(true)
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()

    await settleInboxReadReservationGeneration(queryClient, 23, true, "forum")
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()
  })

  it("terminates a matching unclaimed handoff through one authoritative refetch", async () => {
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-2",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    const pending = reserveInboxUnreadsResponse(queryClient, openerResponse())
    void pending.catch(() => undefined)

    expect(terminateThreadOpenerReservationHandoff(queryClient, "nonce-2")).toBe(true)
    expect(terminateThreadOpenerReservationHandoff(queryClient, "nonce-2")).toBe(false)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1)
  })

  it("releases a claimed opener when its navigation-owned generation is cancelled", async () => {
    armThreadOpenerReservationHandoff(queryClient, {
      nonce: "nonce-3",
      serverId: "server",
      parentChannelId: "forum",
      childChannelId: "child",
      openerMessageId: "opener-7",
      openerSeq: 7,
    })
    registerInboxReadReservationSurface(queryClient, "child", vi.fn())
    const pending = reserveInboxUnreadsResponse(queryClient, openerResponse())
    void pending.catch(() => undefined)
    completeThreadOpenerReservationHandoff(queryClient, "nonce-3", 31)

    await settleInboxReadReservationGeneration(queryClient, 31, false, "forum")
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(queryClient.refetchQueries).toHaveBeenCalledOnce()
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
    expect(queryClient.refetchQueries).not.toHaveBeenCalled()

    releaseThreadOpenerRouteLease(replacement)
    await Promise.resolve()
    await Promise.resolve()
    expect(getThreadOpenerReservationHandoff(queryClient, "nonce-route")).toBeNull()
    expect(queryClient.refetchQueries).toHaveBeenCalledOnce()
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
    const cache = { current: data as typeof data | { servers: []; dms: [] } }
    queryClient = {
      ...client(),
      getQueryData: vi.fn(() => cache.current),
    } as unknown as QueryClient
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
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)
    promoteInboxReadReservation(lease, 41)

    publishInboxProjectionGenerationTerminal(queryClient, 99, "success")
    expect(receipt).not.toHaveBeenCalled()
    activateInboxProjectionTicket(ticket)
    expect(receipt).not.toHaveBeenCalled()

    await settleInboxReadReservationGeneration(queryClient, 41, true, "focused")
    cache.current = { servers: [], dms: [] }
    publishInboxProjectionGenerationTerminal(queryClient, 41, "success")
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      epoch: 4,
      terminal: "success",
      disposition: "retire",
      observedFingerprint: null,
    }))
  })

  it("freezes exact retention as rollback after an owned negative refetch", async () => {
    const data = response()
    queryClient = {
      ...client(),
      getQueryData: vi.fn(() => data),
    } as unknown as QueryClient
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
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)
    promoteInboxReadReservation(lease, 51)

    await settleInboxReadReservationGeneration(queryClient, 51, false, "focused")
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "negative",
      disposition: "rollback",
      observedFingerprint: target.fingerprint,
    }))
  })

  it("forces Mention-negative and deferred terminals to rollback without cache authority", async () => {
    queryClient = {
      ...client(),
      getQueryData: vi.fn(() => undefined),
    } as unknown as QueryClient
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
    const pending = reserveInboxUnreadsResponse(queryClient, response())
    void pending.catch(() => undefined)
    promoteInboxReadReservation(lease, 61)
    await settleInboxReadReservationGeneration(queryClient, 61, false, "focused")
    expect(negativeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "rollback",
      observedFingerprint: null,
    }))

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
    expect(deferredReceipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "deferred",
      disposition: "rollback",
    }))
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
    const cache = { current: data as typeof data | { servers: []; dms: [] } }
    queryClient = {
      ...client(),
      getQueryData: vi.fn(() => cache.current),
    } as unknown as QueryClient
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
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)
    completeThreadOpenerReservationHandoff(queryClient, "projection-thread", 81)
    await settleInboxReadReservationGeneration(queryClient, 81, true, "forum")
    cache.current = { servers: [], dms: [] }
    publishInboxProjectionGenerationTerminal(queryClient, 81, "success")

    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "success",
      disposition: "retire",
    }))
  })

  it("attaches an activated same-href ticket to a just-settled exact generation", async () => {
    const data = response()
    queryClient = {
      ...client(),
      getQueryData: vi.fn(() => ({ servers: [], dms: [] })),
    } as unknown as QueryClient
    const lease = registerInboxReadReservationSurface(queryClient, "focused", vi.fn())
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)
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
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "success",
      disposition: "retire",
    }))
  })
})
