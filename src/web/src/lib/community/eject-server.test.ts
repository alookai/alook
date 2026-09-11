import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  beginOwnerServerDelete,
  cancelOwnerServerDelete,
  claimOwnerServerDeleteNavigation,
  claimOwnerServerDeleteScopeFlush,
  commitOwnerServerDelete,
  completeOwnerServerDeleteScopeFlush,
  consumeVoluntaryLeave,
  createOwnerServerDeleteRouteToken,
  isDefinitiveChildMetaFailure,
  isOwnerServerDeleteCompleted,
  isOwnerServerDeleteRouteProtected,
  isOwnerServerDeleteScopeEvictionBlocked,
  markVoluntaryLeave,
  observeOwnerServerDeleteRouteCommit,
  pickPostEjectDestination,
  registerOwnerServerDeleteRoute,
  runAuthoritativeServerEject,
} from "./eject-server"
import type { Server } from "./models/navigation"
import { ApiError } from "@/lib/errors"
import {
  clearCommunityColdEntryAttempts,
  commitLastCommunityRoute,
  resolveCommunityColdEntryDestination,
} from "./last-community-route"

function makeServer(id: string): Server {
  return {
    id,
    name: id,
    initial: id.slice(0, 1).toUpperCase(),
    active: false,
    mentions: 0,
    isOwner: false,
    icon: null,
  }
}

function terminalize(serverId: string): void {
  expect(claimOwnerServerDeleteScopeFlush(serverId)).toBe(true)
  expect(completeOwnerServerDeleteScopeFlush(serverId)).toBe(true)
}

describe("voluntary-leave marker", () => {
  it("marked id consumes as true, then false on the second read", () => {
    markVoluntaryLeave("srv_a")
    expect(consumeVoluntaryLeave("srv_a")).toBe(true)
    expect(consumeVoluntaryLeave("srv_a")).toBe(false)
  })

  it("unrelated ids consume as false", () => {
    markVoluntaryLeave("srv_b")
    expect(consumeVoluntaryLeave("srv_other")).toBe(false)
    expect(consumeVoluntaryLeave("srv_b")).toBe(true)
  })
})

describe("owner-delete single-navigation lifecycle", () => {
  const serverId = "srv_deleted"

  beforeEach(() => {
    cancelOwnerServerDelete(serverId)
  })

  it("claims exactly one survivor navigation while the deleted route is committed", () => {
    const origin = createOwnerServerDeleteRouteToken()
    beginOwnerServerDelete(serverId, origin)

    expect(commitOwnerServerDelete(serverId, origin)).toBe(false)
    expect(claimOwnerServerDeleteNavigation(
      serverId,
      origin,
      "/c/channels/srv_next/channel_remembered",
    )).toBe(true)
    expect(claimOwnerServerDeleteNavigation(serverId, origin, "/c/me")).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(serverId, origin)).toBe(true)

    expect(observeOwnerServerDeleteRouteCommit(
      "/c/channels/srv_next/channel_remembered",
    )).toEqual([serverId])
    terminalize(serverId)
    expect(isOwnerServerDeleteCompleted(serverId)).toBe(true)
    expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(serverId, origin)).toBe(true)
    expect(isOwnerServerDeleteScopeEvictionBlocked(serverId)).toBe(true)
  })

  it("keeps duplicate begin as a participant without transferring origin ownership", () => {
    const origin = createOwnerServerDeleteRouteToken()
    const duplicate = createOwnerServerDeleteRouteToken()
    beginOwnerServerDelete(serverId, origin)
    beginOwnerServerDelete(serverId, duplicate)

    expect(commitOwnerServerDelete(serverId, duplicate)).toBe(false)
    cancelOwnerServerDelete(serverId, duplicate)
    expect(claimOwnerServerDeleteNavigation(serverId, duplicate, "/c/me")).toBe(false)

    expect(commitOwnerServerDelete(serverId, origin)).toBe(false)
    expect(claimOwnerServerDeleteNavigation(serverId, origin, "/c/me")).toBe(true)
    expect(observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([serverId])
    terminalize(serverId)

    expect(isOwnerServerDeleteRouteProtected(serverId, origin)).toBe(true)
    expect(isOwnerServerDeleteRouteProtected(serverId, duplicate)).toBe(true)
  })

  it.each([
    "/c/channels/srv_next/channel_remembered",
    "/c/me/friends",
  ])("keeps an already committed safe route and issues no navigation: %s", (safeHref) => {
    const origin = createOwnerServerDeleteRouteToken()
    beginOwnerServerDelete(serverId, origin)
    expect(observeOwnerServerDeleteRouteCommit(safeHref)).toEqual([])

    expect(commitOwnerServerDelete(serverId, origin)).toBe(true)
    expect(claimOwnerServerDeleteNavigation(
      serverId,
      origin,
      "/c/channels/srv_next/channel_remembered",
    )).toBe(false)
    terminalize(serverId)
    expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(false)
  })

  it("turns a resolver result into a no-op when a safe route commits first", () => {
    const origin = createOwnerServerDeleteRouteToken()
    beginOwnerServerDelete(serverId, origin)
    expect(commitOwnerServerDelete(serverId, origin)).toBe(false)

    expect(observeOwnerServerDeleteRouteCommit("/c/me")).toEqual([serverId])
    expect(claimOwnerServerDeleteNavigation(
      serverId,
      origin,
      "/c/channels/srv_next/channel_default",
    )).toBe(false)
    terminalize(serverId)
  })

  it("lets either the claimed target or a newer user route finish cleanup", () => {
    for (const safeHref of [
      "/c/channels/srv_next/channel_default",
      "/c/me/machines",
    ]) {
      const origin = createOwnerServerDeleteRouteToken()
      beginOwnerServerDelete(serverId, origin)
      expect(commitOwnerServerDelete(serverId, origin)).toBe(false)
      expect(claimOwnerServerDeleteNavigation(
        serverId,
        origin,
        "/c/channels/srv_next/channel_default",
      )).toBe(true)
      expect(observeOwnerServerDeleteRouteCommit(safeHref)).toEqual([serverId])
      terminalize(serverId)
      expect(isOwnerServerDeleteRouteProtected(serverId)).toBe(false)
    }
  })

  it("tombstones only route instances committed before the terminal boundary", () => {
    const origin = createOwnerServerDeleteRouteToken()
    const preTerminal = createOwnerServerDeleteRouteToken()
    const postTerminal = createOwnerServerDeleteRouteToken()
    beginOwnerServerDelete(serverId, origin)
    expect(registerOwnerServerDeleteRoute(serverId, preTerminal)).toBe("participant")
    expect(commitOwnerServerDelete(serverId, origin)).toBe(false)
    observeOwnerServerDeleteRouteCommit("/c/me")
    terminalize(serverId)

    expect(isOwnerServerDeleteRouteProtected(serverId, origin)).toBe(true)
    expect(isOwnerServerDeleteRouteProtected(serverId, preTerminal)).toBe(true)
    expect(registerOwnerServerDeleteRoute(serverId, postTerminal)).toBe("ordinary")
    expect(isOwnerServerDeleteRouteProtected(serverId, postTerminal)).toBe(false)
    expect(registerOwnerServerDeleteRoute(serverId, origin)).toBe("ordinary")
    expect(isOwnerServerDeleteRouteProtected(serverId, origin)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(serverId, preTerminal)).toBe(true)
  })

  it("classifies registration after the terminal claim as ordinary", () => {
    const origin = createOwnerServerDeleteRouteToken()
    const lateCommit = createOwnerServerDeleteRouteToken()
    beginOwnerServerDelete(serverId, origin)
    commitOwnerServerDelete(serverId, origin)
    observeOwnerServerDeleteRouteCommit("/c/me")

    expect(claimOwnerServerDeleteScopeFlush(serverId)).toBe(true)
    expect(registerOwnerServerDeleteRoute(serverId, lateCommit)).toBe("ordinary")
    expect(completeOwnerServerDeleteScopeFlush(serverId)).toBe(true)
    expect(isOwnerServerDeleteRouteProtected(serverId, lateCommit)).toBe(false)
  })

  it("cancels a failed request without navigation, flush, or tombstone", () => {
    const origin = createOwnerServerDeleteRouteToken()
    beginOwnerServerDelete(serverId, origin)
    cancelOwnerServerDelete(serverId, origin)

    expect(claimOwnerServerDeleteNavigation(serverId, origin, "/c/me")).toBe(false)
    expect(claimOwnerServerDeleteScopeFlush(serverId)).toBe(false)
    expect(isOwnerServerDeleteRouteProtected(serverId, origin)).toBe(false)
    expect(isOwnerServerDeleteScopeEvictionBlocked(serverId)).toBe(false)
  })
})

describe("runAuthoritativeServerEject", () => {
  const target = makeServer("srv_target")
  const callbacks = () => ({
    consumeVoluntaryLeave: vi.fn(() => false),
    clearLastChannel: vi.fn(),
    toast: vi.fn(),
    replace: vi.fn(),
  })

  beforeEach(() => {
    cancelOwnerServerDelete(target.id)
  })

  it("keeps the URL through failures, refetches, and snapshots containing the target", () => {
    const sideEffects = callbacks()
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [], isSuccess: false, isFetching: false, ...sideEffects,
    })).toBe(false)
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [target], isSuccess: false, isFetching: false, ...sideEffects,
    })).toBe(false)
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [], isSuccess: true, isFetching: true, ...sideEffects,
    })).toBe(false)
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [target], isSuccess: true, isFetching: false, ...sideEffects,
    })).toBe(false)
    expect(sideEffects.replace).not.toHaveBeenCalled()
  })

  it("does not consume optimistic absence while owner delete protects the route", () => {
    const sideEffects = callbacks()
    expect(runAuthoritativeServerEject({
      serverId: target.id,
      servers: [],
      isSuccess: true,
      isFetching: false,
      ownerDeleteRouteProtected: true,
      ...sideEffects,
    })).toBe(false)
    expect(sideEffects.replace).not.toHaveBeenCalled()
    expect(sideEffects.toast).not.toHaveBeenCalled()
    expect(sideEffects.clearLastChannel).not.toHaveBeenCalled()
  })

  it("ejects, clears memory, and toasts only on settled authoritative absence", () => {
    const sideEffects = callbacks()
    expect(runAuthoritativeServerEject({
      serverId: target.id,
      servers: [makeServer("srv_remaining")],
      isSuccess: true,
      isFetching: false,
      ...sideEffects,
    })).toBe(true)
    expect(sideEffects.clearLastChannel).toHaveBeenCalledWith(target.id)
    expect(sideEffects.toast).toHaveBeenCalledWith("You're no longer in this server")
    expect(sideEffects.replace).toHaveBeenCalledWith("/c/channels/srv_remaining")
  })

  it("keeps voluntary leave silent", () => {
    const sideEffects = callbacks()
    sideEffects.consumeVoluntaryLeave.mockReturnValue(true)
    expect(runAuthoritativeServerEject({
      serverId: target.id,
      servers: [],
      isSuccess: true,
      isFetching: false,
      ...sideEffects,
    })).toBe(true)
    expect(sideEffects.replace).toHaveBeenCalledWith("/c/me")
    expect(sideEffects.toast).not.toHaveBeenCalled()
  })

  it("clears a matching cold-entry route and falls back once to Machines", () => {
    const storage: Record<string, string> = {}
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { storage[key] = value }),
      removeItem: vi.fn((key: string) => { delete storage[key] }),
    })
    clearCommunityColdEntryAttempts()
    commitLastCommunityRoute("viewer-1", "/c/channels/srv_target/channel-1")
    resolveCommunityColdEntryDestination({
      accountId: "viewer-1",
      pathname: "/c",
      search: "",
      hash: "",
    })
    const sideEffects = callbacks()

    expect(runAuthoritativeServerEject({
      serverId: target.id,
      servers: [],
      isSuccess: true,
      isFetching: false,
      accountId: "viewer-1",
      routeHref: "/c/channels/srv_target/channel-1",
      ...sideEffects,
    })).toBe(true)
    expect(sideEffects.replace).toHaveBeenCalledWith("/c/me/machines")
    vi.unstubAllGlobals()
  })
})

describe("isDefinitiveChildMetaFailure", () => {
  it("keeps 403/404 definitive without treating 5xx as absence", () => {
    expect(isDefinitiveChildMetaFailure(new ApiError("forbidden", 403))).toBe(true)
    expect(isDefinitiveChildMetaFailure(new ApiError("missing", 404))).toBe(true)
    expect(isDefinitiveChildMetaFailure(new ApiError("transient", 500))).toBe(false)
    expect(isDefinitiveChildMetaFailure(new Error("network"))).toBe(false)
  })
})

describe("pickPostEjectDestination", () => {
  it("uses the first surviving Server in API rail order", () => {
    const servers = [
      makeServer("srv_first"),
      makeServer("srv_ejected"),
      makeServer("srv_third"),
    ]
    expect(pickPostEjectDestination(servers, "srv_ejected")).toBe(
      "/c/channels/srv_first",
    )
  })

  it("uses the surviving Server's remembered/default Channel resolver", () => {
    const destination = vi.fn(() => "/c/channels/srv_next/channel_default")
    expect(pickPostEjectDestination(
      [makeServer("srv_ejected"), makeServer("srv_next")],
      "srv_ejected",
      destination,
    )).toBe("/c/channels/srv_next/channel_default")
    expect(destination).toHaveBeenCalledExactlyOnceWith("srv_next")
  })

  it("returns /c/me when no Server survives", () => {
    expect(pickPostEjectDestination([makeServer("srv_only")], "srv_only")).toBe("/c/me")
    expect(pickPostEjectDestination([], "srv_anything")).toBe("/c/me")
  })
})
