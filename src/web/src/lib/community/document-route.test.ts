import { describe, expect, it } from "vitest"
import { communityDocumentRoute, readCommunityDocumentRoute } from "./document-route"

describe("community document selection input", () => {
  it.each(["/c/me/bots", "/c/me/machines", "/c/me/dm", "/c/channels/server", "/c/channels/server/channel"])("selects only the current %s route", path => {
    expect(communityDocumentRoute(new URL(path, "https://alook.test"))).toBe(path)
    expect(readCommunityDocumentRoute(path)).toBe(path)
  })
  it("keeps only bounded message/tag selection and drops unrelated search input", () => {
    expect(communityDocumentRoute(new URL("https://alook.test/c/channels/server/channel?msg=message&tag=中文&settings=private&threadView=full")))
      .toBe("/c/channels/server/channel?msg=message&tag=%E4%B8%AD%E6%96%87")
  })
  it.each(["/c", "/c/me", "/c/me/friends", "/c/invite/token", "/sign-in", "https://elsewhere.test/c/me/bots", "/c/me/bots?settings=private", "/c/me/bots?msg=bad/slash"])("rejects an unsupported or unnormalized header %s", value => {
    expect(readCommunityDocumentRoute(value)).toBeNull()
  })
  it.each([null, "", "/c/me/with space", "/c/me/%", "/c/me/\u0000", "/c/me/\ud800", "/c/../../sign-in", "/c/me/bots?tag=" + "x".repeat(101), "/c/me/" + "x".repeat(2048)])("rejects a noncanonical bounded header without replacing native URL: %j", value => {
    expect(readCommunityDocumentRoute(value)).toBeNull()
  })

})
