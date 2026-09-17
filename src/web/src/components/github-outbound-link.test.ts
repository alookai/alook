import { describe, expect, it } from "vitest"
import {
  ALOOK_GITHUB_REPO_URL,
  shouldTrackGithubOutboundClick,
} from "./github-outbound-link"

describe("GitHub outbound click contract", () => {
  it("accepts a trusted click on the exact repository URL", () => {
    expect(shouldTrackGithubOutboundClick(true, ALOOK_GITHUB_REPO_URL)).toBe(true)
  })

  it.each([
    [false, ALOOK_GITHUB_REPO_URL],
    [true, `${ALOOK_GITHUB_REPO_URL}/`],
    [true, `${ALOOK_GITHUB_REPO_URL}/issues`],
    [true, null],
  ])("rejects untrusted or non-exact navigation", (isTrusted, href) => {
    expect(shouldTrackGithubOutboundClick(isTrusted, href)).toBe(false)
  })
})
