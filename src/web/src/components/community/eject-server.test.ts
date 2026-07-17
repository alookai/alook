import { describe, it, expect } from "vitest"
import {
  markVoluntaryLeave,
  consumeVoluntaryLeave,
  pickPostEjectDestination,
} from "./eject-server"
import type { Server } from "./_types"

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
