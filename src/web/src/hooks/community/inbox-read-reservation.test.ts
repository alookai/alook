import type { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  armThreadOpenerReservationHandoff,
  completeThreadOpenerReservationHandoff,
  disposeInboxReadReservation,
  getThreadOpenerReservationHandoff,
  promoteInboxReadReservation,
  registerThreadOpenerRouteLease,
  registerInboxReadReservationSurface,
  releaseThreadOpenerRouteLease,
  releaseInboxReadReservationSurface,
  reserveInboxUnreadsResponse,
  settleInboxReadReservationGeneration,
  takeInboxReadReservationNegative,
  terminateThreadOpenerReservationHandoff,
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

  it("passes unrelated responses through and holds a focused response unchanged", async () => {
    const seen = vi.fn()
    registerInboxReadReservationSurface(queryClient, "focused", seen)
    const unrelated = response("other")
    await expect(reserveInboxUnreadsResponse(queryClient, unrelated)).resolves.toBe(unrelated)

    const focused = response()
    const pending = reserveInboxUnreadsResponse(queryClient, focused)
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "focused",
      lastMessageAt: "2026-08-27T01:00:00.000Z",
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
})
