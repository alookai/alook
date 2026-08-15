import { describe, it, expect, vi } from "vitest"
import {
  markVoluntaryLeave,
  consumeVoluntaryLeave,
  pickPostEjectDestination,
  runAuthoritativeServerEject,
  isDefinitiveChildMetaFailure,
} from "./eject-server"
import type { Server } from "./models/navigation"
import { ApiError } from "@/lib/errors"

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

describe("voluntary-leave marker", () => {
  it("marked id consumes as true, then false on the second read", () => {
    markVoluntaryLeave("srv_a")
    expect(consumeVoluntaryLeave("srv_a")).toBe(true)
    expect(consumeVoluntaryLeave("srv_a")).toBe(false)
  })

  it("unrelated ids consume as false", () => {
    markVoluntaryLeave("srv_b")
    expect(consumeVoluntaryLeave("srv_other")).toBe(false)
    // srv_b still marked — clean it up to keep test isolation
    expect(consumeVoluntaryLeave("srv_b")).toBe(true)
  })
})

describe("runAuthoritativeServerEject", () => {
  const target = { id: "srv_target" } as Server
  const callbacks = () => ({
    consumeVoluntaryLeave: vi.fn(() => false),
    clearLastChannel: vi.fn(),
    toast: vi.fn(),
    replace: vi.fn(),
  })

  it("keeps the URL and last-channel through first 500, then accepts a success containing the target", () => {
    const sideEffects = callbacks()
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [], isSuccess: false, isFetching: false, ...sideEffects,
    })).toBe(false)
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [target], isSuccess: true, isFetching: false, ...sideEffects,
    })).toBe(false)
    expect(sideEffects.replace).not.toHaveBeenCalled()
    expect(sideEffects.toast).not.toHaveBeenCalled()
    expect(sideEffects.clearLastChannel).not.toHaveBeenCalled()
  })

  it("does not eject from last-good data when a refetch errors", () => {
    const sideEffects = callbacks()
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [target], isSuccess: false, isFetching: false, ...sideEffects,
    })).toBe(false)
    expect(sideEffects.replace).not.toHaveBeenCalled()
    expect(sideEffects.toast).not.toHaveBeenCalled()
    expect(sideEffects.clearLastChannel).not.toHaveBeenCalled()
  })

  it("does not decide absence while a successful snapshot is still fetching", () => {
    const sideEffects = callbacks()
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [], isSuccess: true, isFetching: true, ...sideEffects,
    })).toBe(false)
    expect(sideEffects.replace).not.toHaveBeenCalled()
  })

  it("ejects, clears memory, and toasts only when settled success explicitly lacks the target", () => {
    const sideEffects = callbacks()
    const remaining = { id: "srv_remaining" } as Server
    expect(runAuthoritativeServerEject({
      serverId: target.id, servers: [remaining], isSuccess: true, isFetching: false, ...sideEffects,
    })).toBe(true)
    expect(sideEffects.clearLastChannel).toHaveBeenCalledWith(target.id)
    expect(sideEffects.toast).toHaveBeenCalledWith("You're no longer in this server")
    expect(sideEffects.replace).toHaveBeenCalledWith("/c/channels/srv_remaining")
  })
})

describe("isDefinitiveChildMetaFailure", () => {
  it("keeps the existing 403/404 bounce boundary without treating 5xx as absence", () => {
    expect(isDefinitiveChildMetaFailure(new ApiError("forbidden", 403))).toBe(true)
    expect(isDefinitiveChildMetaFailure(new ApiError("missing", 404))).toBe(true)
    expect(isDefinitiveChildMetaFailure(new ApiError("transient", 500))).toBe(false)
    expect(isDefinitiveChildMetaFailure(new Error("network"))).toBe(false)
  })
})

describe("pickPostEjectDestination", () => {
  it("returns the first other server when one remains", () => {
    const servers = [makeServer("srv_ejected"), makeServer("srv_next"), makeServer("srv_third")]
    expect(pickPostEjectDestination(servers, "srv_ejected")).toBe(
      "/c/channels/srv_next",
    )
  })

  it("uses array order (railOrder is applied by the API before this call)", () => {
    // Simulate a rail with the ejected server in the middle — the picker
    // must still land on the first non-ejected id from left to right.
    const servers = [makeServer("srv_first"), makeServer("srv_ejected"), makeServer("srv_third")]
    expect(pickPostEjectDestination(servers, "srv_ejected")).toBe(
      "/c/channels/srv_first",
    )
  })

  it("returns /c/me when the ejected server was the only one", () => {
    const servers = [makeServer("srv_only")]
    expect(pickPostEjectDestination(servers, "srv_only")).toBe("/c/me")
  })

  it("returns /c/me when the list is empty", () => {
    expect(pickPostEjectDestination([], "srv_anything")).toBe("/c/me")
  })
})
