import { describe, it, expect } from "vitest"
import { initialMobileZone, nextMobileZone } from "./mobile-zone"
import type { MobileZone } from "./_types"

describe("initialMobileZone", () => {
  it("returns 'nav' when no channel is in the URL", () => {
    expect(initialMobileZone(false)).toBe("nav")
  })

  it("returns 'messages' when a channel is in the URL (deep link)", () => {
    expect(initialMobileZone(true)).toBe("messages")
  })
})

describe("nextMobileZone", () => {
  const zones: MobileZone[] = ["nav", "messages"]

  it("setActiveChannel → 'messages'", () => {
    for (const z of zones) expect(nextMobileZone(z, { type: "setActiveChannel" })).toBe("messages")
  })

  it("enterDm → 'messages'", () => {
    for (const z of zones) expect(nextMobileZone(z, { type: "enterDm" })).toBe("messages")
  })

  it("onShowFriends → 'messages'", () => {
    for (const z of zones) expect(nextMobileZone(z, { type: "onShowFriends" })).toBe("messages")
  })

  it("onShowMachines → 'messages'", () => {
    for (const z of zones) expect(nextMobileZone(z, { type: "onShowMachines" })).toBe("messages")
  })

  it("goBackMobile from 'messages' → 'nav'", () => {
    expect(nextMobileZone("messages", { type: "goBackMobile" })).toBe("nav")
  })

  it("goHome from any zone → 'nav'", () => {
    for (const z of zones) expect(nextMobileZone(z, { type: "goHome" })).toBe("nav")
  })

  it("goServer from any zone → 'nav'", () => {
    for (const z of zones) expect(nextMobileZone(z, { type: "goServer" })).toBe("nav")
  })
})
