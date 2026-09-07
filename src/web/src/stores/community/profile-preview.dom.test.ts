import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { render } from "@/test/react-dom-harness"
import type { CommunityProfile } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "./profile-preview"
import {
  useCommunityProfile,
  useCommunityWsStore,
  useProfilesByUserId,
} from "./ws"

function ProfileProbe({ userId }: { userId: string }) {
  const profile = useCommunityProfile(userId)
  const profiles = useProfilesByUserId()
  return createElement("output", {
    "data-profile-name": profile?.name,
    "data-map-name": profiles.get(userId)?.name,
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

afterEach(() => {
  useCommunityWsStore.getState().reset()
})

describe("CommunityPreviewProfileOwner", () => {
  it("owns profile reads inside its subtree without mutating the live store", () => {
    const liveProfile = { id: "shared", name: "Live name" }
    const liveProfiles = new Map([[liveProfile.id, liveProfile]])
    useCommunityWsStore.setState({ profilesByUserId: liveProfiles })
    const previewProfiles = new Map([["shared", { id: "shared", name: "Preview name" }]])

    const owned = renderProbe("shared", previewProfiles)

    expect(owned).toHaveAttribute("data-profile-name", "Preview name")
    expect(owned).toHaveAttribute("data-map-name", "Preview name")
    expect(useCommunityWsStore.getState().profilesByUserId).toBe(liveProfiles)
    expect(useCommunityWsStore.getState().profilesByUserId.get("shared")?.name).toBe("Live name")
  })

  it("does not leak live identities into an incomplete preview owner", () => {
    useCommunityWsStore.setState({
      profilesByUserId: new Map([["live-only", { id: "live-only", name: "Live only" }]]),
    })

    const owned = renderProbe("live-only", new Map())
    const live = renderProbe("live-only")

    expect(owned).not.toHaveAttribute("data-profile-name")
    expect(owned).not.toHaveAttribute("data-map-name")
    expect(live).toHaveAttribute("data-profile-name", "Live only")
    expect(live).toHaveAttribute("data-map-name", "Live only")
  })
})
