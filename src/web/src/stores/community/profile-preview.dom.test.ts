import { createElement } from "react"
import { describe, expect, it } from "vitest"
import { render } from "@/test/react-dom-harness"
import type { CommunityProfile } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "./profile-preview"
import { useCommunityPreviewProfiles } from "./profile-preview"

function ProfileProbe({ userId }: { userId: string }) {
  const profiles = useCommunityPreviewProfiles()
  const profile = profiles?.get(userId)
  return createElement("output", {
    "data-profile-name": profile?.name,
    "data-map-name": profiles?.get(userId)?.name,
  })
}

function renderProbe(userId: string, previewProfiles?: ReadonlyMap<string, CommunityProfile>) {
  const probe = createElement(ProfileProbe, { userId })
  const rendered = render(
    previewProfiles
      ? createElement(CommunityPreviewProfileOwner, { profiles: previewProfiles }, probe)
      : probe,
  )
  return rendered.container.querySelector("output")!
}

describe("CommunityPreviewProfileOwner", () => {
  it("owns profile reads inside its subtree", () => {
    const previewProfiles = new Map([["shared", { id: "shared", name: "Preview name" }]])

    const owned = renderProbe("shared", previewProfiles)

    expect(owned).toHaveAttribute("data-profile-name", "Preview name")
    expect(owned).toHaveAttribute("data-map-name", "Preview name")
  })

  it("does not leak profiles outside the preview owner", () => {
    const owned = renderProbe("live-only", new Map())
    const live = renderProbe("live-only")

    expect(owned).not.toHaveAttribute("data-profile-name")
    expect(owned).not.toHaveAttribute("data-map-name")
    expect(live).not.toHaveAttribute("data-profile-name")
    expect(live).not.toHaveAttribute("data-map-name")
  })
})
