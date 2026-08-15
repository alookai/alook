import { describe, expect, it } from "vitest"
import {
  removeCommunityParam,
  resolveMobileZone,
  withMobileZone,
  type MobileZone,
} from "./mobile-zone"

describe("resolveMobileZone", () => {
  it.each([
    ["", "messages"],
    ["pane=nav", "nav"],
    ["pane=messages", "messages"],
    ["pane=content", "messages"],
    ["pane=", "messages"],
    ["pane=NAV", "messages"],
    ["seq=12&pane=nav", "nav"],
  ] satisfies Array<[string, MobileZone]>)(
    "maps %j to %s",
    (query, expected) => {
      expect(resolveMobileZone(new URLSearchParams(query))).toBe(expected)
    },
  )
})

describe("withMobileZone", () => {
  it.each([
    ["/c/me/dm-1", "nav", "/c/me/dm-1?pane=nav"],
    ["/c/me/dm-1?seq=12#message", "nav", "/c/me/dm-1?seq=12&pane=nav#message"],
    ["/c/me/dm-1?pane=messages&seq=12", "nav", "/c/me/dm-1?pane=nav&seq=12"],
    ["/c/me/dm-1?pane=nav&seq=12#message", "messages", "/c/me/dm-1?seq=12#message"],
    ["/c/me/dm-1?seq=12#message", "messages", "/c/me/dm-1?seq=12#message"],
    ["/c/me/dm-1?pane=nav#message", "messages", "/c/me/dm-1#message"],
    ["?invite=1#dialog", "nav", "?invite=1&pane=nav#dialog"],
    ["#message", "nav", "?pane=nav#message"],
  ] satisfies Array<[string, MobileZone, string]>)(
    "updates %j to the %s zone without dropping other URL state",
    (href, zone, expected) => {
      expect(withMobileZone(href, zone)).toBe(expected)
    },
  )
})

describe("removeCommunityParam", () => {
  it.each([
    ["/c/channels/s-1/c-1?msg=m-1&pane=nav#message", "msg", "/c/channels/s-1/c-1?pane=nav#message"],
    ["/c/me/machines?pane=nav&reconnect=machine-1&invite=1", "reconnect", "/c/me/machines?pane=nav&invite=1"],
    ["/c/me/dm-1?seq=12&seq=13&pane=nav", "seq", "/c/me/dm-1?pane=nav"],
    ["/c/me/dm-1?pane=nav#message", "missing", "/c/me/dm-1?pane=nav#message"],
    ["/c/me/dm-1?msg=m-1#message", "msg", "/c/me/dm-1#message"],
    ["/c/me/dm-1#message", "msg", "/c/me/dm-1#message"],
  ])(
    "removes only %j from %j",
    (href, key, expected) => {
      expect(removeCommunityParam(href, key)).toBe(expected)
    },
  )
})
